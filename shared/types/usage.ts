/**
 * The usage log.
 *
 * One record per generation, appended as JSONL to a file in the home directory rather
 * than inside the library. The library moves (see location.ts) and may sit in a synced
 * folder; a reader outside this app cannot follow it there, and should not have to open
 * chats.db to answer "what did today cost". A fixed path it can tail is the whole point.
 *
 * The wire shape is snake_case and versioned because it is read by another program.
 * `UsageReport` — what the browser posts — stays camelCase like the rest of our API, and
 * the server translates. Only the server knows which connection a request actually used,
 * so `provider` is filled in there and never sent by the client.
 */

/** Which part of the app made the request. */
export type UsageFeature =
  | 'groupDirector'
  | 'groupProfiles'
  | 'chat'
  | 'summary'
  | 'memory'
  | 'cocreator'
  | 'arena'
  | 'persona'
  /** A message written as the user for the composer. Billed like any other generation. */
  | 'impersonate'
  /** A "Previously on…" recap. Read in an overlay; produces no swipe. */
  | 'recap';

export const USAGE_FEATURES: readonly UsageFeature[] = [
  'groupDirector',
  'groupProfiles',
  'chat',
  'summary',
  'memory',
  'cocreator',
  'arena',
  'persona',
  'impersonate',
  'recap',
];

export function isUsageFeature(value: unknown): value is UsageFeature {
  return typeof value === 'string' && (USAGE_FEATURES as readonly string[]).includes(value);
}

/** What the browser reports. The server resolves `provider` and writes the record. */
export interface UsageReport {
  /** The provider's response id when it gave one, else a uuid minted before the request. */
  id: string;
  /** ISO 8601. When the generation settled, not when it started. */
  ts: string;
  feature: UsageFeature;
  /** Chat id, arena round id, or co-creator session id. Absent where there is no run. */
  sessionId?: string;
  character?: string;
  connectionId?: string;
  model: string;
  /**
   * Prompt tokens with cached tokens already subtracted, so input and cache never
   * double-count. Zero when the provider reported no usage at all.
   */
  inputTokens: number;
  outputTokens: number;
  /** Thinking tokens. A subset of `outputTokens`, reported for visibility only. */
  reasoningTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  ttftMs?: number;
  /** True when `outputTokens` is our tokenizer's guess rather than the provider's count. */
  estimated: boolean;
  /** True when the user stopped the generation. It was still generated, and still billed. */
  aborted: boolean;
}

/** One line of usage.jsonl. */
export interface UsageRecord {
  v: 1;
  id: string;
  ts: string;
  feature: UsageFeature;
  session_id?: string;
  character?: string;
  provider?: string;
  connection_id?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  /**
   * Always 0 today: cache *writes* are an Anthropic-native concept, and we only ever
   * reach Anthropic through OpenRouter's OpenAI-compatible shape, which does not report
   * them. Present so the reader's column set does not have to change if that lands.
   */
  cache_write_tokens: number;
  duration_ms: number;
  ttft_ms?: number;
  estimated: boolean;
  aborted: boolean;
}

/** Where the log and the library pointer live. Joined onto the home directory. */
export const USAGE_DIR_NAME = '.wackchatter';
export const USAGE_LOG_NAME = 'usage.jsonl';
export const LIBRARY_POINTER_NAME = 'library.json';

/**
 * Rotate at 5 MB — roughly 20k generations, years of use. One generation back is kept
 * and the reader ignores it: re-ingestion is idempotent on `id`, so the worst a rotation
 * can cost is events missed while the reader was not running, which its own database
 * backfill covers.
 */
export const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
