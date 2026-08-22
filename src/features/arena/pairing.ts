/**
 * Drawing a blind round: which card, which probe, which two contenders, which side each.
 *
 * Uniform random would be the obvious choice and is the wrong one. With five contenders
 * there are ten pairings, and uniform draws spend most of a twenty-round session
 * re-deciding matchups already settled while two entrants never meet at all — so the
 * leaderboard stays provisional long after the user has done the work to fill it. Picking
 * the least-played pair each time turns the same twenty rounds into even coverage.
 *
 * Everything is drawn from one seeded `Rng`, so a whole round draw is reproducible from
 * its seed. Production seeds with a uuid; tests seed with a string and get the same round
 * every time.
 */

import type { ArenaProbe, ArenaRound, Contender } from '@shared/types/arena.ts';
// The World Info generator, reused rather than duplicated: mulberry32 over `hashString` is
// not specific to lore, and a second RNG in the codebase would be a second thing to seed
// correctly.
import type { Rng } from '@shared/worldinfo/rng.ts';
import { createRng } from '@shared/worldinfo/rng.ts';

export interface RoundDraw {
  characterId: string;
  probe: ArenaProbe;
  left: Contender;
  right: Contender;
}

/** An unordered pair, keyed so `a vs b` and `b vs a` are one matchup. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/** Pick one of the entries tied for lowest cost. `costs` must be the same length. */
function pickLeast<T>(entries: readonly T[], costs: readonly number[], rng: Rng): T | null {
  if (entries.length === 0) return null;

  let best = Number.POSITIVE_INFINITY;
  for (const cost of costs) if (cost < best) best = cost;

  const tied = entries.filter((_, index) => costs[index] === best);
  // A draw is taken even when only one entry is tied, so the number of draws a round
  // consumes does not depend on the shape of the history. Otherwise a seed would mean
  // something different once the pool grew.
  const index = Math.floor(rng.next() * tied.length);
  return tied[Math.min(index, tied.length - 1)] ?? null;
}

/**
 * The two contenders that have met least often, tie-broken by total rounds fought and then
 * by a seeded draw.
 *
 * Rejected rounds count toward "played": they cost the same money and time, and the point
 * of the cost is coverage, not rating movement.
 */
export function choosePair(
  contenders: readonly Contender[],
  rounds: readonly ArenaRound[],
  rng: Rng,
): [Contender, Contender] | null {
  if (contenders.length < 2) return null;

  const ids = new Set(contenders.map((entry) => entry.id));
  const pairCounts = new Map<string, number>();
  const totals = new Map<string, number>();

  for (const round of rounds) {
    const left = round.left.contenderId;
    const right = round.right.contenderId;
    // History against contenders no longer in the pool is not evidence about who should
    // meet next, so it raises neither a pair count nor a total.
    if (!ids.has(left) || !ids.has(right)) continue;
    const key = pairKey(left, right);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    totals.set(left, (totals.get(left) ?? 0) + 1);
    totals.set(right, (totals.get(right) ?? 0) + 1);
  }

  /*
   * Lexicographic (pair count, then combined total) folded into one number.
   *
   * The combined total can never exceed twice the number of rounds, so scaling the pair
   * count by one more than that keeps the first key dominant: a pair that has never met
   * always beats one that has, however busy its two members have been elsewhere.
   */
  const scale = 2 * rounds.length + 1;

  const pairs: [Contender, Contender][] = [];
  const costs: number[] = [];
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      const a = contenders[i]!;
      const b = contenders[j]!;
      pairs.push([a, b]);
      const played = pairCounts.get(pairKey(a.id, b.id)) ?? 0;
      costs.push(played * scale + (totals.get(a.id) ?? 0) + (totals.get(b.id) ?? 0));
    }
  }

  return pickLeast(pairs, costs, rng);
}

/** The least-used card in the pool, so a benchmark covers the library rather than one card. */
export function chooseCard(
  cards: readonly string[],
  rounds: readonly ArenaRound[],
  rng: Rng,
): string | null {
  if (cards.length === 0) return null;

  const used = new Map<string, number>();
  for (const round of rounds) {
    used.set(round.characterId, (used.get(round.characterId) ?? 0) + 1);
  }

  return pickLeast(
    cards,
    cards.map((card) => used.get(card) ?? 0),
    rng,
  );
}

/**
 * Draw a complete round.
 *
 * Returns null when the setup cannot produce one — fewer than two contenders, no cards, no
 * probes. The caller turns that into a `disabledReason` rather than a failed round.
 *
 * The side each contender takes is a coin flip, drawn last. Without it the pairing order
 * would be stable for a given matchup, and position bias — the well-documented habit of
 * preferring whichever answer is read first — would attach itself to one contender and
 * stay there for the whole history.
 */
export function drawRound(options: {
  contenders: readonly Contender[];
  cards: readonly string[];
  probes: readonly ArenaProbe[];
  rounds: readonly ArenaRound[];
  seed: string;
}): RoundDraw | null {
  const { contenders, cards, probes, rounds, seed } = options;
  if (probes.length === 0) return null;

  const rng = createRng(seed);

  const characterId = chooseCard(cards, rounds, rng);
  if (characterId === null) return null;

  // Uniform, unlike the card and the pair: probes exist to vary the question, and there is
  // no coverage obligation that would make an under-used one the right next choice.
  const probeIndex = Math.floor(rng.next() * probes.length);
  const probe = probes[Math.min(probeIndex, probes.length - 1)];
  if (!probe) return null;

  const pair = choosePair(contenders, rounds, rng);
  if (!pair) return null;

  const flipped = rng.next() < 0.5;
  return {
    characterId,
    probe,
    left: flipped ? pair[1] : pair[0],
    right: flipped ? pair[0] : pair[1],
  };
}
