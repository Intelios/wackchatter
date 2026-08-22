import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { RoundSide } from '../../shared/types/arena.ts';
import { type ArenaStore, createArenaStore, isVerdict } from './arena.ts';
import { createSchema } from './db.ts';

let store: ArenaStore;
let database: Database;

beforeEach(() => {
  database = new Database(':memory:');
  createSchema(database);
  store = createArenaStore(database);
});

function side(overrides: Partial<RoundSide> = {}): RoundSide {
  return {
    contenderId: 'c1',
    model: 'some/model',
    provider: 'openrouter',
    text: 'A reply.',
    ...overrides,
  };
}

describe('arena store', () => {
  test('records a round and reads it back whole', () => {
    const written = store.recordRound({
      characterId: 'Seraphina.png',
      probe: 'What are you doing here?',
      left: side({ contenderId: 'a', model: 'model-a' }),
      right: side({ contenderId: 'b', model: 'model-b', text: 'Another reply.' }),
      verdict: 'left',
    });

    expect(written.id).toBeTruthy();
    expect(written.created).toBeGreaterThan(0);

    const [read] = store.listRounds();
    expect(read).toEqual(written);
    expect(read?.left.model).toBe('model-a');
    expect(read?.right.text).toBe('Another reply.');
  });

  test('lists rounds oldest first, which is the order the replay needs', () => {
    const first = store.recordRound({
      characterId: 'a.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'left',
    });
    const second = store.recordRound({
      characterId: 'b.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'right',
    });

    // Both can land inside one millisecond, so this asserts the ordering is at least
    // non-decreasing rather than pretending the clock separated them.
    const ids = store.listRounds().map((round) => round.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(second.created).toBeGreaterThanOrEqual(first.created);
  });

  test('coerces a bogus verdict rather than storing one the replay would ignore', () => {
    const written = store.recordRound({
      characterId: 'a.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'sideways' as never,
    });

    expect(written.verdict).toBe('bad');
    expect(store.listRounds()[0]?.verdict).toBe('bad');
  });

  test('a row hand-edited to an unknown verdict reads back as bad', () => {
    store.recordRound({
      characterId: 'a.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'left',
    });
    database.exec("UPDATE arena_rounds SET verdict = 'nonsense'");

    expect(store.listRounds()[0]?.verdict).toBe('bad');
  });

  test('missing side fields become empty strings, never undefined columns', () => {
    const written = store.recordRound({
      characterId: 'a.png',
      probe: '',
      left: {} as RoundSide,
      right: side(),
      verdict: 'tie',
    });

    expect(written.left).toEqual({ contenderId: '', model: '', provider: '', text: '' });
    expect(store.listRounds()[0]?.left.model).toBe('');
  });

  test('delete removes one round and reports whether it existed', () => {
    const round = store.recordRound({
      characterId: 'a.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'left',
    });

    expect(store.deleteRound('nope')).toBe(false);
    expect(store.deleteRound(round.id)).toBe(true);
    expect(store.listRounds()).toEqual([]);
  });

  test('clear empties the history and reports the count', () => {
    for (let i = 0; i < 3; i++) {
      store.recordRound({
        characterId: 'a.png',
        probe: '',
        left: side(),
        right: side(),
        verdict: 'left',
      });
    }

    expect(store.clearRounds()).toBe(3);
    expect(store.listRounds()).toEqual([]);
    expect(store.clearRounds()).toBe(0);
  });

  test('a deleted card does not take its rounds with it — character_id is not a key', () => {
    store.recordRound({
      characterId: 'Gone.png',
      probe: '',
      left: side(),
      right: side(),
      verdict: 'left',
    });

    // Nothing in the schema references characters, so the row survives regardless of what
    // the library does. Asserted because it is the reason the leaderboard can still label
    // a round whose card was deleted.
    expect(store.listRounds()[0]?.characterId).toBe('Gone.png');
  });
});

describe('isVerdict', () => {
  test('accepts the four verdicts and nothing else', () => {
    expect(isVerdict('left')).toBe(true);
    expect(isVerdict('right')).toBe(true);
    expect(isVerdict('tie')).toBe(true);
    expect(isVerdict('bad')).toBe(true);
    expect(isVerdict('Left')).toBe(false);
    expect(isVerdict('')).toBe(false);
    expect(isVerdict(null)).toBe(false);
  });
});
