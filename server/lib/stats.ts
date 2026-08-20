/**
 * Library statistics.
 *
 * Aggregated in SQL and never denormalised: there is no stats table, so a number cannot
 * drift from the transcripts it summarises. Message bodies are large — reasoning text
 * included — and the client holds no global chat list, so counting client-side would mean
 * one round trip per chat over full transcripts. It happens here instead.
 *
 * The store is built per request rather than memoised. It would otherwise be one more
 * thing anchored to a data directory that moves (see "The data directory moves" in
 * AGENTS.md); preparing a dozen statements for a screen the user opens by hand is not
 * worth the reset obligation.
 */

import type { Database } from 'bun:sqlite';
import type {
  CastEntry,
  CharacterStats,
  ChatEntry,
  Habits,
  HourBucket,
  ModelUsage,
  PersonaUsage,
  StatsOverview,
  Totals,
} from '../../shared/types/stats.ts';
import { SESSION_GAP_MS } from '../../shared/types/stats.ts';
import { listChatBackups } from './backups.ts';
import { getDb } from './db.ts';
import { PATHS } from './paths.ts';

/**
 * One row per swipe, with the JSON reached exactly once.
 *
 * `$character` is null for the whole library. Comparing a bound parameter against null in
 * the WHERE clause keeps one statement serving both the overview and a single card, rather
 * than two SQL strings that could drift apart.
 */
const SWIPES = `
  WITH swipe AS (
    SELECT
      m.position                                  AS position,
      m.is_user                                   AS isUser,
      m.is_system                                 AS isSystem,
      json_extract(s.value, '$.extra.model')      AS model,
      json_extract(s.value, '$.extra.api')        AS api,
      json_extract(s.value, '$.extra.token_count') AS tokens,
      json_extract(s.value, '$.extra.reasoning')  AS reasoning,
      json_extract(s.value, '$.gen_started')      AS genStarted,
      json_extract(s.value, '$.gen_finished')     AS genFinished
    FROM messages m, json_each(m.swipe_info) s, chats c
    WHERE c.id = m.chat_id AND ($character IS NULL OR c.character_id = $character)
  )`;

/** Milliseconds between two ISO timestamps, as SQLite sees them. */
const ELAPSED_MS = `
  (julianday(genFinished) - julianday(genStarted)) * 86400000.0`;

const TIMED = 'genStarted IS NOT NULL AND genFinished IS NOT NULL';

/** The text of the swipe currently on screen — what the transcript actually reads as. */
const SELECTED_TEXT = `json_extract(m.swipes, '$[' || m.swipe_id || ']')`;
const SELECTED_SENT = `json_extract(m.swipe_info, '$[' || m.swipe_id || '].send_date')`;

const CHAT_TOKENS = `
  (SELECT COALESCE(SUM(COALESCE(json_extract(s.value, '$.extra.token_count'), 0)), 0)
     FROM messages m, json_each(m.swipe_info) s
    WHERE m.chat_id = c.id)`;

const CHAT_MESSAGES = '(SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id)';

interface SwipeTotalsRow {
  swipes: number;
  tokens: number;
}

interface MessageTotalsRow {
  messages: number;
  userMessages: number;
  replies: number;
}

interface ModelRow {
  model: string;
  api: string | null;
  swipes: number;
  tokens: number;
  timed: number;
  totalMs: number;
  timedTokens: number;
}

interface HabitRow {
  rerolls: number;
  rerolledReplies: number;
  eligibleReplies: number;
  userChars: number;
  replyChars: number;
  longestReplyChars: number;
}

interface StampRow {
  chatId: string;
  ts: number | null;
}

/**
 * Sum the sittings in a run of message times, dropping the gaps between them.
 *
 * Wall-clock span would count the fortnight between two sessions as time spent; summing
 * only the gaps below the threshold answers the question actually being asked. A lone
 * message is a sitting of zero, which is honest — nothing is known about how long it took
 * to write.
 */
export function activeMs(runs: Iterable<readonly number[]>, gapMs = SESSION_GAP_MS): number {
  let total = 0;
  for (const run of runs) {
    for (let index = 1; index < run.length; index += 1) {
      const previous = run[index - 1];
      const current = run[index];
      if (previous === undefined || current === undefined) continue;
      const gap = current - previous;
      if (gap > 0 && gap <= gapMs) total += gap;
    }
  }
  return total;
}

