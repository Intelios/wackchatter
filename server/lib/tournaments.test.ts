import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { RoundSide, TournamentStage } from '../../shared/types/arena.ts';
import { createSchema } from './db.ts';
import {
  createTournamentStore,
  isTournamentSize,
  isTournamentStatus,
  isTournamentVerdict,
  type TournamentStore,
} from './tournaments.ts';

let store: TournamentStore;
let database: Database;

beforeEach(() => {
  database = new Database(':memory:');
  // CASCADE is a per-connection setting, exactly as `openDatabase` notes — without this a
  // deleted tournament would leave its matches behind and the test would pass on a bug.
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  store = createTournamentStore(database);
});

function side(contenderId: string, overrides: Partial<RoundSide> = {}): RoundSide {
  return {
    contenderId,
    model: 'some/model',
    provider: 'openrouter',
    text: 'A reply.',
    ...overrides,
  };
}

function stages(count: number): TournamentStage[] {
  return Array.from({ length: count }, (_, index) => ({
    characterId: `card-${index}.png`,
    cue: `Cue ${index}`,
  }));
}

function create(overrides: Partial<Parameters<TournamentStore['createTournament']>[0]> = {}) {
  return store.createTournament({
    name: 'Weeknight Cup',
    size: 4,
    entrants: ['a', 'b', 'c', 'd'],
    stages: stages(2),
    ...overrides,
  });
}

function match(overrides: Partial<Parameters<TournamentStore['recordMatch']>[0]> = {}) {
  return store.recordMatch({
    tournamentId: overrides.tournamentId ?? created.id,
    stage: 0,
    matchIndex: 0,
    left: side('a'),
    right: side('b'),
    verdict: 'left',
    rerolled: false,
    ...overrides,
  });
}

let created: ReturnType<TournamentStore['createTournament']>;

beforeEach(() => {
  created = create();
});

