/**
 * The scan buffer: the text World Info searches for keywords.
 *
 * Two things about its construction are load-bearing rather than incidental.
 *
 * **Newest-first.** Messages are reversed before they go in, so index 0 is the most
 * recent. "Scan depth 2" then means `slice(0, 2)` — the last two messages — and a
 * per-entry `scanDepth` override is a different slice of the same array rather than a
 * different buffer.
 *
 * **The `\x01` sentinel, including one at the head.** Entries are joined with `\n\x01`
 * and the whole string starts with `\x01`. Whole-word matching tests `(?:^|\W)key(?:$|\W)`;
 * without the leading sentinel a key at the very start of the newest message would still
 * match via `^`, but a key at the start of the *second* message would match via the `\n`
 * — and the two would behave differently the moment anything else changed. The sentinel
 * makes every message begin the same way. It also stops a key spanning the seam between
 * two messages, which is what a plain `\n` join would allow.
 *
 * ST rebuilds this string on every single key test. We build it once per depth and cache,
 * which is the same thing done less often.
 */

import type { ChatMessage } from '../types/chat.ts';

/** ST's cap. A book asking for more than this gets clamped rather than rejected. */
export const MAX_SCAN_DEPTH = 1000;

const SENTINEL = '\x01';
const JOINER = `\n${SENTINEL}`;

export interface ScanBufferOptions {
  /** Prefix each message with `Name: `, matching ST's world_info_include_names. */
  includeNames?: boolean;
}

/**
 * The scannable text of a transcript, newest first.
 *
 * `is_system` messages are excluded — they are hidden from the prompt, so letting them
 * trigger lore would leak a hidden message's content into the model's context by proxy.
 * Blank messages are dropped so an in-flight placeholder doesn't occupy a depth slot.
 */
export function scanLines(messages: ChatMessage[], options: ScanBufferOptions = {}): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.is_system) continue;
    const text = message.mes?.trim();
    if (!text) continue;
    lines.push(options.includeNames ? `${message.name}: ${text}` : text);
  }
  return lines.reverse();
}

/**
 * A depth-sliceable, memoised buffer.
 *
 * Entries carry per-entry `scanDepth` overrides, so a single capped string would be
 * wrong — a shallow entry must not see a message a deeper one can. Recursion text is
 * appended to every slice, since an entry activated on a later pass is matched against
 * what earlier passes admitted regardless of depth.
 */
export class ScanBuffer {
  readonly #lines: string[];
  readonly #recursed: string[] = [];
  readonly #cache = new Map<number, string>();

  constructor(lines: string[]) {
    this.#lines = lines;
  }

  static fromMessages(messages: ChatMessage[], options: ScanBufferOptions = {}): ScanBuffer {
    return new ScanBuffer(scanLines(messages, options));
  }

  /** Text admitted on an earlier pass, which later passes may match against. */
  addRecursed(text: string): void {
    if (!text) return;
    this.#recursed.push(text);
    this.#cache.clear();
  }

  get recursionDepth(): number {
    return this.#recursed.length;
  }

  /**
   * The haystack for one entry.
   *
   * `depth <= 0` yields the empty string and nothing else — not "everything", and not
   * even the recursion buffer. A zero scan depth in ST means "this entry does not scan",
   * so treating it as unlimited would make an entry meant to be inert fire constantly.
   */
  get(depth: number, options: { includeRecursed?: boolean } = {}): string {
    const includeRecursed = options.includeRecursed ?? true;
    const clamped = Math.min(Math.floor(depth), MAX_SCAN_DEPTH);
    if (!(clamped > 0)) return '';

    const key = includeRecursed ? clamped : -clamped;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const slice = this.#lines.slice(0, clamped);
    const parts = includeRecursed ? [...slice, ...this.#recursed] : slice;
    const result = parts.length > 0 ? SENTINEL + parts.join(JOINER) : '';

    this.#cache.set(key, result);
    return result;
  }
}
