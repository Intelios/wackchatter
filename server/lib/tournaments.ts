/**
 * Model Arena tournament storage.
 *
 * Two halves, and the split is the same one `arena_rounds` makes:
 *
 *  - **`arena_tournaments` is the plan.** Who entered, which card and cue each stage uses,
 *    and whether the bracket is still active. It is the only Arena thing that may be
 *    edited, and only in the two ways a plan can honestly change: its name, and being
 *    abandoned. Who advanced to a later stage is *not* here — that is derived by replaying
 *    the matches, so a bracket position cannot drift from the match that earned it.
 *  - **`arena_matches` is evidence.** Written once, never updated. There is no standings
 *    table: the career ladder replays these rows, exactly as the leaderboard replays rounds.
 *
 * A match's `verdict` is only ever `left` or `right`. A dead heat is re-rolled once and then
 * judged, so `tie`/`bad` are consumed by that flow and never become advancement evidence.
 *
 * Values are coerced on the way in and parsed defensively on the way out, so a malformed
 * body or a hand-edited row cannot leave the replay defending itself.
 */

import type { Database } from 'bun:sqlite';
import type {
  RoundSide,
  Tournament,
  TournamentMatch,
  TournamentSize,
  TournamentStage,
  TournamentStatus,
  TournamentVerdict,
  TournamentWithMatches,
} from '../../shared/types/arena.ts';
import { TOURNAMENT_SIZES } from '../../shared/types/arena.ts';
import { getDb } from './db.ts';

export function isTournamentStatus(value: unknown): value is TournamentStatus {
  return value === 'active' || value === 'abandoned';
}

export function isTournamentSize(value: unknown): value is TournamentSize {
  return typeof value === 'number' && (TOURNAMENT_SIZES as readonly number[]).includes(value);
}

export function isTournamentVerdict(value: unknown): value is TournamentVerdict {
  return value === 'left' || value === 'right';
}

interface TournamentRow {
  id: string;
  created: number;
  name: string;
  status: string;
  size: number;
  entrants: string;
  stages: string;
}

interface MatchRow {
  id: string;
  tournament_id: string;
  created: number;
  stage: number;
  match_index: number;
  character_id: string;
  cue: string;
  left_id: string;
  left_model: string;
  left_provider: string;
  left_text: string;
  right_id: string;
  right_model: string;
  right_provider: string;
  right_text: string;
  verdict: string;
  rerolled: number;
}

/** What a caller supplies at creation. The id and timestamp are the server's to mint. */
export interface TournamentInput {
  name: string;
  size: TournamentSize;
  entrants: string[];
  stages: TournamentStage[];
}

/** The only two fields a plan may change. An absent field is left alone. */
export interface TournamentPatch {
  name?: string;
  status?: TournamentStatus;
}

/** What a caller supplies to record a match. The id and timestamp are the server's. */
export interface MatchInput {
  tournamentId: string;
  stage: number;
  matchIndex: number;
  left: RoundSide;
  right: RoundSide;
  verdict: TournamentVerdict;
  rerolled: boolean;
}

export type RecordMatchResult =
  | { ok: true; match: TournamentMatch }
  | { ok: false; error: 'tournament-not-found' | 'stage-missing' | 'slot-taken' };

export interface TournamentStore {
  /** Every tournament with its matches, oldest first. */
  listTournaments(): TournamentWithMatches[];
  getTournament(id: string): Tournament | null;
  createTournament(input: TournamentInput): Tournament;
  /** Rename and/or abandon. Returns null when the tournament is gone. */
  updateTournament(id: string, patch: TournamentPatch): Tournament | null;
  /** Delete a tournament and its matches. Returns false when it was already gone. */
  deleteTournament(id: string): boolean;
  recordMatch(input: MatchInput): RecordMatchResult;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSide(value: RoundSide | undefined): RoundSide {
  return {
    contenderId: text(value?.contenderId),
    model: text(value?.model),
    provider: text(value?.provider),
    text: text(value?.text),
  };
}

/** Entrant ids as written, minus anything that is not a non-empty string. Deduplicated. */
function parseEntrants(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Stage plans as written. Blank entries are kept rather than filtered: a stage's *index* is
 * what a match refers to, so dropping one would silently shift every later stage under it.
 */
function parseStages(value: string): TournamentStage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    const stage = (entry ?? {}) as Record<string, unknown>;
    return { characterId: text(stage.characterId), cue: text(stage.cue) };
  });
}

