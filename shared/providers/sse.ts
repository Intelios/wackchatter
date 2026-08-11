/**
 * Server-sent event parsing and delta accumulation.
 *
 * The server pipes the provider's stream through untouched, so this is where the wire
 * format is actually understood. Both halves are pure and incremental:
 *
 *  - `createSseParser` handles framing. Network chunks split anywhere, including mid-JSON
 *    and mid-frame-separator, so it buffers until it sees a real terminator.
 *  - `createStreamAccumulator` handles semantics, and returns the FULL accumulated text
 *    on every frame rather than the delta. That is what makes a throttled UI safe: a
 *    consumer assigns instead of appending, so dropping frames can never lose content.
 */

export interface SseFrame {
  event?: string;
  data: string;
}

export interface SseParser {
  push(chunk: string): SseFrame[];
  /** Emit anything left in the buffer at end-of-stream. */
  flush(): SseFrame[];
}

/** Frame separator: blank line in any of the three line-ending conventions. */
const FRAME_SEPARATOR = /\r\n\r\n|\r\r|\n\n/;
const LINE_SEPARATOR = /\r\n|\r|\n/;

function parseBlock(block: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of block.split(LINE_SEPARATOR)) {
    if (!line) continue;
    // A line starting with ':' is a comment. OpenRouter sends ": OPENROUTER PROCESSING"
    // as a keepalive; treating it as a malformed frame kills the stream.
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single space after the colon is part of the framing, not the value.
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }

  // A block with no data field carries nothing — comments and keepalives land here.
  if (data.length === 0) return null;

  const frame: SseFrame = { data: data.join('\n') };
  if (event !== undefined) frame.event = event;
  return frame;
}

export function createSseParser(): SseParser {
  let buffer = '';

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const frames: SseFrame[] = [];

      while (true) {
        const match = FRAME_SEPARATOR.exec(buffer);
        if (!match) break;

        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const frame = parseBlock(block);
        if (frame) frames.push(frame);
      }

      return frames;
    },

    flush(): SseFrame[] {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const frame = parseBlock(buffer);
      buffer = '';
      return frame ? [frame] : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** One completion. With `n: 1` — the overwhelming case — there is only ever the first. */
export interface StreamChoice {
  /** The FULL text so far, never a delta. */
  content: string;
  reasoning: string;
  finishReason: string | null;
}

export interface StreamState {
  /** The FULL text so far, never a delta. Always choice 0 — the reply on screen. */
  content: string;
  reasoning: string;
  finishReason: string | null;
  model?: string;
  usage?: StreamUsage;
  done: boolean;
  /** Set when the provider reported an error inside an otherwise-200 stream. */
  error?: string;
  /**
   * Completions AFTER the first, in provider index order. Absent unless `n > 1` was both
   * asked for and honoured, so every existing consumer sees exactly what it saw before.
   *
   * Entries may be blank: a provider is free to return fewer completions than requested,
   * and gaps are filled rather than renumbered so an index always means the same choice.
   * Callers that turn these into something durable are expected to drop the empty ones.
   */
  alternates?: StreamChoice[];
}

export interface StreamAccumulator {
  /** Returns the new full state if the frame changed anything, else null. */
  push(frame: SseFrame): StreamState | null;
  snapshot(): StreamState;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Pull an error message out of the several shapes providers use for it. */
export function extractError(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;

  const error = root.error;
  if (typeof error === 'string') return error;

  const record = asRecord(error);
  if (record && typeof record.message === 'string') return record.message;

  if (typeof root.message === 'string' && root.error !== undefined) return root.message;
  return null;
}

function readUsage(value: unknown): StreamUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const result: StreamUsage = {};
  if (typeof usage.prompt_tokens === 'number') result.prompt_tokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') {
    result.completion_tokens = usage.completion_tokens;
  }
  if (typeof usage.total_tokens === 'number') result.total_tokens = usage.total_tokens;
  return Object.keys(result).length ? result : undefined;
}

/**
 * An upper bound on how many completions a stream may open.
 *
 * Purely a guard against a malformed `index` allocating an unbounded array; no provider
 * offers anything near it, and the UI asks for far fewer.
 */
const MAX_CHOICES = 64;

function blankChoice(content = ''): StreamChoice {
  return { content, reasoning: '', finishReason: null };
}

/**
 * Which completion a chunk belongs to.
 *
 * Defaulting to 0 is what keeps single-choice streams working on proxies that omit
 * `index` entirely — the common case, and the one that must not regress.
 */
function choiceIndex(choice: Record<string, unknown>): number {
  const index = choice.index;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_CHOICES
    ? index
    : 0;
}

/**
 * @param seed Existing text to build on. Used by `continue`, where the reply extends a
 *   message that already has content. It seeds choice 0 only: `continue` writes back into
 *   one existing swipe, so it never asks for alternates in the first place.
 */
