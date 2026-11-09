import { describe, expect, test } from 'bun:test';
import { messageFingerprint } from '@shared/nexus/state.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import {
  changeKey,
  inlineParts,
  kTokens,
  memoryChanges,
  memoryCoverage,
  memorySections,
  sectionLines,
  whenWritten,
  withSection,
} from './memory.ts';

const MEMORY = `## Who's who
- Mika: runs the bookshop.
- Wren: new in town.

## Where things stand
- Saturday evening at the shop.`;

describe('sections', () => {
  test('split at headings; edit one and the rest stay put', () => {
    const sections = memorySections(MEMORY);
    expect(sections.map((s) => s.title)).toEqual(["Who's who", 'Where things stand']);
    expect(sectionLines(sections[0]?.body ?? '')).toEqual([
      { kind: 'item', text: 'Mika: runs the bookshop.' },
      { kind: 'item', text: 'Wren: new in town.' },
    ]);
    const edited = withSection(MEMORY, 1, '- Saturday night, at the tavern.');
    expect(edited).toBe(
      MEMORY.replace('Saturday evening at the shop', 'Saturday night, at the tavern'),
    );
  });

  test('a summary without headings is one untitled section', () => {
    expect(memorySections('Mika and Wren met.\nThey talked.')).toEqual([
      { title: null, body: 'Mika and Wren met.\nThey talked.' },
    ]);
    expect(withSection('Old text.', 0, 'New text.')).toBe('New text.');
  });
});

test('bold and italics; a lone asterisk stays text', () => {
  expect(inlineParts('**Mika**: runs the *old* shop, 5 * 3')).toEqual([
    { text: 'Mika', strong: true },
    { text: ': runs the ' },
    { text: 'old', em: true },
    { text: ' shop, 5 * 3' },
  ]);
});

test('changes: a reworded line reads as changed, an added one as new', () => {
  const now = `## Who's who
- Mika: runs the bookshop.
- Wren: new in town, staying at Mika's.
- Talia: Mika's twin.

## Where things stand
- Saturday evening at the shop.`;
  const changes = memoryChanges(now, MEMORY);
  expect(changes.get(changeKey("Who's who", "Wren: new in town, staying at Mika's."))).toBe(
    'changed',
  );
  expect(changes.get(changeKey("Who's who", "Talia: Mika's twin."))).toBe('new');
  expect(changes.size).toBe(2);
});

describe('coverage', () => {
  const msg = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `m${i}`,
    name: i % 2 ? 'Wren' : 'Mika',
    is_user: i % 2 === 1,
    is_system: false,
    mes: `line ${i}`,
    send_date: '',
    ...extra,
  });

  test('each message in, hidden, changed, new or left out, drawn as runs', () => {
    const chat = [
      msg(0, { is_system: true, hiddenBy: 'summary' }),
      msg(1, { is_system: true, hiddenBy: 'summary' }),
      msg(2),
      msg(3),
      msg(4, { is_system: true }),
      msg(5),
      msg(6),
    ];
    const covered = [0, 1, 2, 3, 5].map((i) => messageFingerprint(msg(i)));
    // Message 3 was edited after it was summarised.
    chat[3] = msg(3, { mes: 'edited' });
    const result = memoryCoverage(chat, { text: 'memory', covered });
    expect(result.states).toEqual(['hidden', 'hidden', 'in', 'changed', 'out', 'in', 'new']);
    expect(result.runs.map((r) => [r.state, r.length])).toEqual([
      ['hidden', 2],
      ['in', 1],
      ['changed', 1],
      ['out', 1],
      ['in', 1],
      ['new', 1],
    ]);
    expect([result.inMemory, result.changed, result.fresh, result.hidden, result.cut]).toEqual([
      4, 1, 1, 2, 2,
    ]);
  });
});

test('words', () => {
  const now = new Date('2026-11-07T18:00:00');
  expect(whenWritten('2026-11-07T17:59:30', now)).toBe('Just now');
  expect(whenWritten('2026-11-07T17:20:00', now)).toBe('40 min ago');
  expect(whenWritten('2026-11-07T09:00:00', now)).toBe('9 h ago');
  expect(whenWritten('2026-11-06T23:10:00', now)).toBe('Yesterday');
  expect(whenWritten(undefined, now)).toBe('Earlier');
  expect([kTokens(840), kTokens(5120), kTokens(28_200)]).toEqual(['840', '5.1k', '28k']);
});
