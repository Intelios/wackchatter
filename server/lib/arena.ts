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
import type { ArenaRound, RoundSide, RoundUsage, Verdict } from '../../shared/types/arena.ts';
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

interface UsageRow {
  round_id: string;
  side: string;
  connection_id: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  ms: number | null;
  first_token_ms: number | null;
}

/** A count or a duration: a finite, non-negative whole number, or null. */
function measure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function normalizeUsage(value: unknown): RoundUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.connectionId !== 'string' || !usage.connectionId) return undefined;
  return {
    connectionId: usage.connectionId,
    promptTokens: measure(usage.promptTokens),
    completionTokens: measure(usage.completionTokens),
    ms: measure(usage.ms),
    firstTokenMs: measure(usage.firstTokenMs),
  };
}

function rowToUsage(row: UsageRow): RoundUsage {
  return {
    connectionId: row.connection_id,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    ms: row.ms,
    firstTokenMs: row.first_token_ms,
  };
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
  const usage = normalizeUsage(value?.usage);
  return {
    contenderId: text(value?.contenderId),
    model: text(value?.model),
    provider: text(value?.provider),
    text: text(value?.text),
    ...(usage ? { usage } : {}),
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
    selectUsage: database.query<UsageRow, []>('SELECT * FROM arena_round_usage'),
    insertUsage: database.query(
      `INSERT INTO arena_round_usage (
         round_id, side, connection_id, prompt_tokens, completion_tokens, ms, first_token_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    // The usage rows go first and by hand: ON DELETE CASCADE only fires on a connection
    // with foreign_keys on, and a store must not depend on who opened its database.
    deleteUsage: database.query('DELETE FROM arena_round_usage WHERE round_id = ?'),
    deleteUsageByContender: database.query(
      `DELETE FROM arena_round_usage WHERE round_id IN
         (SELECT id FROM arena_rounds WHERE left_id = ? OR right_id = ?)`,
    ),
    clearUsage: database.query('DELETE FROM arena_round_usage'),
    delete: database.query('DELETE FROM arena_rounds WHERE id = ?'),
    deleteByContender: database.query('DELETE FROM arena_rounds WHERE left_id = ? OR right_id = ?'),
    clear: database.query('DELETE FROM arena_rounds'),
    count: database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM arena_rounds'),
  };

  return {
    listRounds(): ArenaRound[] {
      const usage = new Map<string, RoundUsage>();
      for (const row of statements.selectUsage.all()) {
        usage.set(`${row.round_id}:${row.side}`, rowToUsage(row));
      }
      return statements.selectAll.all().map((row) => {
        const round = rowToRound(row);
        const left = usage.get(`${round.id}:left`);
        const right = usage.get(`${round.id}:right`);
        if (left) round.left.usage = left;
        if (right) round.right.usage = right;
        return round;
      });
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

      const write = database.transaction(() => {
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
        for (const [name, side] of [
          ['left', round.left],
          ['right', round.right],
        ] as const) {
          const usage = side.usage;
          if (!usage) continue;
          statements.insertUsage.run(
            round.id,
            name,
            usage.connectionId,
            usage.promptTokens,
            usage.completionTokens,
            usage.ms,
            usage.firstTokenMs,
          );
        }
      });
      write();

      return round;
    },

    deleteRound(id): boolean {
      statements.deleteUsage.run(id);
      return statements.delete.run(id).changes > 0;
    },

    deleteContender(contenderId): number {
      statements.deleteUsageByContender.run(contenderId, contenderId);
      return statements.deleteByContender.run(contenderId, contenderId).changes;
    },

    clearRounds(): number {
      const { count } = statements.count.get() ?? { count: 0 };
      statements.clearUsage.run();
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
