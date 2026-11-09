/**
 * How long a reply may run, and how much context to leave free for it.
 *
 * Two different numbers. The **cap** is what a request sends as `max_tokens`. Exceeding it
 * cuts the reply off, so the app never sets one on its own: summaries, the recap, Nexus,
 * the Co-Creators and persona derive send none. The chat sends one only when its preset
 * asks for it. The **reserve** is how much of the declared context assembly keeps free for
 * the reply while packing history. It is never sent, so getting it wrong costs history, not
 * the reply.
 *
 * A preset with `openai_max_tokens_unlimited: true` (a WackChatter extension) sends no cap.
 * New presets start that way. Imported SillyTavern presets lack the key, so they keep the
 * number they came with until someone switches it off.
 */

import type { Preset } from '../types/preset.ts';

/** SillyTavern's default reply length, for presets that name none. */
export const DEFAULT_RESPONSE_TOKENS = 300;

/** The reserve for an uncapped reply never exceeds this... */
const UNCAPPED_RESERVE_MAX = 8192;
/** ...or this share of the declared context, so a small context still packs history. */
const UNCAPPED_RESERVE_SHARE = 0.25;

/**
 * Claude with thinking on OpenRouter is the one request that must carry a number, because
 * the thinking budget has to fit under `max_tokens`. When nothing caps the reply, the reply
 * gets this much on top of the thinking budget. The total stays under the 64K output that
 * current Claude models allow.
 */
export const CLAUDE_UNCAPPED_REPLY = 32000;

export function isResponseUnlimited(preset: Preset): boolean {
  return preset.openai_max_tokens_unlimited === true;
}

/** The `max_tokens` the preset asks for, or null for none. */
export function responseCap(preset: Preset): number | null {
  if (isResponseUnlimited(preset)) return null;
  return preset.openai_max_tokens ?? DEFAULT_RESPONSE_TOKENS;
}

/** How much of the declared context to keep free for the reply. */
export function responseReserve(preset: Preset): number {
  const cap = responseCap(preset);
  if (cap !== null) return cap;
  const context = preset.openai_max_context ?? 4095;
  return Math.min(UNCAPPED_RESERVE_MAX, Math.floor(context * UNCAPPED_RESERVE_SHARE));
}
