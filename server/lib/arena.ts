/**
 * Model Arena round storage.
 *
 * Far smaller than the chat and Co-Creator stores, and the differences are the point:
 *
 *  - **A round is written once and never edited**, so there is no revision to arbitrate
 *    and no whole-document write. An abandoned round is simply never recorded.
 *  - **A delete writes no backup.** A transcript is irreplaceable prose; a round is a
 *    measurement, and one you can always take again. Same call the Co-Creator makes about
 *    design sessions — do not "fix" the asymmetry.
 *  - **There is no ratings table.** Nothing here aggregates. The leaderboard replays these
 *    rows in order client-side, which is what makes a rating impossible to drift from the
 *    rounds behind it and lets the K-factor change without invalidating history.
 *
 * Values are coerced on the way in rather than trusted, so a malformed body cannot leave a
 * row the replay would have to defend itself against.
 */

import type { Database } from 'bun:sqlite';
import type { ArenaRound, RoundSide, Verdict } from '../../shared/types/arena.ts';
import { getDb } from './db.ts';

const VERDICTS: readonly Verdict[] = ['left', 'right', 'tie', 'bad'];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

interface RoundRow {
  id: string;
  created: number;
  character_id: string;
  probe: string;
  left_id: string;
  left_model: string;
  left_provider: string;
  left_text: string;
  right_id: string;
  right_model: string;
  right_provider: string;
  right_text: string;
  verdict: string;
}

/** What a caller supplies. The id and timestamp are the server's to mint. */
export interface RoundInput {
  characterId: string;
  probe: string;
  left: RoundSide;
  right: RoundSide;
  verdict: Verdict;
}

export interface ArenaStore {
  /** Every round, oldest first — the order the leaderboard replays them in. */
  listRounds(): ArenaRound[];
  recordRound(input: RoundInput): ArenaRound;
  deleteRound(id: string): boolean;
  /** Delete all rounds where a contender fought. Returns how many rounds went. */
  deleteContender(contenderId: string): number;
  /** Empty the history. Returns how many rounds went. */
  clearRounds(): number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowToRound(row: RoundRow): ArenaRound {
  return {
    id: row.id,
    created: row.created,
    characterId: row.character_id,
    probe: row.probe,
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
    // Coerced on read as well as on write: a row hand-edited into the database must not
    // reach the replay as an unrecognised verdict it would silently ignore.
    verdict: isVerdict(row.verdict) ? row.verdict : 'bad',
  };
}

function normalizeSide(value: RoundSide | undefined): RoundSide {
  return {
    contenderId: text(value?.contenderId),
    model: text(value?.model),
    provider: text(value?.provider),
    text: text(value?.text),
  };
}

export function createArenaStore(database: Database): ArenaStore {
  const statements = {
    selectAll: database.query<RoundRow, []>('SELECT * FROM arena_rounds ORDER BY created ASC'),
    insert: database.query(
      `INSERT INTO arena_rounds (
         id, created, character_id, probe,
         left_id, left_model, left_provider, left_text,
         right_id, right_model, right_provider, right_text,
         verdict
       ) VALUES (
         $id, $created, $characterId, $probe,
         $leftId, $leftModel, $leftProvider, $leftText,
         $rightId, $rightModel, $rightProvider, $rightText,
         $verdict
       )`,
    ),
    delete: database.query('DELETE FROM arena_rounds WHERE id = ?'),
    deleteByContender: database.query('DELETE FROM arena_rounds WHERE left_id = ? OR right_id = ?'),
    clear: database.query('DELETE FROM arena_rounds'),
    count: database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM arena_rounds'),
  };

  return {
    listRounds(): ArenaRound[] {
      return statements.selectAll.all().map(rowToRound);
    },

    recordRound(input): ArenaRound {
      const round: ArenaRound = {
        id: crypto.randomUUID(),
        created: Date.now(),
        characterId: text(input.characterId),
        probe: text(input.probe),
        left: normalizeSide(input.left),
        right: normalizeSide(input.right),
        verdict: isVerdict(input.verdict) ? input.verdict : 'bad',
      };

      statements.insert.run({
        $id: round.id,
        $created: round.created,
        $characterId: round.characterId,
        $probe: round.probe,
        $leftId: round.left.contenderId,
        $leftModel: round.left.model,
        $leftProvider: round.left.provider,
        $leftText: round.left.text,
        $rightId: round.right.contenderId,
        $rightModel: round.right.model,
        $rightProvider: round.right.provider,
        $rightText: round.right.text,
        $verdict: round.verdict,
      });

      return round;
    },

    deleteRound(id): boolean {
      return statements.delete.run(id).changes > 0;
    },

    deleteContender(contenderId): number {
      return statements.deleteByContender.run(contenderId, contenderId).changes;
    },

    clearRounds(): number {
      const { count } = statements.count.get() ?? { count: 0 };
      statements.clear.run();
      return count;
    },
  };
}

let store: ArenaStore | null = null;

/** The application round store. Tests build their own against an in-memory database. */
export function arenaStore(): ArenaStore {
  if (!store?.deleteContender) store = createArenaStore(getDb());
  return store;
}

/**
 * Drop the memoized store, so the next call rebuilds it against the current data directory.
 *
 * It holds prepared statements bound to one connection, so `quiesce()` must call this
 * *before* `closeDatabase()` — the same ordering, and the same reason, as `resetChatStore`.
 */
export function resetArenaStore(): void {
  store = null;
}
