/**
 * Corner colour: one contender, one colour, everywhere it appears.
 *
 * Before this the eight `--wc-series-*` tokens coloured the leaderboard chart and nothing
 * else, so a model had a visual identity on one screen out of four. Here the same colour
 * stripes its column in the Arena, tints its reveal in the Benchmark, fills its bar on the
 * leaderboard and marks its entry in the Pool.
 *
 * Two rules, and the second is the interesting one:
 *
 *  - A contender's *preferred* colour comes from its position in the pool, so dragging the
 *    roster is a real edit and a stable one — the same entry keeps the same colour between
 *    sessions without anything being stored.
 *  - But there are eight tokens and no limit on contenders, so preference alone would let
 *    entrant nine share a colour with entrant one *while both are on screen*. Colour is
 *    therefore resolved **per view** against the entrants actually in it: two things you can
 *    see at once can never wear the same colour. Past eight visible the collision is
 *    unavoidable, which is why every swatch in the UI is accompanied by a name.
 */

import type { Contender } from '@shared/types/arena.ts';

/** How many categorical tokens `tokens.css` defines. */
export const SERIES_COUNT = 8;

/** The CSS variable for a slot. Slots wrap, so a ninth entrant repeats rather than vanishes. */
export function seriesToken(slot: number): string {
  return `var(--wc-series-${(((slot % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT) + 1})`;
}

/**
 * A stable slot for an id with no pool position — a contender deleted from the pool whose
 * rounds still appear on the leaderboard.
 *
 * Hashed rather than taken from list order, because the leaderboard's order is by rating
 * and would hand the same entrant a different colour as its rating moved.
 */
export function fallbackSlot(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return ((hash % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT;
}

/** Preferred slots, by pool order. */
export function poolSlots(contenders: readonly Contender[]): Map<string, number> {
  return new Map(contenders.map((contender, index) => [contender.id, index % SERIES_COUNT]));
}

/**
 * Resolve colours for the entrants in one view.
 *
 * Preference first, then the leftovers take the lowest free slot in the order they were
 * given — so the assignment is deterministic, and adding a ninth entrant cannot silently
 * move the first eight.
 */
export function viewSeries(
  ids: readonly string[],
  preferred: ReadonlyMap<string, number>,
): Map<string, string> {
  const slots = new Map<string, number>();
  const taken = new Set<number>();

  const wanted = (id: string): number => preferred.get(id) ?? fallbackSlot(id);

  for (const id of ids) {
    if (slots.has(id)) continue;
    const slot = wanted(id);
    if (!taken.has(slot)) {
      taken.add(slot);
      slots.set(id, slot);
    }
  }

  for (const id of ids) {
    if (slots.has(id)) continue;
    let free = -1;
    for (let slot = 0; slot < SERIES_COUNT; slot++) {
      if (!taken.has(slot)) {
        free = slot;
        break;
      }
    }
    // More than eight entrants in one view: nothing is free, so fall back to the preferred
    // slot and accept the repeat. The name beside every swatch is what carries it from here.
    const slot = free === -1 ? wanted(id) : free;
    taken.add(slot);
    slots.set(id, slot);
  }

  return new Map([...slots].map(([id, slot]) => [id, seriesToken(slot)]));
}

/** The colour a single entrant wears in a view, or the first token when it is not in one. */
export function colourOf(colours: ReadonlyMap<string, string>, id: string): string {
  return colours.get(id) ?? seriesToken(fallbackSlot(id));
}
