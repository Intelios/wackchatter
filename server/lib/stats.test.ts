import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ChatMessage, SwipeInfo } from '../../shared/types/chat.ts';
import { type ChatStore, createChatStore } from './chats.ts';
import { createSchema } from './db.ts';
import { activeMs, createStatsStore, type StatsStore } from './stats.ts';

let database: Database;
let chats: ChatStore;
let stats: StatsStore;

beforeEach(() => {
  database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  chats = createChatStore(database, { backupDir: null });
  // The filesystem is not what this suite is about, and a real backups directory would
  // make `deletedChats` depend on whatever the machine happens to be holding.
  stats = createStatsStore(database, { backupDir: null });
});

function swipe(overrides: Partial<SwipeInfo> = {}): SwipeInfo {
  return {
    send_date: '2026-01-01T12:00:00.000Z',
    gen_started: '2026-01-01T12:00:00.000Z',
    gen_finished: '2026-01-01T12:00:10.000Z',
    extra: { api: 'custom', model: 'glm-5.2', token_count: 100 },
    ...overrides,
  };
}

/** A reply with one swipe per text, so a test can say "this one was rerolled twice". */
function reply(texts: string[], infos?: SwipeInfo[]): ChatMessage {
  return {
    id: crypto.randomUUID(),
    name: 'Seraphina',
    is_user: false,
    is_system: false,
    mes: texts[0] ?? '',
    send_date: '2026-01-01T12:00:00.000Z',
    swipes: texts,
    swipe_id: 0,
    swipe_info: infos ?? texts.map(() => swipe()),
  };
}

function userMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    name: 'Jack',
    is_user: true,
    is_system: false,
    persona_id: 'persona-1',
    mes: text,
    send_date: '2026-01-01T12:00:00.000Z',
    swipes: [text],
    swipe_id: 0,
    swipe_info: [{ send_date: '2026-01-01T12:00:00.000Z' }],
  };
}

describe('an empty library', () => {
  test('reports zeros rather than NaN', () => {
    const overview = stats.overview();

    expect(overview.totals).toEqual({
      chats: 0,
      messages: 0,
      userMessages: 0,
      replies: 0,
      swipes: 0,
      tokens: 0,
      activeMinutes: 0,
    });
    expect(overview.cast).toEqual([]);
    expect(overview.models).toEqual([]);
    expect(overview.longestChat).toBeNull();

    // The averages are the ones that divide, so they are the ones that could poison the
    // screen with NaN. Every number here has to survive JSON and render as a digit.
    expect(overview.habits.avgUserChars).toBe(0);
    expect(overview.habits.avgReplyChars).toBe(0);
    expect(Number.isFinite(overview.habits.avgUserChars)).toBe(true);
    expect(Number.isFinite(overview.habits.avgReplyChars)).toBe(true);
    expect(JSON.stringify(overview)).not.toContain('null,null');
  });

  test('a character with no chats reports zeros too', () => {
    const card = stats.forCharacter('Nobody.png');
    expect(card.totals.chats).toBe(0);
    expect(card.chats).toEqual([]);
    expect(card.firstChat).toBeNull();
    expect(card.habits.avgReplyChars).toBe(0);
  });
});

describe('rerolls', () => {
  test('alternate greetings are not counted as rerolls', () => {
    // The card arrives with four greetings, which the message model stores as four swipes
    // on the message at position 0. The user rerolled exactly one reply, once.
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        reply(['greeting a', 'greeting b', 'greeting c', 'greeting d']),
        userMessage('hello'),
        reply(['take one', 'take two']),
        userMessage('again'),
        reply(['single take']),
      ],
    });

    const { habits } = stats.overview();

    expect(habits.rerolls).toBe(1);
    expect(habits.rerolledReplies).toBe(1);
    // Greeting excluded from the denominator as well as the numerator.
    expect(habits.eligibleReplies).toBe(2);
  });

  test('opening greetings are excluded from swipe totals', () => {
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [reply(['greeting a', 'greeting b', 'greeting c']), userMessage('hi')],
    });

    const { totals, habits, models } = stats.overview();

    // Opening greetings carry no model and were never generated, so totals.swipes stays zero
    // rather than contradicting the empty models ring.
    expect(totals.swipes).toBe(0);
    expect(totals.tokens).toBe(0);
    expect(models).toEqual([]);
    expect(habits.rerolls).toBe(0);
  });
});

