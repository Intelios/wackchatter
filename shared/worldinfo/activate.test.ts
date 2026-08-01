import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types/chat.ts';
import type { WorldInfoEntry, WorldInfoSettings } from '../types/worldinfo.ts';
import {
  DEFAULT_WI_SETTINGS,
  WI_LOGIC,
  WI_POSITION,
  WI_ROLE,
  createWorldInfoEntry,
} from '../types/worldinfo.ts';
import {
  type ActivateOptions,
  type WorldInfoSource,
  activateWorldInfo,
  worldInfoBudget,
} from './activate.ts';

/** One token per word, so budgets in these tests are readable as word counts. */
const countTokens = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

let nextUid = 0;
function entry(partial: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return { ...createWorldInfoEntry(nextUid++), content: 'lore', ...partial };
}

function book(entries: WorldInfoEntry[]): WorldInfoSource {
  const record: Record<string, WorldInfoEntry> = {};
  for (const item of entries) record[String(item.uid)] = item;
  return { kind: 'global', name: 'Test', book: { name: 'Test', entries: record } };
}

function message(mes: string, partial: Partial<ChatMessage> = {}): ChatMessage {
  return { id: mes, name: 'User', is_user: true, is_system: false, send_date: '', mes, ...partial };
}

function activate(
  entries: WorldInfoEntry[],
  messages: ChatMessage[],
  overrides: Partial<ActivateOptions> = {},
) {
  const { settings: settingsOverride, sources, ...rest } = overrides;
  const settings: WorldInfoSettings = { ...DEFAULT_WI_SETTINGS, ...(settingsOverride ?? {}) };
  return activateWorldInfo({
    sources: sources ?? [book(entries)],
    messages,
    budget: 1000,
    countTokens,
    seed: 'test-seed',
    ...rest,
    settings,
  });
}

const uids = (result: { activated: Array<{ uid: number }> }) => result.activated.map((e) => e.uid);

describe('worldInfoBudget', () => {
  test('is a percentage of the context', () => {
    expect(worldInfoBudget({ ...DEFAULT_WI_SETTINGS, budget: 25 }, 8000)).toBe(2000);
  });

  test('a cap of 0 means no cap, not a budget of zero', () => {
    expect(worldInfoBudget({ ...DEFAULT_WI_SETTINGS, budget: 25, budgetCap: 0 }, 8000)).toBe(2000);
    expect(worldInfoBudget({ ...DEFAULT_WI_SETTINGS, budget: 25, budgetCap: 500 }, 8000)).toBe(500);
  });

  test('a cap above the percentage does not raise it', () => {
    expect(worldInfoBudget({ ...DEFAULT_WI_SETTINGS, budget: 10, budgetCap: 9000 }, 8000)).toBe(
      800,
    );
  });
});