describe('tournament store', () => {
  test('creates a tournament and reads the plan back whole', () => {
    const [read] = store.listTournaments();

    expect(read?.id).toBe(created.id);
    expect(read?.name).toBe('Weeknight Cup');
    expect(read?.status).toBe('active');
    expect(read?.size).toBe(4);
    expect(read?.entrants).toEqual(['a', 'b', 'c', 'd']);
    expect(read?.stages).toEqual(stages(2));
    expect(read?.matches).toEqual([]);
  });

  test('lists tournaments oldest first, with their matches attached', () => {
    const second = create({ name: 'Late Cup' });
    match({ tournamentId: second.id, stage: 0, matchIndex: 1 });

    const list = store.listTournaments();
    expect(list.map((entry) => entry.id)).toEqual([created.id, second.id]);
    expect(list[0]?.matches).toHaveLength(0);
    expect(list[1]?.matches).toHaveLength(1);
  });

  test('records a match, minting the id and timestamp and copying the stage plan', () => {
    const result = match({
      left: side('a', { model: 'model-a' }),
      right: side('b', { model: 'model-b' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.match.id).toBeTruthy();
    expect(result.match.created).toBeGreaterThan(0);
    expect(result.match.tournamentId).toBe(created.id);
    expect(result.match.characterId).toBe('card-0.png');
    expect(result.match.cue).toBe('Cue 0');
    expect(result.match.left.model).toBe('model-a');
    expect(result.match.verdict).toBe('left');
    expect(result.match.rerolled).toBe(false);
  });

  test('refuses a second match in one slot rather than recording it twice', () => {
    expect(match().ok).toBe(true);
    const again = match({ left: side('c'), right: side('d') });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toBe('slot-taken');
    expect(store.listTournaments()[0]?.matches).toHaveLength(1);
  });

  test('allows matches in different slots of the same stage', () => {
    expect(match({ stage: 0, matchIndex: 0 }).ok).toBe(true);
    expect(match({ stage: 0, matchIndex: 1 }).ok).toBe(true);
    expect(store.listTournaments()[0]?.matches).toHaveLength(2);
  });

  test('refuses a match for a tournament that does not exist', () => {
    const result = match({ tournamentId: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('tournament-not-found');
  });

  test('refuses a match for a stage the plan does not have', () => {
    const result = match({ stage: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('stage-missing');
  });

  test('records the dead-heat re-roll as a fact on the match', () => {
    const result = match({ rerolled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.match.rerolled).toBe(true);
    expect(store.listTournaments()[0]?.matches[0]?.rerolled).toBe(true);
  });

  test('renames without touching status, and abandons without touching the name', () => {
    const renamed = store.updateTournament(created.id, { name: 'Grand Cup' });
    expect(renamed?.name).toBe('Grand Cup');
    expect(renamed?.status).toBe('active');

    const abandoned = store.updateTournament(created.id, { status: 'abandoned' });
    expect(abandoned?.name).toBe('Grand Cup');
    expect(abandoned?.status).toBe('abandoned');
  });

  test('keeps played matches when a tournament is abandoned', () => {
    expect(match().ok).toBe(true);
    store.updateTournament(created.id, { status: 'abandoned' });

    const [read] = store.listTournaments();
    expect(read?.status).toBe('abandoned');
    expect(read?.matches).toHaveLength(1);
  });

  test('updating a tournament that does not exist is a null, not a throw', () => {
    expect(store.updateTournament('nope', { name: 'x' })).toBeNull();
    expect(store.deleteTournament('nope')).toBe(false);
  });

  test('deleting a tournament takes its matches with it', () => {
    expect(match().ok).toBe(true);
    expect(match({ stage: 0, matchIndex: 1 }).ok).toBe(true);

    expect(store.deleteTournament(created.id)).toBe(true);
    expect(store.listTournaments()).toEqual([]);

    const rows = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM arena_matches')
      .get();
    expect(rows?.count).toBe(0);
  });

  test('a deleted card keeps its matches, because characterId is not a foreign key', () => {
    expect(match().ok).toBe(true);
    // The plan is edited on the tournament, not on the match; the match keeps the card it ran.
    const still = store.getTournament(created.id);
    expect(still?.stages[0]?.characterId).toBe('card-0.png');
    expect(store.listTournaments()[0]?.matches[0]?.characterId).toBe('card-0.png');
  });
});

describe('tournament value guards', () => {
  test('sizes are exactly 4, 8 and 16', () => {
    for (const size of [4, 8, 16]) expect(isTournamentSize(size)).toBe(true);
    for (const size of [2, 6, 12, 32, '4', null, undefined]) {
      expect(isTournamentSize(size)).toBe(false);
    }
  });

  test('status is exactly active or abandoned — completion is derived, never stored', () => {
    expect(isTournamentStatus('active')).toBe(true);
    expect(isTournamentStatus('abandoned')).toBe(true);
    expect(isTournamentStatus('completed')).toBe(false);
  });

  test('a stored match verdict is exactly left or right', () => {
    expect(isTournamentVerdict('left')).toBe(true);
    expect(isTournamentVerdict('right')).toBe(true);
    for (const value of ['tie', 'bad', '', null]) expect(isTournamentVerdict(value)).toBe(false);
  });
});

describe('tournament row coercion', () => {
  test('a hand-edited row cannot invent entrants or shift a stage', () => {
    database
      .query('UPDATE arena_tournaments SET entrants = ?, stages = ? WHERE id = ?')
      .run(
        JSON.stringify(['a', '', 'a', 7, 'b']),
        JSON.stringify([{ characterId: 'x.png', cue: '' }, 'garbage', null]),
        created.id,
      );

    const [read] = store.listTournaments();
    // Blanks, non-strings and the duplicate are dropped — a contender cannot fight itself.
    expect(read?.entrants).toEqual(['a', 'b']);
    // Blank stages are kept, not filtered: index is what a match refers to.
    expect(read?.stages).toEqual([
      { characterId: 'x.png', cue: '' },
      { characterId: '', cue: '' },
      { characterId: '', cue: '' },
    ]);
  });

  test('an unreadable match verdict is omitted rather than given a winner', () => {
    expect(match().ok).toBe(true);
    database
      .query('UPDATE arena_matches SET verdict = ? WHERE tournament_id = ?')
      .run('tie', created.id);

    expect(store.listTournaments()[0]?.matches).toEqual([]);
  });

  test('an unrecognised status reads as active, so its matches still reach the ladder', () => {
    database
      .query('UPDATE arena_tournaments SET status = ? WHERE id = ?')
      .run('completed', created.id);
    expect(store.listTournaments()[0]?.status).toBe('active');
  });
});