describe('models', () => {
  test('a provider id outside the current union still reports', () => {
    // 'openai' predates the custom/openrouter union. Dropping the row would silently
    // delete a quarter of this library's history from its own stats screen.
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        userMessage('hi'),
        reply(['a'], [swipe({ extra: { api: 'openai', model: 'gpt-4o', token_count: 10 } })]),
      ],
    });

    const [model] = stats.overview().models;
    expect(model?.model).toBe('gpt-4o');
    expect(model?.api).toBe('openai');
    expect(model?.swipes).toBe(1);
  });

  test('untimed swipes are excluded from speed but not from counts', () => {
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        userMessage('hi'),
        reply(
          ['timed', 'untimed'],
          [
            // 200 tokens in 10s.
            swipe({ extra: { api: 'custom', model: 'glm-5.2', token_count: 200 } }),
            // An aborted or legacy swipe: real tokens, no clock. Averaging it in as zero
            // seconds would report an infinite rate.
            swipe({
              gen_started: undefined,
              gen_finished: undefined,
              extra: { api: 'custom', model: 'glm-5.2', token_count: 999 },
            }),
          ],
        ),
      ],
    });

    const [model] = stats.overview().models;
    expect(model?.swipes).toBe(2);
    expect(model?.tokens).toBe(1199);
    expect(model?.avgLatencyMs).toBe(10_000);
    expect(model?.tokensPerSecond).toBe(20);
  });

  test('a model with no timings at all reports null rather than zero', () => {
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        userMessage('hi'),
        reply(
          ['a'],
          [
            swipe({
              gen_started: undefined,
              gen_finished: undefined,
              extra: { api: 'custom', model: 'mystery', token_count: 5 },
            }),
          ],
        ),
      ],
    });

    const [model] = stats.overview().models;
    expect(model?.avgLatencyMs).toBeNull();
    expect(model?.tokensPerSecond).toBeNull();
  });

  test('sum of model swipes matches totals.swipes on multi-greeting chats', () => {
    // Multi-greeting card + 1 rerolled reply (2 swipes) + 1 single reply with reasoning (1 swipe)
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        reply(['greeting a', 'greeting b', 'greeting c', 'greeting d']),
        userMessage('hello'),
        reply(
          ['take one', 'take two'],
          [
            swipe({ extra: { api: 'custom', model: 'glm-5.2', token_count: 50 } }),
            swipe({ extra: { api: 'custom', model: 'glm-5.2', token_count: 60 } }),
          ],
        ),
        userMessage('tell me more'),
        reply(
          ['thinking take'],
          [
            swipe({
              extra: {
                api: 'openrouter',
                model: 'claude-3-7-sonnet',
                token_count: 100,
                reasoning: 'thought...',
              },
            }),
          ],
        ),
      ],
    });

    const overview = stats.overview();
    const modelSwipesSum = overview.models.reduce((sum, m) => sum + m.swipes, 0);

    expect(overview.totals.swipes).toBe(3);
    expect(modelSwipesSum).toBe(overview.totals.swipes);
    expect(overview.habits.reasoningSwipes).toBe(1);
    // Reasoning rate denominator is totals.swipes (3), not deflated by the 4 greeting swipes or 2 user messages
    expect(overview.habits.reasoningSwipes / overview.totals.swipes).toBeCloseTo(1 / 3);
  });
});

