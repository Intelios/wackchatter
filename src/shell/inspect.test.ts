import { describe, expect, test } from 'bun:test';
import type { MessageState } from '@shared/chat/message.ts';
import type { ReplyTrace, SwipeInfo } from '@shared/types/chat.ts';
import type { PromptInspection } from '../features/chat/state/chatReducer.ts';
import {
  chatTurns,
  phases,
  promptBlocks,
  promptDiff,
  rowScale,
  seconds,
  stripWindow,
  traceLanes,
} from './inspect.ts';

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function trace(extra: Partial<ReplyTrace> = {}): ReplyTrace {
  return { sent: 300, thinking: 1300, writing: 4300, end: 7300, outcome: 'finished', ...extra };
}

function reply(id: string, swipes: SwipeInfo[], shown = swipes.length - 1): MessageState {
  return {
    id,
    name: 'Mika',
    is_user: false,
    is_system: false,
    swipes: swipes.map(() => 'text'),
    swipe_id: shown,
    swipe_info: swipes,
  } as MessageState;
}

const user = (id: string) =>
  ({
    id,
    name: 'Wren',
    is_user: true,
    is_system: false,
    swipes: ['hi'],
    swipe_id: 0,
    swipe_info: [{ send_date: iso(0) }],
  }) as MessageState;

function inspection(extra: Partial<PromptInspection> = {}): PromptInspection {
  return {
    at: T0,
    generationType: 'normal',
    messages: [],
    tokenCounts: {},
    totalTokens: 0,
    droppedMessages: 0,
    macroWarnings: [],
    body: null,
    chatId: 'c1',
    ...extra,
  };
}

describe('the replies in a chat', () => {
  const greeting = reply('g', [{ send_date: iso(0) }]);
  const old = reply('r1', [{ send_date: iso(0), gen_started: iso(1000), gen_finished: iso(7200) }]);
  const traced = reply(
    'r2',
    [
      {
        send_date: iso(0),
        gen_started: iso(20000),
        extra: { generation_id: 'a', trace: trace({ outcome: 'stopped', end: 3000 }) },
      },
      { send_date: iso(0), gen_started: iso(30000), extra: { generation_id: 'b', trace: trace() } },
    ],
    1,
  );

  test('a greeting is not a reply; old replies have only their total', () => {
    const turns = chatTurns([greeting, user('u1'), old, user('u2'), traced], [], null);
    expect(turns.map((t) => [t.n, t.main.total, t.attempts.length])).toEqual([
      [1, 6200, 1],
      [2, 7300, 2],
    ]);
    expect(phases(turns[0]!.main)).toEqual([{ phase: 'whole', ms: 6200 }]);
    expect(turns[1]!.main.key).toBe('b');
    expect(turns[1]!.attempts[0]!.outcome).toBe('stopped');
  });

  test('a swipe keeps its prompt while the session does, joined by its generation id', () => {
    const kept = inspection({ generationId: 'b', messageId: 'r2' });
    const turns = chatTurns([traced], [kept], null);
    expect(turns[0]!.main.inspection).toBe(kept);
    expect(turns[0]!.attempts[0]!.inspection).toBeUndefined();
  });

  test('a failed send leaves no message but still has a row, placed by time', () => {
    const failed = inspection({
      generationId: 'f',
      messageId: 'gone',
      at: T0 + 10300,
      trace: trace({ outcome: 'failed', thinking: undefined, writing: undefined, end: 900 }),
    });
    const turns = chatTurns([old, traced], [failed], null);
    expect(turns.map((t) => t.n ?? t.main.outcome)).toEqual([1, 'failed', 2]);
  });

  test('the reply being written is live on its message', () => {
    const placeholder = reply('r3', [{ send_date: iso(0), gen_started: iso(40000) }]);
    const live = inspection({ generationId: 'l', messageId: 'r3', at: T0 + 40300 });
    const turns = chatTurns([placeholder], [live], 'r3');
    expect(turns[0]!.main.outcome).toBe('live');
    expect(turns[0]!.main.total).toBeNull();
  });

  test('a reply the provider filtered says filtered, not finished', () => {
    const filtered = reply('r4', [
      {
        send_date: iso(0),
        gen_started: iso(50000),
        gen_finished: iso(53000),
        extra: { generation_id: 'c', finish_reason: 'content_filter' },
      },
    ]);
    const turns = chatTurns([filtered], [], null);
    expect(turns[0]!.main.outcome).toBe('filtered');
  });
});