function ratio(total: number, count: number): number {
  return count > 0 ? Math.round(total / count) : 0;
}

function toModelUsage(row: ModelRow): ModelUsage {
  const seconds = row.totalMs / 1000;
  return {
    model: row.model,
    api: row.api ?? '',
    swipes: row.swipes,
    tokens: row.tokens,
    avgLatencyMs: row.timed > 0 ? Math.round(row.totalMs / row.timed) : null,
    // Guarded on both ends: a swipe can be timed but carry no token count, and a run of
    // sub-millisecond timings would otherwise divide by zero into Infinity.
    tokensPerSecond:
      row.timed > 0 && seconds > 0 ? Math.round((row.timedTokens / seconds) * 10) / 10 : null,
  };
}

export interface StatsStore {
  overview(): StatsOverview;
  forCharacter(characterId: string): CharacterStats;
}

/**
 * Where deleted chats are counted from.
 * `null` skips the filesystem entirely (tests); undefined uses the default directory.
 */
export interface StatsStoreOptions {
  backupDir?: string | null;
}

export function createStatsStore(database: Database, options: StatsStoreOptions = {}): StatsStore {
  const backupDir = options.backupDir === undefined ? PATHS.backups : options.backupDir;

  const q = {
    chatCount: database.query<{ chats: number }, { $character: string | null }>(
      'SELECT COUNT(*) AS chats FROM chats c WHERE ($character IS NULL OR c.character_id = $character)',
    ),

    messageTotals: database.query<MessageTotalsRow, { $character: string | null }>(`
      SELECT
        COUNT(*) AS messages,
        COALESCE(SUM(m.is_user), 0) AS userMessages,
        COALESCE(SUM(CASE WHEN m.is_user = 0 AND m.is_system = 0 THEN 1 ELSE 0 END), 0) AS replies
      FROM messages m, chats c
      WHERE c.id = m.chat_id AND ($character IS NULL OR c.character_id = $character)`),

    swipeTotals: database.query<SwipeTotalsRow, { $character: string | null }>(`${SWIPES}
      SELECT COUNT(*) AS swipes, COALESCE(SUM(COALESCE(tokens, 0)), 0) AS tokens FROM swipe`),

    models: database.query<ModelRow, { $character: string | null }>(`${SWIPES}
      SELECT
        model,
        COALESCE(api, '') AS api,
        COUNT(*) AS swipes,
        COALESCE(SUM(COALESCE(tokens, 0)), 0) AS tokens,
        SUM(CASE WHEN ${TIMED} THEN 1 ELSE 0 END) AS timed,
        COALESCE(SUM(CASE WHEN ${TIMED} THEN ${ELAPSED_MS} ELSE 0 END), 0) AS totalMs,
        COALESCE(SUM(CASE WHEN ${TIMED} THEN COALESCE(tokens, 0) ELSE 0 END), 0) AS timedTokens
      FROM swipe
      WHERE model IS NOT NULL
      GROUP BY model, api
      ORDER BY swipes DESC, model ASC`),

    swipeHabits: database.query<
      { reasoningSwipes: number; timedSwipes: number },
      { $character: string | null }
    >(`${SWIPES}
      SELECT
        SUM(CASE WHEN reasoning IS NOT NULL AND reasoning <> '' THEN 1 ELSE 0 END) AS reasoningSwipes,
        SUM(CASE WHEN ${TIMED} THEN 1 ELSE 0 END) AS timedSwipes
      FROM swipe`),

    cast: database.query<CastEntry, []>(`
      SELECT
        c.character_id AS characterId,
        COUNT(*) AS chats,
        MIN(c.created) AS firstChat,
        MAX(c.modified) AS lastChat,
        COALESCE(SUM(${CHAT_MESSAGES}), 0) AS messages,
        COALESCE(SUM(${CHAT_TOKENS}), 0) AS tokens
      FROM chats c
      GROUP BY c.character_id
      ORDER BY messages DESC, chats DESC, characterId ASC`),

    personaChats: database.query<
      { personaId: string | null; chats: number },
      { $character: string | null }
    >(`
      SELECT json_extract(c.metadata, '$.persona') AS personaId, COUNT(*) AS chats
      FROM chats c
      WHERE ($character IS NULL OR c.character_id = $character)
      GROUP BY personaId`),

    personaMessages: database.query<
      { personaId: string | null; messages: number },
      { $character: string | null }
    >(`
      SELECT m.persona_id AS personaId, COUNT(*) AS messages
      FROM messages m, chats c
      WHERE c.id = m.chat_id AND m.is_user = 1
        AND ($character IS NULL OR c.character_id = $character)
      GROUP BY personaId`),

    /*
     * One point per message, taken from the selected swipe: a reply the user rerolled five
     * times happened once, and counting every alternate would draw five evenings that were
     * really one. Bucketed to the UTC hour — the client folds these into local days, which
     * is the only way a session at 23:30 lands on the right date across a DST boundary.
     */
    hours: database.query<{ hour: number; count: number }, { $character: string | null }>(`
      SELECT
        (CAST(strftime('%s', ${SELECTED_SENT}) AS INTEGER) / 3600) * 3600000 AS hour,
        COUNT(*) AS count
      FROM messages m, chats c
      WHERE c.id = m.chat_id AND ($character IS NULL OR c.character_id = $character)
        AND ${SELECTED_SENT} IS NOT NULL
      GROUP BY hour
      HAVING hour IS NOT NULL
      ORDER BY hour ASC`),

    /*
     * Greetings are excluded from every reroll figure. A card's alternate greetings arrive
     * as swipes on the message at position 0 (shared/chat/message.ts), so counting them
     * would report rerolls the user never made — on this library that alone is 131 of them.
     */
    habits: database.query<HabitRow, { $character: string | null }>(`
      SELECT
        COALESCE(SUM(CASE WHEN m.is_user = 0 AND m.position > 0
                          THEN json_array_length(m.swipes) - 1 ELSE 0 END), 0) AS rerolls,
        COALESCE(SUM(CASE WHEN m.is_user = 0 AND m.position > 0
                           AND json_array_length(m.swipes) > 1 THEN 1 ELSE 0 END), 0) AS rerolledReplies,
        COALESCE(SUM(CASE WHEN m.is_user = 0 AND m.is_system = 0 AND m.position > 0
                          THEN 1 ELSE 0 END), 0) AS eligibleReplies,
        COALESCE(SUM(CASE WHEN m.is_user = 1 THEN length(${SELECTED_TEXT}) ELSE 0 END), 0) AS userChars,
        COALESCE(SUM(CASE WHEN m.is_user = 0 AND m.is_system = 0
                          THEN length(${SELECTED_TEXT}) ELSE 0 END), 0) AS replyChars,
        COALESCE(MAX(CASE WHEN m.is_user = 0 AND m.is_system = 0
                          THEN length(${SELECTED_TEXT}) ELSE 0 END), 0) AS longestReplyChars
      FROM messages m, chats c
      WHERE c.id = m.chat_id AND ($character IS NULL OR c.character_id = $character)`),

    branches: database.query<{ branches: number }, { $character: string | null }>(`
      SELECT COUNT(*) AS branches FROM chats c
      WHERE c.title LIKE '% (branch)' AND ($character IS NULL OR c.character_id = $character)`),

    chatList: database.query<ChatEntry, { $character: string | null; $limit: number }>(`
      SELECT c.id, c.title, c.created, c.modified,
        ${CHAT_MESSAGES} AS messages,
        ${CHAT_TOKENS} AS tokens
      FROM chats c
      WHERE ($character IS NULL OR c.character_id = $character)
      ORDER BY messages DESC, c.modified DESC
      LIMIT $limit`),

    stamps: database.query<StampRow, { $character: string | null }>(`
      SELECT m.chat_id AS chatId,
             CAST(strftime('%s', ${SELECTED_SENT}) AS INTEGER) * 1000 AS ts
      FROM messages m, chats c
      WHERE c.id = m.chat_id AND ($character IS NULL OR c.character_id = $character)
      ORDER BY m.chat_id ASC, m.position ASC`),

    span: database.query<
      { firstChat: number | null; lastChat: number | null },
      { $character: string | null }
    >(`
      SELECT MIN(c.created) AS firstChat, MAX(c.modified) AS lastChat FROM chats c
      WHERE ($character IS NULL OR c.character_id = $character)`),

    coCreator: database.query<{ sessions: number }, []>(
      'SELECT COUNT(*) AS sessions FROM cocreator_sessions',
    ),
  };

  /** Group the ordered stamps back into one run per chat, so gaps are measured within a chat. */
  function runs(character: string | null): number[][] {
    const byChat = new Map<string, number[]>();
    for (const row of q.stamps.all({ $character: character })) {
      if (row.ts === null) continue;
      const run = byChat.get(row.chatId);
      if (run) run.push(row.ts);
      else byChat.set(row.chatId, [row.ts]);
    }
    return [...byChat.values()];
  }

  function totals(character: string | null): Totals {
    const args = { $character: character };
    const messages = q.messageTotals.get(args);
    const swipes = q.swipeTotals.get(args);
    return {
      chats: q.chatCount.get(args)?.chats ?? 0,
      messages: messages?.messages ?? 0,
      userMessages: messages?.userMessages ?? 0,
      replies: messages?.replies ?? 0,
      swipes: swipes?.swipes ?? 0,
      tokens: swipes?.tokens ?? 0,
      activeMinutes: Math.round(activeMs(runs(character)) / 60000),
    };
  }

  function models(character: string | null): ModelUsage[] {
    return q.models.all({ $character: character }).map(toModelUsage);
  }

  /** A chat or message with no recorded persona folds into the empty id — "no persona". */
  function personas(character: string | null): PersonaUsage[] {
    const args = { $character: character };
    const merged = new Map<string, PersonaUsage>();
    const entry = (id: string | null): PersonaUsage => {
      const key = id ?? '';
      let found = merged.get(key);
      if (!found) {
        found = { personaId: key, chats: 0, messages: 0 };
        merged.set(key, found);
      }
      return found;
    };

    for (const row of q.personaChats.all(args)) entry(row.personaId).chats += row.chats;
    for (const row of q.personaMessages.all(args)) entry(row.personaId).messages += row.messages;

    return [...merged.values()].sort(
      (left, right) => right.messages - left.messages || right.chats - left.chats,
    );
  }

  function hours(character: string | null): HourBucket[] {
    return q.hours.all({ $character: character }).map((row) => [row.hour, row.count]);
  }

  function habits(character: string | null, counts: MessageTotalsRow): Habits {
    const args = { $character: character };
    const row = q.habits.get(args);
    const swipes = q.swipeHabits.get(args);
    const deleted = backupDir ? listChatBackups(character ?? undefined, backupDir).length : 0;

    return {
      rerolls: row?.rerolls ?? 0,
      rerolledReplies: row?.rerolledReplies ?? 0,
      eligibleReplies: row?.eligibleReplies ?? 0,
      avgUserChars: ratio(row?.userChars ?? 0, counts.userMessages),
      avgReplyChars: ratio(row?.replyChars ?? 0, counts.replies),
      longestReplyChars: row?.longestReplyChars ?? 0,
      reasoningSwipes: swipes?.reasoningSwipes ?? 0,
      timedSwipes: swipes?.timedSwipes ?? 0,
      branchedChats: q.branches.get(args)?.branches ?? 0,
      deletedChats: deleted,
    };
  }

  const EMPTY_COUNTS: MessageTotalsRow = { messages: 0, userMessages: 0, replies: 0 };

  return {
    overview(): StatsOverview {
      const counts = q.messageTotals.get({ $character: null }) ?? EMPTY_COUNTS;
      return {
        totals: totals(null),
        cast: q.cast.all(),
        models: models(null),
        personas: personas(null),
        hours: hours(null),
        habits: habits(null, counts),
        longestChat: q.chatList.get({ $character: null, $limit: 1 }) ?? null,
        coCreatorSessions: q.coCreator.get()?.sessions ?? 0,
        generatedAt: Date.now(),
      };
    },

    forCharacter(characterId: string): CharacterStats {
      const counts = q.messageTotals.get({ $character: characterId }) ?? EMPTY_COUNTS;
      const span = q.span.get({ $character: characterId });
      return {
        characterId,
        totals: totals(characterId),
        // Capped: the leaderboard is a top list, and a card with hundreds of chats should
        // not turn a stats request into a full library dump.
        chats: q.chatList.all({ $character: characterId, $limit: 50 }),
        models: models(characterId),
        personas: personas(characterId),
        hours: hours(characterId),
        habits: habits(characterId, counts),
        firstChat: span?.firstChat ?? null,
        lastChat: span?.lastChat ?? null,
        generatedAt: Date.now(),
      };
    },
  };
}

/** The application stats store. Tests build their own against an in-memory database. */
export function statsStore(): StatsStore {
  return createStatsStore(getDb());
}