export function createStreamAccumulator(seed = ''): StreamAccumulator {
  /**
   * Index-parallel with the provider's `choice.index`, which is the only stable handle on
   * which completion a chunk belongs to. Chunks for different choices interleave freely,
   * so taking `choices[0]` of each chunk — as this did while `n` was pinned to 1 — would
   * splice several replies into one.
   */
  const choices: StreamChoice[] = [blankChoice(seed)];
  const state = {
    model: undefined as string | undefined,
    usage: undefined as StreamUsage | undefined,
    done: false,
    error: undefined as string | undefined,
  };

  function choiceAt(index: number): StreamChoice {
    while (choices.length <= index) choices.push(blankChoice());
    return choices[index]!;
  }

  function snapshot(): StreamState {
    // A fresh object each time: consumers hold onto these across renders.
    const primary = choices[0]!;
    const result: StreamState = {
      content: primary.content,
      reasoning: primary.reasoning,
      finishReason: primary.finishReason,
      done: state.done,
      usage: state.usage ? { ...state.usage } : undefined,
    };
    if (state.model !== undefined) result.model = state.model;
    if (state.error !== undefined) result.error = state.error;
    if (choices.length > 1) result.alternates = choices.slice(1).map((choice) => ({ ...choice }));
    return result;
  }

  return {
    snapshot,

    push(frame: SseFrame): StreamState | null {
      const data = frame.data.trim();
      if (!data) return null;

      if (data === '[DONE]') {
        if (state.done) return null;
        state.done = true;
        return snapshot();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Not JSON. Providers occasionally emit stray keepalive text; ignoring it is
        // safer than aborting a working stream.
        return null;
      }

      // Some providers report failures inside a 200 response body mid-stream.
      const error = extractError(parsed);
      if (error) {
        state.error = error;
        state.done = true;
        return snapshot();
      }

      const root = asRecord(parsed);
      if (!root) return null;

      let changed = false;

      if (typeof root.model === 'string' && root.model !== state.model) {
        state.model = root.model;
        changed = true;
      }

      const usage = readUsage(root.usage);
      if (usage) {
        state.usage = usage;
        changed = true;
      }

      // A final usage-only chunk has choices: [] — must not be treated as malformed.
      const incoming = Array.isArray(root.choices) ? root.choices : [];

      // Every choice in the chunk, not just the first: with `n > 1` a single chunk can
      // carry deltas for several completions at once.
      for (const entry of incoming) {
        const choice = asRecord(entry);
        if (!choice) continue;

        const target = choiceAt(choiceIndex(choice));
        const delta = asRecord(choice.delta);
        const message = asRecord(choice.message);

        // `delta` while streaming, `message` for a non-streamed body reaching this path.
        const text = delta
          ? typeof delta.content === 'string'
            ? delta.content
            : null
          : message && typeof message.content === 'string'
            ? message.content
            : null;

        if (text) {
          target.content += text;
          changed = true;
        }

        // OpenRouter uses `reasoning`; most others use `reasoning_content`.
        const source = delta ?? message;
        const thought =
          source && typeof source.reasoning === 'string'
            ? source.reasoning
            : source && typeof source.reasoning_content === 'string'
              ? source.reasoning_content
              : null;

        if (thought) {
          target.reasoning += thought;
          changed = true;
        }

        if (typeof choice.finish_reason === 'string') {
          target.finishReason = choice.finish_reason;
          changed = true;
        }
      }

      return changed ? snapshot() : null;
    },
  };
}

/** Turn a non-streamed completion body into the same shape. */
export function parseCompletion(body: unknown, seed = ''): StreamState {
  const state: StreamState = {
    content: seed,
    reasoning: '',
    finishReason: null,
    done: true,
  };

  const error = extractError(body);
  if (error) {
    state.error = error;
    return state;
  }

  const root = asRecord(body);
  if (!root) return state;

  if (typeof root.model === 'string') state.model = root.model;
  const usage = readUsage(root.usage);
  if (usage) state.usage = usage;

  const entries = Array.isArray(root.choices) ? root.choices : [];
  if (!entries.length) return state;

  // Array order, unlike the streaming path: a complete body arrives in one piece and is
  // already in index order, so there is nothing to interleave and no gap to fill.
  const parsed = entries.map((entry): StreamChoice => {
    const choice = asRecord(entry);
    const result = blankChoice();
    if (!choice) return result;

    const message = asRecord(choice.message);
    if (message) {
      if (typeof message.content === 'string') result.content = message.content;
      if (typeof message.reasoning === 'string') result.reasoning = message.reasoning;
      else if (typeof message.reasoning_content === 'string') {
        result.reasoning = message.reasoning_content;
      }
    }
    if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
    return result;
  });

  const primary = parsed[0]!;
  // `+=` keeps the seed in front, for a non-streamed continue.
  state.content += primary.content;
  state.reasoning = primary.reasoning;
  state.finishReason = primary.finishReason;
  if (parsed.length > 1) state.alternates = parsed.slice(1);

  return state;
}
