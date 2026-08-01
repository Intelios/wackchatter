import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types/chat.ts';
import { type MatchSettings, matchKey } from './match.ts';
import { MAX_SCAN_DEPTH, ScanBuffer, scanLines } from './scan.ts';

const WHOLE: MatchSettings = { caseSensitive: false, matchWholeWords: true };

function message(partial: Partial<ChatMessage> & { mes: string }): ChatMessage {
  return {
    id: partial.mes,
    name: 'User',
    is_user: true,
    is_system: false,
    send_date: '',
    ...partial,
  };
}

/** Oldest first, as a transcript is stored. */
const transcript: ChatMessage[] = [
  message({ mes: 'once there was a castle', name: 'User' }),
  message({ mes: 'a dragon lived nearby', name: 'Seraphina', is_user: false }),
  message({ mes: 'the knight arrived', name: 'User' }),
];

describe('scanLines', () => {
  test('reverses to newest-first', () => {
    expect(scanLines(transcript)).toEqual([
      'the knight arrived',
      'a dragon lived nearby',
      'once there was a castle',
    ]);
  });

  test('prefixes names when asked', () => {
    expect(scanLines(transcript, { includeNames: true })[0]).toBe('User: the knight arrived');
  });

  test('drops hidden messages', () => {
    // is_system means hidden from the prompt. Letting one trigger lore would leak its
    // content into the context by proxy, which is the thing hiding it was meant to stop.
    const withHidden = [...transcript, message({ mes: 'a secret', is_system: true })];
    expect(scanLines(withHidden)).not.toContain('a secret');
  });

  test('drops blank messages so a placeholder does not occupy a depth slot', () => {
    const withPlaceholder = [...transcript, message({ mes: '   ', is_user: false })];
    const lines = scanLines(withPlaceholder);
    expect(lines[0]).toBe('the knight arrived');
    expect(lines).toHaveLength(3);
  });

  test('trims each message', () => {
    expect(scanLines([message({ mes: '  padded  ' })])).toEqual(['padded']);
  });
});

describe('ScanBuffer.get', () => {
  const buffer = () => ScanBuffer.fromMessages(transcript);

  test('depth slices from the newest end', () => {
    expect(buffer().get(1)).toBe('\x01the knight arrived');
    expect(buffer().get(2)).toBe('\x01the knight arrived\n\x01a dragon lived nearby');
  });

  test('starts with a sentinel and joins with one', () => {
    const text = buffer().get(3);
    expect(text.startsWith('\x01')).toBe(true);
    expect(text.split('\x01')).toHaveLength(4);
  });

  test('the head sentinel makes the first message match like every other', () => {
    const first = ScanBuffer.fromMessages([message({ mes: 'dragon at the gate' })]);
    // Without the leading \x01 this would only pass via the regex's `^` alternative,
    // which is a different code path from every other message's boundary.
    expect(matchKey(first.get(1), 'dragon', WHOLE)).toBe(true);
  });

  test('a key cannot span the seam between two messages', () => {
    const seam = ScanBuffer.fromMessages([
      message({ mes: 'ends with red' }),
      message({ mes: 'dragon starts here' }),
    ]);
    expect(matchKey(seam.get(2), 'red dragon', WHOLE)).toBe(false);
  });

  test('a keyword beyond the depth window is not visible', () => {
    expect(matchKey(buffer().get(1), 'dragon', WHOLE)).toBe(false);
    expect(matchKey(buffer().get(2), 'dragon', WHOLE)).toBe(true);
  });

  test('depth 0 yields nothing, not everything', () => {
    expect(buffer().get(0)).toBe('');
    expect(buffer().get(-5)).toBe('');
  });

  test('depth beyond the transcript is harmless', () => {
    expect(buffer().get(99)).toBe(buffer().get(3));
    expect(buffer().get(MAX_SCAN_DEPTH + 500)).toBe(buffer().get(3));
  });

  test('an empty transcript yields an empty string, not a bare sentinel', () => {
    expect(new ScanBuffer([]).get(5)).toBe('');
  });

  test('different depths are independent, so a per-entry override really is narrower', () => {
    const shared = buffer();
    expect(shared.get(1)).not.toBe(shared.get(3));
    // And re-asking is stable — the memo returns the same content, not a growing one.
    expect(shared.get(1)).toBe('\x01the knight arrived');
  });
});

describe('ScanBuffer recursion', () => {
  test('recursed text is visible at every depth', () => {
    const buffer = ScanBuffer.fromMessages(transcript);
    buffer.addRecursed('the castle has a moat');

    expect(matchKey(buffer.get(1), 'moat', WHOLE)).toBe(true);
    expect(matchKey(buffer.get(3), 'moat', WHOLE)).toBe(true);
  });

  test('adding recursed text invalidates the memo', () => {
    const buffer = ScanBuffer.fromMessages(transcript);
    const before = buffer.get(1);
    buffer.addRecursed('a moat');
    expect(buffer.get(1)).not.toBe(before);
    expect(buffer.get(1)).toContain('a moat');
  });

  test('can be excluded, for a scan that must not see earlier passes', () => {
    const buffer = ScanBuffer.fromMessages(transcript);
    buffer.addRecursed('a moat');
    expect(buffer.get(1, { includeRecursed: false })).toBe('\x01the knight arrived');
  });

  test('recursed text is still nothing at depth 0', () => {
    // Depth 0 means "this entry does not scan". Recursion must not smuggle content in.
    const buffer = ScanBuffer.fromMessages(transcript);
    buffer.addRecursed('a moat');
    expect(buffer.get(0)).toBe('');
  });

  test('blank recursed text is ignored', () => {
    const buffer = ScanBuffer.fromMessages(transcript);
    buffer.addRecursed('');
    expect(buffer.recursionDepth).toBe(0);
  });
});