describe('activation', () => {
  test('a constant entry fires with no keys at all', () => {
    const always = entry({ constant: true, content: 'always here' });
    const result = activate([always], [message('hello')]);

    expect(uids(result)).toEqual([always.uid]);
    expect(result.activated[0]!.reason).toBe('constant');
    expect(result.before).toBe('always here');
  });

  test('a keyword entry fires only when its key is in the scan window', () => {
    const dragon = entry({ key: ['dragon'], content: 'dragons are real' });

    expect(uids(activate([dragon], [message('tell me about the dragon')]))).toEqual([dragon.uid]);
    expect(uids(activate([dragon], [message('tell me about the castle')]))).toEqual([]);
  });

  test('a keyword beyond the scan depth does not fire', () => {
    const dragon = entry({ key: ['dragon'] });
    const messages = [message('a dragon appeared'), message('two'), message('three')];

    // Depth 2 sees the last two messages only.
    expect(
      uids(activate([dragon], messages, { settings: { ...DEFAULT_WI_SETTINGS, depth: 2 } })),
    ).toEqual([]);
    expect(
      uids(activate([dragon], messages, { settings: { ...DEFAULT_WI_SETTINGS, depth: 3 } })),
    ).toEqual([dragon.uid]);
  });

  test('a per-entry scanDepth overrides the global one', () => {
    const deep = entry({ key: ['dragon'], scanDepth: 3 });
    const shallow = entry({ key: ['dragon'], scanDepth: 1 });
    const messages = [message('a dragon appeared'), message('two'), message('three')];

    const result = activate([deep, shallow], messages, {
      settings: { ...DEFAULT_WI_SETTINGS, depth: 1 },
    });
    expect(uids(result)).toEqual([deep.uid]);
  });

  test('a hidden message cannot trigger lore', () => {
    const secret = entry({ key: ['dragon'] });
    const messages = [message('a dragon', { is_system: true }), message('hello')];
    expect(uids(activate([secret], messages))).toEqual([]);
  });

  test('secondary keys gate a primary match', () => {
    const gated = entry({
      key: ['dragon'],
      keysecondary: ['night'],
      selective: true,
      selectiveLogic: WI_LOGIC.AND_ANY,
    });

    expect(uids(activate([gated], [message('a dragon at night')]))).toEqual([gated.uid]);
    expect(uids(activate([gated], [message('a dragon at dawn')]))).toEqual([]);
  });

  test('a disabled entry is reported, not silently absent', () => {
    const off = entry({ constant: true, disable: true });
    const result = activate([off], [message('hi')]);

    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({ uid: off.uid, reason: 'disabled' })]);
  });

  test('a vectorized entry never fires on keywords', () => {
    // In ST these are reachable only by vector search. Treating the flag as absent would
    // fire it somewhere ST never would.
    const vector = entry({ key: ['dragon'], vectorized: true });
    const result = activate([vector], [message('a dragon')]);

    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0]!.reason).toBe('vectorized');
  });

  test('an entry with blank content is skipped', () => {
    const blank = entry({ constant: true, content: '   ' });
    expect(activate([blank], [message('hi')]).skipped[0]!.reason).toBe('empty');
  });

  test('every activated entry reports where it came from and what it cost', () => {
    const lore = entry({ constant: true, content: 'three word content', comment: 'My memo' });
    const [activated] = activate([lore], [message('hi')]).activated;

    expect(activated).toMatchObject({
      uid: lore.uid,
      sourceKind: 'global',
      sourceName: 'Test',
      label: 'My memo',
      tokens: 3,
      placement: 'before',
      reason: 'constant',
      pass: 0,
    });
  });

  test('the label falls back to the first key, then the uid', () => {
    const keyed = entry({ constant: true, key: ['dragon'] });
    const bare = entry({ constant: true });

    const result = activate([keyed, bare], [message('hi')]);
    const labels = new Map(result.activated.map((e) => [e.uid, e.label]));
    expect(labels.get(keyed.uid)).toBe('dragon');
    expect(labels.get(bare.uid)).toBe(`#${bare.uid}`);
  });
});

