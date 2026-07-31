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

export interface StreamState {
  /** The FULL text so far, never a delta. */
  content: string;
  reasoning: string;
  finishReason: string | null;
  model?: string;
  usage?: StreamUsage;
  done: boolean;
  /** Set when the provider reported an error inside an otherwise-200 stream. */
  error?: string;
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
 * @param seed Existing text to build on. Used by `continue`, where the reply extends a
 *   message that already has content.
 */
export function createStreamAccumulator(seed = ''): StreamAccumulator {
  const state: StreamState = {
    content: seed,
    reasoning: '',
    finishReason: null,
    done: false,
  };

  function snapshot(): StreamState {
    // A fresh object each time: consumers hold onto these across renders.
    return { ...state, usage: state.usage ? { ...state.usage } : undefined };
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
      const choices = Array.isArray(root.choices) ? root.choices : [];
      const choice = asRecord(choices[0]);

      if (choice) {
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
          state.content += text;
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
          state.reasoning += thought;
          changed = true;
        }

        if (typeof choice.finish_reason === 'string') {
          state.finishReason = choice.finish_reason;
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

  const choice = asRecord(Array.isArray(root.choices) ? root.choices[0] : null);
  if (!choice) return state;

  const message = asRecord(choice.message);
  if (message) {
    if (typeof message.content === 'string') state.content += message.content;
    if (typeof message.reasoning === 'string') state.reasoning = message.reasoning;
    else if (typeof message.reasoning_content === 'string') {
      state.reasoning = message.reasoning_content;
    }
  }
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;

  return state;
}