function rowToTournament(row: TournamentRow): Tournament {
  return {
    id: row.id,
    created: row.created,
    name: row.name,
    // An unrecognised status reads as active: refusing to show a tournament because its
    // flag is corrupt would hide its matches from the ladder, and they are the evidence.
    status: isTournamentStatus(row.status) ? row.status : 'active',
    size: isTournamentSize(row.size) ? row.size : 4,
    entrants: parseEntrants(row.entrants),
    stages: parseStages(row.stages),
  };
}

function rowToMatch(row: MatchRow): TournamentMatch | null {
  /*
   * There is no legal "no winner" value in a stored match, so a row whose verdict is not
   * left/right cannot advance anyone. It is omitted rather than assigned a winner it never
   * chose — `arena_rounds` coerces an unknown verdict to `bad` because `bad` is a real
   * outcome there; here it is not.
   */
  if (!isTournamentVerdict(row.verdict)) return null;

  return {
    id: row.id,
    tournamentId: row.tournament_id,
    created: row.created,
    stage: row.stage,
    matchIndex: row.match_index,
    characterId: row.character_id,
    cue: row.cue,
    left: {
      contenderId: row.left_id,
      model: row.left_model,
      provider: row.left_provider,
      text: row.left_text,
    },
    right: {
      contenderId: row.right_id,
      model: row.right_model,
      provider: row.right_provider,
      text: row.right_text,
    },
    verdict: row.verdict,
    rerolled: row.rerolled !== 0,
  };
}

function stageJson(stages: readonly TournamentStage[]): string {
  return JSON.stringify(
    stages.map((stage) => ({ characterId: text(stage.characterId), cue: text(stage.cue) })),
  );
}