describe('placement', () => {
  test('before and after go to their own blocks', () => {
    const first = entry({ constant: true, content: 'BEFORE', position: WI_POSITION.before });
    const second = entry({ constant: true, content: 'AFTER', position: WI_POSITION.after });

    const result = activate([first, second], [message('hi')]);
    expect(result.before).toBe('BEFORE');
    expect(result.after).toBe('AFTER');
  });

  test('the highest order ends up closest to the chat', () => {
    // Walked descending and unshifted, so the emitted block reads ascending — matching
    // ST, and the reason a higher order feels "more important".
    const low = entry({ constant: true, content: 'LOW', order: 10 });
    const high = entry({ constant: true, content: 'HIGH', order: 900 });

    expect(activate([low, high], [message('hi')]).before).toBe('LOW\nHIGH');
  });

  test('order sorts across sources, with source precedence as the tiebreak', () => {
    const chatEntry = { ...entry({ constant: true, content: 'CHAT' }), order: 100 };
    const globalEntry = { ...entry({ constant: true, content: 'GLOBAL' }), order: 100 };

    const result = activateWorldInfo({
      sources: [
        { kind: 'chat', name: 'Chat', book: book([chatEntry]).book },
        { kind: 'global', name: 'Global', book: book([globalEntry]).book },
      ],
      messages: [message('hi')],
      settings: DEFAULT_WI_SETTINGS,
      budget: 1000,
      countTokens,
    });

    // Tied order, so source order decides: chat is unshifted first, ending up last.
    expect(result.before).toBe('GLOBAL\nCHAT');
  });

  test('atDepth produces a depth injection with its role, not a before block', () => {
    const deep = entry({
      constant: true,
      content: 'DEEP',
      position: WI_POSITION.atDepth,
      depth: 3,
      role: WI_ROLE.USER,
      order: 55,
    });

    const result = activate([deep], [message('hi')]);
    expect(result.before).toBe('');
    expect(result.depth).toEqual([{ depth: 3, order: 55, role: 'user', content: 'DEEP' }]);
  });

  test('unsupported positions are folded rather than dropped, and say so', () => {
    // Silently discarding an author's lore is the worse failure.
    const anTop = entry({ constant: true, content: 'AN', position: WI_POSITION.ANTop });
    const emBottom = entry({ constant: true, content: 'EM', position: WI_POSITION.EMBottom });

    const result = activate([anTop, emBottom], [message('hi')]);
    expect(result.before).toBe('AN');
    expect(result.after).toBe('EM');

    const folded = new Map(result.activated.map((e) => [e.uid, e.foldedFrom]));
    expect(folded.get(anTop.uid)).toBe("Author's Note top");
    expect(folded.get(emBottom.uid)).toBe('Example messages bottom');
  });

  test('a supported position carries no foldedFrom', () => {
    const plain = entry({ constant: true, position: WI_POSITION.before });
    expect(activate([plain], [message('hi')]).activated[0]!.foldedFrom).toBeUndefined();
  });
});

describe('budget', () => {
  test('stops hard at the first entry that does not fit', () => {
    const first = entry({ constant: true, content: 'one two three', order: 300 });
    const second = entry({ constant: true, content: 'four five six', order: 200 });

    const result = activate([first, second], [message('hi')], { budget: 4 });

    expect(uids(result)).toEqual([first.uid]);
    expect(result.tokens).toBe(3);
    expect(result.budgetExhausted).toBe(true);
    expect(result.skipped).toEqual([
      expect.objectContaining({ uid: second.uid, reason: 'budget', tokens: 3 }),
    ]);
  });

  test('ignoreBudget is admitted even after the budget is gone', () => {
    const filler = entry({ constant: true, content: 'one two three', order: 300 });
    const blocked = entry({ constant: true, content: 'four five six', order: 200 });
    const forced = entry({ constant: true, content: 'always', order: 100, ignoreBudget: true });

    const result = activate([filler, blocked, forced], [message('hi')], { budget: 4 });

    expect(uids(result).sort()).toEqual([filler.uid, forced.uid].sort());
    // And it is not charged, so it cannot push the history out on its own.
    expect(result.tokens).toBe(3);
  });

  test('a zero budget admits nothing but ignoreBudget', () => {
    const normal = entry({ constant: true, content: 'nope' });
    const forced = entry({ constant: true, content: 'yes', ignoreBudget: true });

    expect(uids(activate([normal, forced], [message('hi')], { budget: 0 }))).toEqual([forced.uid]);
  });
});

