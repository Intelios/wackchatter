/**
 * The usage log.
 *
 * One record per generation, appended as JSONL to a file in the home directory rather
 * than inside the library. The library moves (see location.ts) and may sit in a synced
 * folder; a reader outside this app cannot follow it there, and should not have to open
 * chats.db to answer "what did today cost". Monthly per-process segments under ~/.wackchatter/usage/v2 retain the ledger indefinitely.
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
  | 'presetCocreator'
  | 'presetTest'
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
  'presetCocreator',
  'presetTest',
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
  /** Stable UUID minted for this generation and shared with its stored swipe. */
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
  outcome?: 'completed' | 'failed' | 'cancelled' | 'unknown';
  aborted: boolean;
}

/** One retained v2 ledger record. */
export interface UsageRecord {
  v: 2;
  library_id: string;
  provider_name?: string;
  outcome: 'completed' | 'failed' | 'cancelled' | 'unknown';
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

/** Legacy v1 rotation threshold, retained for migration tests only. v2 never rotates away history. */
export const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