describe('scoping to one character', () => {
  test('totals and models cover only that card', () => {
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [userMessage('hi'), reply(['there'])],
    });
    chats.createChat({
      characterId: 'Mika.png',
      messages: [
        userMessage('hello'),
        reply(['hi'], [swipe({ extra: { api: 'openrouter', model: 'other', token_count: 7 } })]),
      ],
    });

    expect(stats.overview().totals.chats).toBe(2);

    const mika = stats.forCharacter('Mika.png');
    expect(mika.totals.chats).toBe(1);
    expect(mika.totals.messages).toBe(2);
    expect(mika.models.map((entry) => entry.model)).toEqual(['other']);
    expect(mika.chats).toHaveLength(1);
  });
});

describe('the hour histogram', () => {
  test('counts the selected swipe once, not every alternate', () => {
    chats.createChat({
      characterId: 'Seraphina.png',
      messages: [
        userMessage('hi'),
        // Rerolled four times, all within the same hour. The evening happened once.
        reply(
          ['a', 'b', 'c', 'd'],
          ['a', 'b', 'c', 'd'].map(() => swipe({ send_date: '2026-01-01T12:30:00.000Z' })),
        ),
      ],
    });

    const { hours } = stats.overview();
    const total = hours.reduce((sum, [, count]) => sum + count, 0);

    expect(total).toBe(2);
    expect(hours.every(([hour]) => hour % 3_600_000 === 0)).toBe(true);
  });
});

describe('activeMs', () => {
  test('sums the gaps inside a sitting', () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    expect(activeMs([[start, start + 60_000, start + 120_000]])).toBe(120_000);
  });

  test('drops the gap between two sittings', () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const run = [
      start,
      start + 60_000,
      start + 5 * 60 * 60 * 1000,
      start + 5 * 60 * 60 * 1000 + 60_000,
    ];
    expect(activeMs(run.length ? [run] : [])).toBe(120_000);
  });

  test('a lone message is a sitting of zero', () => {
    expect(activeMs([[Date.now()]])).toBe(0);
    expect(activeMs([])).toBe(0);
  });

  test('runs are measured separately, so two chats at once do not merge', () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    expect(
      activeMs([
        [start, start + 60_000],
        [start, start + 60_000],
      ]),
    ).toBe(120_000);
  });
});

describe('branchedChats', () => {
  test('counts branched chats by metadata provenance rather than title convention', () => {
    const original = chats.createChat({
      characterId: 'Seraphina.png',
      title: 'Original',
      messages: [userMessage('hi'), reply(['hello'])],
    });

    const msgId = chats.getChat(original.id)!.messages[0]!.id;
    const branch = chats.branchChat(original.id, msgId)!;

    expect(stats.overview().habits.branchedChats).toBe(1);

    // Renaming the branched chat to remove " (branch)" does not drop it from the count
    chats.updateChatMeta(branch.id, { revision: branch.revision + 1, title: 'A New Timeline' });
    expect(stats.overview().habits.branchedChats).toBe(1);

    // Creating a non-branch chat with " (branch)" in the title does NOT count as a branch
    chats.createChat({
      characterId: 'Seraphina.png',
      title: 'Fake (branch)',
      messages: [userMessage('hey')],
    });
    expect(stats.overview().habits.branchedChats).toBe(1);

    // Character-scoped stats correctly attribute branches
    const seraphina = stats.forCharacter('Seraphina.png');
    expect(seraphina.habits.branchedChats).toBe(1);

    const mika = stats.forCharacter('Mika.png');
    expect(mika.habits.branchedChats).toBe(0);
  });

  test('a branch of a branch also counts as a branched chat', () => {
    const root = chats.createChat({
      characterId: 'Seraphina.png',
      title: 'Root',
      messages: [userMessage('first'), reply(['reply 1']), userMessage('second')],
    });

    const msg1 = chats.getChat(root.id)!.messages[0]!.id;
    const branch1 = chats.branchChat(root.id, msg1)!;

    const branch1Msg = branch1.messages[0]!.id;
    chats.branchChat(branch1.id, branch1Msg);

    expect(stats.overview().habits.branchedChats).toBe(2);
  });
});