describe('recursion', () => {
  test("an activated entry's content can trigger another entry", () => {
    const first = entry({ key: ['dragon'], content: 'the dragon guards a castle' });
    const second = entry({ key: ['castle'], content: 'the castle is tall' });

    const result = activate([first, second], [message('tell me about the dragon')]);

    expect(uids(result).sort()).toEqual([first.uid, second.uid].sort());
    const second_ = result.activated.find((e) => e.uid === second.uid)!;
    expect(second_.reason).toBe('recursion');
    expect(second_.pass).toBe(1);
  });

  test('preventRecursion stops an entry feeding the buffer', () => {
    const first = entry({
      key: ['dragon'],
      content: 'the dragon guards a castle',
      preventRecursion: true,
    });
    const second = entry({ key: ['castle'], content: 'the castle is tall' });

    expect(uids(activate([first, second], [message('the dragon')]))).toEqual([first.uid]);
  });

  test('excludeRecursion stops an entry being triggered by one', () => {
    const first = entry({ key: ['dragon'], content: 'the dragon guards a castle' });
    const second = entry({ key: ['castle'], content: 'tall', excludeRecursion: true });

    expect(uids(activate([first, second], [message('the dragon')]))).toEqual([first.uid]);
    // But it still fires when the chat itself mentions it.
    expect(uids(activate([second], [message('the castle')]))).toEqual([second.uid]);
  });

  test('recursion is off when the setting is off', () => {
    const first = entry({ key: ['dragon'], content: 'the dragon guards a castle' });
    const second = entry({ key: ['castle'], content: 'tall' });

    const result = activate([first, second], [message('the dragon')], {
      settings: { ...DEFAULT_WI_SETTINGS, recursive: false },
    });
    expect(uids(result)).toEqual([first.uid]);
  });

  test('delayUntilRecursion keeps an entry out of the first pass', () => {
    const delayed = entry({ key: ['dragon'], content: 'delayed', delayUntilRecursion: true });
    const result = activate([delayed], [message('the dragon')]);

    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0]!.reason).toBe('delayed');
  });

  test('a delayed entry still fires once recursion starts', () => {
    const trigger = entry({ key: ['dragon'], content: 'the dragon guards a castle' });
    const delayed = entry({ key: ['castle'], content: 'tall', delayUntilRecursion: true });

    expect(uids(activate([trigger, delayed], [message('the dragon')])).sort()).toEqual(
      [trigger.uid, delayed.uid].sort(),
    );
  });

  test('terminates even with the step cap removed', () => {
    // The cap is cost control, not the termination argument: an entry is removed from
    // consideration once it fires, so the loop is bounded by the candidate count.
    const chain = [
      entry({ key: ['a'], content: 'b' }),
      entry({ key: ['b'], content: 'c' }),
      entry({ key: ['c'], content: 'd' }),
      entry({ key: ['d'], content: 'a' }),
    ];

    const result = activate(chain, [message('a')], {
      settings: { ...DEFAULT_WI_SETTINGS, maxRecursionSteps: 1000 },
    });
    expect(result.activated).toHaveLength(4);
    expect(result.passes).toBeLessThanOrEqual(5);
  });

  test('the step cap limits how far recursion runs', () => {
    const chain = [
      entry({ key: ['a'], content: 'b' }),
      entry({ key: ['b'], content: 'c' }),
      entry({ key: ['c'], content: 'd' }),
    ];

    const result = activate(chain, [message('a')], {
      settings: { ...DEFAULT_WI_SETTINGS, maxRecursionSteps: 2 },
    });
    expect(result.activated).toHaveLength(2);
  });
});