export function createTournamentStore(database: Database): TournamentStore {
  const statements = {
    selectAll: database.query<TournamentRow, []>(
      'SELECT * FROM arena_tournaments ORDER BY created ASC, rowid ASC',
    ),
    selectOne: database.query<TournamentRow, [string]>(
      'SELECT * FROM arena_tournaments WHERE id = ?',
    ),
    insert: database.query(
      `INSERT INTO arena_tournaments (id, created, name, status, size, entrants, stages)
       VALUES ($id, $created, $name, $status, $size, $entrants, $stages)`,
    ),
    update: database.query(
      'UPDATE arena_tournaments SET name = $name, status = $status WHERE id = $id',
    ),
    remove: database.query('DELETE FROM arena_tournaments WHERE id = ?'),
    selectMatches: database.query<MatchRow, []>(
      'SELECT * FROM arena_matches ORDER BY created ASC, rowid ASC',
    ),
    insertMatch: database.query(
      `INSERT INTO arena_matches (
         id, tournament_id, created, stage, match_index, character_id, cue,
         left_id, left_model, left_provider, left_text,
         right_id, right_model, right_provider, right_text,
         verdict, rerolled
       ) VALUES (
         $id, $tournamentId, $created, $stage, $matchIndex, $characterId, $cue,
         $leftId, $leftModel, $leftProvider, $leftText,
         $rightId, $rightModel, $rightProvider, $rightText,
         $verdict, $rerolled
       )`,
    ),
    slotTaken: database.query<{ id: string }, [string, number, number]>(
      'SELECT id FROM arena_matches WHERE tournament_id = ? AND stage = ? AND match_index = ?',
    ),
  };

  return {
    listTournaments(): TournamentWithMatches[] {
      const matchesByTournament = new Map<string, TournamentMatch[]>();
      for (const row of statements.selectMatches.all()) {
        const match = rowToMatch(row);
        if (!match) continue;
        const list = matchesByTournament.get(match.tournamentId);
        if (list) list.push(match);
        else matchesByTournament.set(match.tournamentId, [match]);
      }

      return statements.selectAll.all().map((row) => ({
        ...rowToTournament(row),
        matches: matchesByTournament.get(row.id) ?? [],
      }));
    },

    getTournament(id): Tournament | null {
      const row = statements.selectOne.get(id);
      return row ? rowToTournament(row) : null;
    },

    createTournament(input): Tournament {
      const tournament: Tournament = {
        id: crypto.randomUUID(),
        created: Date.now(),
        name: text(input.name).trim(),
        status: 'active',
        size: input.size,
        entrants: [...input.entrants],
        stages: input.stages.map((stage) => ({
          characterId: text(stage.characterId),
          cue: text(stage.cue),
        })),
      };

      statements.insert.run({
        $id: tournament.id,
        $created: tournament.created,
        $name: tournament.name,
        $status: tournament.status,
        $size: tournament.size,
        $entrants: JSON.stringify(tournament.entrants),
        $stages: stageJson(tournament.stages),
      });

      return tournament;
    },

    updateTournament(id, patch): Tournament | null {
      const existing = statements.selectOne.get(id);
      if (!existing) return null;

      const name = patch.name !== undefined ? text(patch.name).trim() : existing.name;
      const status = patch.status !== undefined ? patch.status : existing.status;
      statements.update.run({ $id: id, $name: name, $status: status });

      return rowToTournament({ ...existing, name, status });
    },

    deleteTournament(id): boolean {
      // Matches go with it through ON DELETE CASCADE, which the connection enables. That is
      // deliberate here — a deleted tournament was explicitly discarded, and its ladder
      // points should go the same way. Deleting a *contender*, by contrast, never cascades.
      return statements.remove.run(id).changes > 0;
    },

    recordMatch(input): RecordMatchResult {
      const tournament = statements.selectOne.get(input.tournamentId);
      if (!tournament) return { ok: false, error: 'tournament-not-found' };

      /*
       * The card and cue come from the stage plan, not the caller: the plan is the authority
       * on what a stage asked, and taking the client's word would let a match claim a
       * question the tournament never posed.
       */
      const plan = rowToTournament(tournament).stages[input.stage];
      if (!plan) return { ok: false, error: 'stage-missing' };

      if (statements.slotTaken.get(input.tournamentId, input.stage, input.matchIndex)) {
        return { ok: false, error: 'slot-taken' };
      }

      const match: TournamentMatch = {
        id: crypto.randomUUID(),
        tournamentId: input.tournamentId,
        created: Date.now(),
        stage: input.stage,
        matchIndex: input.matchIndex,
        characterId: plan.characterId,
        cue: plan.cue,
        left: normalizeSide(input.left),
        right: normalizeSide(input.right),
        verdict: isTournamentVerdict(input.verdict) ? input.verdict : 'left',
        rerolled: input.rerolled === true,
      };

      statements.insertMatch.run({
        $id: match.id,
        $tournamentId: match.tournamentId,
        $created: match.created,
        $stage: match.stage,
        $matchIndex: match.matchIndex,
        $characterId: match.characterId,
        $cue: match.cue,
        $leftId: match.left.contenderId,
        $leftModel: match.left.model,
        $leftProvider: match.left.provider,
        $leftText: match.left.text,
        $rightId: match.right.contenderId,
        $rightModel: match.right.model,
        $rightProvider: match.right.provider,
        $rightText: match.right.text,
        $verdict: match.verdict,
        $rerolled: match.rerolled ? 1 : 0,
      });

      return { ok: true, match };
    },
  };
}

let store: TournamentStore | null = null;

/** The application tournament store. Tests build their own against an in-memory database. */
export function tournamentStore(): TournamentStore {
  if (!store) store = createTournamentStore(getDb());
  return store;
}

/**
 * Drop the memoized store, so the next call rebuilds it against the current data directory.
 *
 * It holds prepared statements bound to one connection, so `quiesce()` must call this
 * *before* `closeDatabase()` — the same ordering, and the same reason, as `resetArenaStore`.
 */
export function resetTournamentStore(): void {
  store = null;
}
