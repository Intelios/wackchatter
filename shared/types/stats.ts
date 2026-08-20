/**
 * Library statistics.
 *
 * Everything here is derived from chats.db at request time — there is no stats table and
 * nothing is denormalised, so a number on screen can never disagree with the transcripts
 * it summarises. The server returns ids and counts only; the client resolves character and
 * persona names from the lists it already holds, and falls back to the raw id for one that
 * no longer exists.
 */

/** [epoch ms at the start of a UTC hour, messages sent in it]. Ascending, gaps omitted. */
export type HourBucket = [number, number];

/** Messages closer together than this are one sitting. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface ModelUsage {
  model: string;
  /**
   * Provider id exactly as recorded. This is a ProviderId, never a connection name, and
   * legacy rows carry values outside the current union ('openai') — render it verbatim
   * rather than dropping the row.
   */
  api: string;
  swipes: number;
  /**
   * Completion tokens only, and often our own estimate rather than reported usage.
   * There is no prompt-token history, so this can never become a cost.
   */
  tokens: number;
  /** Mean wall-clock generation time, over swipes that recorded both ends. */
  avgLatencyMs: number | null;
  /** Mean completion tokens per second. Null when nothing was timed. */
  tokensPerSecond: number | null;
}

export interface CastEntry {
  /** The character's avatar filename — the identity. */
  characterId: string;
  chats: number;
  messages: number;
  tokens: number;
  firstChat: number;
  lastChat: number;
}

export interface PersonaUsage {
  /** A persona id, or the empty string for messages sent with no persona. */
  personaId: string;
  /** Chats whose recorded persona is this one. */
  chats: number;
  /** User messages sent as this persona. */
  messages: number;
}

export interface ChatEntry {
  id: string;
  title: string;
  messages: number;
  tokens: number;
  created: number;
  modified: number;
}

export interface Habits {
  /**
   * Rerolls, counted as swipes beyond the first. Greetings are excluded: a card's
   * alternate greetings arrive as swipes on the message at position 0, so counting them
   * would report a reroll the user never made.
   */
  rerolls: number;
  /** Replies that were rerolled at least once. */
  rerolledReplies: number;
  /** Replies that could have been rerolled — the denominator for the rate. */
  eligibleReplies: number;
  avgUserChars: number;
  avgReplyChars: number;
  longestReplyChars: number;
  /** Swipes that came back with reasoning text. */
  reasoningSwipes: number;
  timedSwipes: number;
  branchedChats: number;
  deletedChats: number;
}

export interface Totals {
  chats: number;
  messages: number;
  userMessages: number;
  replies: number;
  swipes: number;
  tokens: number;
  /** Summed sittings, gaps above SESSION_GAP_MS excluded. */
  activeMinutes: number;
}

export interface StatsOverview {
  totals: Totals;
  /** Descending by messages. */
  cast: CastEntry[];
  /** Descending by swipes. */
  models: ModelUsage[];
  /** Descending by messages. */
  personas: PersonaUsage[];
  hours: HourBucket[];
  habits: Habits;
  longestChat: ChatEntry | null;
  /** Co-Creator design sessions, which live outside the chats table. */
  coCreatorSessions: number;
  generatedAt: number;
}

export interface CharacterStats {
  characterId: string;
  totals: Totals;
  /** Descending by messages. */
  chats: ChatEntry[];
  models: ModelUsage[];
  personas: PersonaUsage[];
  hours: HourBucket[];
  habits: Habits;
  firstChat: number | null;
  lastChat: number | null;
  generatedAt: number;
}
