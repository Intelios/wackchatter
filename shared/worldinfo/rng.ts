/**
 * A seeded pseudo-random generator for World Info.
 *
 * Two things in the engine need randomness — `probability` rolls and inclusion-group
 * weighting — and `Math.random()` would make both untestable and, worse, would reshuffle
 * a chat's lore on every regenerate. Comparing two swipes is supposed to be a comparison
 * of the model, not of a different set of facts.
 *
 * So it is seeded, exactly like `{{pick}}`, over the same `hashString`.
 */

import { hashString } from '../prompt/macros.ts';

export interface Rng {
  /** The next draw, in [0, 1). */
  next(): number;
  /** Draws taken so far. Only useful for asserting that a draw was skipped. */
  readonly count: number;
}

/**
 * mulberry32 — small, fast, and good enough for picking between three lorebook entries.
 *
 * The generator is stateful on purpose: successive draws in one run must differ, or every
 * group in a chat would pick its winner the same way.
 */
export function createRng(seed: string): Rng {
  let state = hashString(seed) || 1;
  let count = 0;

  return {
    next(): number {
      count++;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get count() {
      return count;
    },
  };
}

/**
 * Weighted choice over a list.
 *
 * Consumes exactly one draw, and only when there is a real choice to make: a single
 * candidate is returned without touching the generator. With a seeded RNG a wasted draw
 * is not free — it shifts every later roll in the run, so "adding one entry that was
 * always going to win anyway" would silently change which entry wins somewhere else.
 */
export function weightedPick<T>(items: T[], weightOf: (item: T) => number, rng: Rng): T | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] ?? null;

  const weights = items.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  // Every weight is zero, so there is nothing to weight by. Pick uniformly rather than
  // returning nothing — the group is still supposed to produce a winner.
  if (total <= 0) return items[Math.floor(rng.next() * items.length)] ?? items[0] ?? null;

  const roll = rng.next() * total;
  let running = 0;
  for (let i = 0; i < items.length; i++) {
    running += weights[i] ?? 0;
    if (roll < running) return items[i] ?? null;
  }
  return items[items.length - 1] ?? null;
}