describe('inclusion groups', () => {
  const grouped = () => [
    entry({ constant: true, content: 'A', group: 'weather' }),
    entry({ constant: true, content: 'B', group: 'weather' }),
    entry({ constant: true, content: 'C', group: 'weather' }),
  ];

  test('a group yields exactly one winner', () => {
    const result = activate(grouped(), [message('hi')]);
    expect(result.activated).toHaveLength(1);
    expect(result.skipped.filter((s) => s.reason === 'group')).toHaveLength(2);
  });

  test('groupOverride beats weight', () => {
    const members = grouped();
    members[2] = { ...members[2]!, groupOverride: true, groupWeight: 1 };

    const result = activate(members, [message('hi')]);
    expect(result.activated[0]!.content).toBe('C');
  });

  test('the highest order wins among several overrides', () => {
    const members = grouped();
    members[0] = { ...members[0]!, groupOverride: true, order: 10 };
    members[2] = { ...members[2]!, groupOverride: true, order: 900 };

    expect(activate(members, [message('hi')]).activated[0]!.content).toBe('C');
  });

  test('an entry in no group is unaffected', () => {
    const loner = entry({ constant: true, content: 'LONER' });
    const result = activate([...grouped(), loner], [message('hi')]);
    expect(result.activated.map((e) => e.uid)).toContain(loner.uid);
    expect(result.activated).toHaveLength(2);
  });

  test('an entry may belong to several groups, and losing one removes it', () => {
    const members = [
      entry({ constant: true, content: 'A', group: 'weather, mood', groupOverride: false }),
      entry({ constant: true, content: 'B', group: 'weather', groupOverride: true }),
      entry({ constant: true, content: 'C', group: 'mood' }),
    ];

    const result = activate(members, [message('hi')]);
    // B wins 'weather' outright, which removes A everywhere — so 'mood' is left to C.
    expect(result.activated.map((e) => e.content).sort()).toEqual(['B', 'C']);
  });

  test('a group that already won does not produce a second winner on recursion', () => {
    const trigger = entry({ constant: true, content: 'mentions castle', group: 'places' });
    const later = entry({ key: ['castle'], content: 'the castle', group: 'places' });

    const result = activate([trigger, later], [message('hi')]);
    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]!.uid).toBe(trigger.uid);
  });
});

describe('probability', () => {
  test('100% and useProbability off always fire', () => {
    const certain = entry({ constant: true, probability: 100 });
    const noRoll = entry({ constant: true, probability: 1, useProbability: false });

    expect(activate([certain, noRoll], [message('hi')]).activated).toHaveLength(2);
  });

  test('0% never fires', () => {
    const never = entry({ constant: true, probability: 0 });
    const result = activate([never], [message('hi')]);
    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0]!.reason).toBe('probability');
  });

  test('the same seed gives the same result, a different seed can differ', () => {
    const coins = Array.from({ length: 12 }, () => entry({ constant: true, probability: 50 }));

    const a = uids(activate(coins, [message('hi')], { seed: 'seed-a' }));
    const b = uids(activate(coins, [message('hi')], { seed: 'seed-a' }));
    const c = uids(activate(coins, [message('hi')], { seed: 'seed-b' }));

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('a certain entry does not consume a draw', () => {
    // With a seeded RNG a wasted draw shifts every later roll, so adding an always-on
    // entry would silently change which entries a 50% roll picks.
    const coins = Array.from({ length: 10 }, () => entry({ constant: true, probability: 50 }));
    const certain = entry({ constant: true, probability: 100, order: 999 });

    const without = uids(activate(coins, [message('hi')]));
    const withCertain = uids(activate([certain, ...coins], [message('hi')])).filter(
      (uid) => uid !== certain.uid,
    );

    expect(withCertain).toEqual(without);
  });

  test('a failed roll is not re-rolled on the next pass', () => {
    // Otherwise a 10% entry would creep towards certainty over a long recursion.
    const trigger = entry({ key: ['dragon'], content: 'the dragon guards a castle' });
    const coin = entry({ key: ['castle', 'dragon'], content: 'x', probability: 0 });

    const result = activate([trigger, coin], [message('the dragon')]);
    expect(result.skipped.filter((s) => s.uid === coin.uid)).toHaveLength(1);
  });
});

describe('determinism', () => {
  test('the whole result is stable for a fixed seed', () => {
    const entries = [
      entry({ constant: true, content: 'A', group: 'g', groupWeight: 100 }),
      entry({ constant: true, content: 'B', group: 'g', groupWeight: 100 }),
      entry({ key: ['dragon'], content: 'C', probability: 60 }),
      entry({ constant: true, content: 'D', position: WI_POSITION.atDepth, depth: 2 }),
    ];
    const messages = [message('the dragon')];

    const first = activate(entries, messages, { seed: 'chat:msg-7' });
    const second = activate(entries, messages, { seed: 'chat:msg-7' });

    expect(second.before).toBe(first.before);
    expect(second.after).toBe(first.after);
    expect(second.depth).toEqual(first.depth);
    expect(uids(second)).toEqual(uids(first));
  });
});