describe('time', () => {
  test('phases and lanes split a reply at its marks', () => {
    const t = trace({ lore: { ms: 12, fired: 3 }, memory: { ms: 180, recalled: 5 } });
    expect(phases({ trace: t, total: t.end } as never).map((p) => [p.phase, p.ms])).toEqual([
      ['prep', 300],
      ['wait', 1000],
      ['think', 3000],
      ['write', 3000],
    ]);
    expect(traceLanes(t).map((l) => [l.id, l.start, l.ms])).toEqual([
      ['prep', 0, 300],
      ['lore', 0, 12],
      ['memory', 12, 180],
      ['wait', 300, 1000],
      ['think', 1300, 3000],
      ['write', 4300, 3000],
    ]);
  });

  test('one very slow reply does not set the scale', () => {
    const totals = [6000, 7000, 6500, 8000, 7200, 6100, 6900, 7500, 7000, 41000];
    expect(rowScale(totals)).toBe(11000);
    expect(rowScale([])).toBe(1000);
  });

  test('the strip shows twenty replies around the picked one', () => {
    expect(stripWindow(64, 63)).toEqual([44, 63]);
    expect(stripWindow(64, 40)).toEqual([30, 49]);
    expect(stripWindow(64, 2)).toEqual([0, 19]);
    expect(stripWindow(8, 3)).toEqual([0, 7]);
  });

  test('durations read short', () => {
    expect([seconds(310), seconds(7340), seconds(41000), seconds(150000)]).toEqual([
      '0.31s',
      '7.3s',
      '41s',
      '2m 30s',
    ]);
  });
});

describe('the prompt', () => {
  const names = { char: 'Mika', persona: 'Wren', prompts: new Map([['custom1', 'Tone']]) };
  const sent = (lore: string[], main: string, custom = true) =>
    inspection({
      lore,
      messages: [
        { role: 'system', content: main },
        { role: 'system', content: 'Mika runs the bookshop.' },
        ...(custom ? [{ role: 'system' as const, content: 'Dry.' }] : []),
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'fog' },
        { role: 'user', content: 'tavern?' },
      ],
      origins: [
        ['main'],
        ['charDescription'],
        ...(custom ? [['custom1']] : []),
        ['chatHistory'],
        ['chatHistory'],
        ['worldInfoDepth', 'authorNote'],
        ['chatHistory'],
      ],
    });

  test('blocks follow the order sent; an injection splits the transcript', () => {
    const blocks = promptBlocks(sent([], 'Write.'), names);
    expect(blocks.map((b) => [b.name, b.source, b.messages.length])).toEqual([
      ['Main prompt', 'mine', 1],
      ['Mika · description', 'card', 1],
      ['Tone', 'mine', 1],
      ['Chat history', 'history', 2],
      ['Lore, in the chat + Author’s note', 'lore', 1],
      ['Chat history', 'history', 1],
    ]);
    expect(blocks[3]!.role).toBe('mixed');
  });

  test('since the one before: lore that came and went, and prompts new, edited or gone', () => {
    const before = sent(['Harbor rules', 'Weather'], 'Write.', true);
    const now = {
      ...sent(['Weather', 'The Gilded Rose'], 'Write well.', false),
      droppedMessages: 2,
    };
    const diff = promptDiff(before, now, names);
    expect(diff.changes).toEqual([
      { sign: '+', text: 'lore · The Gilded Rose' },
      { sign: '-', text: 'lore · Harbor rules' },
      { sign: '-', text: '2 old messages no longer fit' },
      { sign: '~', text: 'Main prompt edited' },
      { sign: '-', text: 'Tone' },
    ]);
    expect([...diff.marks]).toEqual([['main', 'edited']]);
    expect(diff.gone.map((b) => b.name)).toEqual(['Tone']);
  });
});
