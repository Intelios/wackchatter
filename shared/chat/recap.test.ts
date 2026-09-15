import { describe, expect, test } from 'bun:test';
import type { TokenCounter } from '../prompt/token-cache.ts';
import type { ChatMessage } from '../types/chat.ts';
import {
  buildRecapRequest,
  RECAP_OMISSION_MARKER,
  RECAP_PROMPT,
  recapTurns,
  serializeRecapTranscript,
} from './recap.ts';

/** Deterministic: one token per whitespace-separated word, plus one for the envelope. */
const countText = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const counter: TokenCounter = {
  countText,
  countChat: (messages) =>
    messages.reduce((total, message) => total + 1 + countText(message.content), 0),
};

/** What the whole request costs, computed the same way `buildRecapRequest` counts it. */
const requestCost = (transcript: string) =>
  counter.countChat([
    { role: 'system', content: RECAP_PROMPT },
    { role: 'user', content: transcript },
  ]);

function message(name: string, mes: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${name}:${mes}`,
    name,
    is_user: false,
    is_system: false,
    mes,
    send_date: '',
    ...extra,
  };
}

const TURNS = [
  message('Seraphina', 'The forest is quiet tonight.'),
  message('Wren', 'I heard something in the trees.', { is_user: true }),
  message('Seraphina', 'Then we should not stay here.'),
];

describe('recapTurns', () => {
  test('keeps visible turns in order and drops system and blank ones', () => {
    const turns = recapTurns([
      message('Seraphina', '  Welcome, traveller.  '),
      message('Wren', 'I step inside.', { is_user: true }),
      message('System', 'hidden', { is_system: true }),
      message('Seraphina', '   '),
    ]);
    expect(turns).toEqual([
      { name: 'Seraphina', text: 'Welcome, traveller.' },
      { name: 'Wren', text: 'I step inside.' },
    ]);
  });

  test('falls back only when the recorded name is empty', () => {
    const turns = recapTurns([
      message('', 'hello', { is_user: true }),
      message('', 'hi there'),
      message('  ', 'still them', { is_user: true }),
    ]);
    expect(turns.map((turn) => turn.name)).toEqual(['User', 'Assistant', 'User']);
  });
});

describe('serializeRecapTranscript', () => {
  test('is one Name: text line per turn, joined newest-last', () => {
    expect(
      serializeRecapTranscript([
        { name: 'Seraphina', text: 'Welcome.' },
        { name: 'Wren', text: 'Hello.' },
      ]),
    ).toBe('Seraphina: Welcome.\nWren: Hello.');
  });
});

describe('buildRecapRequest', () => {
  test('sends exactly the instruction and one transcript turn', () => {
    const build = buildRecapRequest({
      messages: TURNS,
      counter,
      maxContext: 10_000,
      maxTokens: 300,
    });
    expect(build.fits).toBe(true);
    expect(build.messages).toHaveLength(2);
    expect(build.messages[0]).toEqual({ role: 'system', content: RECAP_PROMPT });
    expect(build.messages[1]!.role).toBe('user');
    expect(build.messages[1]!.content).toBe(serializeRecapTranscript(recapTurns(TURNS)));
    expect(build.total).toBe(3);
    expect(build.dropped).toBe(0);
  });

  test('drops the oldest turns first when the transcript overflows', () => {
    const all = recapTurns(TURNS);
    // A budget that exactly buys the last two turns plus the omission marker, and cannot
    // buy the full transcript.
    const lastTwo = `${RECAP_OMISSION_MARKER}\n${serializeRecapTranscript(all.slice(1))}`;
    const budget = requestCost(lastTwo);
    expect(budget).toBeLessThan(requestCost(serializeRecapTranscript(all)));

    const build = buildRecapRequest({
      messages: TURNS,
      counter,
      maxContext: budget + 10,
      maxTokens: 10,
    });
    expect(build.fits).toBe(true);
    expect(build.total).toBe(3);
    expect(build.dropped).toBe(1);

    const transcript = build.messages[1]!.content;
    expect(transcript.startsWith(RECAP_OMISSION_MARKER)).toBe(true);
    expect(transcript).toContain('Wren: I heard something in the trees.');
    expect(transcript).toContain('Seraphina: Then we should not stay here.');
    expect(transcript).not.toContain('The forest is quiet tonight.');
  });

  test('keeps the prompt inside the declared budget', () => {
    const build = buildRecapRequest({
      messages: TURNS,
      counter,
      maxContext: 200,
      maxTokens: 20,
    });
    expect(build.fits).toBe(true);
    expect(build.promptTokens).toBeLessThanOrEqual(180);
  });

  test('refuses when even the instruction does not fit', () => {
    const build = buildRecapRequest({
      messages: TURNS,
      counter,
      maxContext: 5,
      maxTokens: 0,
    });
    expect(build.fits).toBe(false);
    expect(build.messages).toEqual([]);
    expect(build.total).toBe(3);
  });

  test('an empty transcript is still a well-formed request', () => {
    const build = buildRecapRequest({
      messages: [message('System', 'hidden', { is_system: true })],
      counter,
      maxContext: 4096,
      maxTokens: 300,
    });
    expect(build.fits).toBe(true);
    expect(build.total).toBe(0);
    expect(build.dropped).toBe(0);
    expect(build.messages).toHaveLength(2);
    expect(build.messages[1]!.content).toBe('');
  });
});
