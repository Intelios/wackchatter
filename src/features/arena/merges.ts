/**
 * Two providers of one model, folded into one leaderboard identity.
 *
 * A contender is an endpoint plus a model, which is what the bench needs — it runs physical
 * things. But the board is read as "which *model* writes best", and a model served by two
 * providers arrives as two entrants: the same weights ranked against itself, each with half
 * the history. Merging says those two are one model, and every reader of the rounds then
 * folds them together.
 *
 * Nothing is rewritten to record a merge. Rounds keep both contenders' ids — that is what
 * makes this a lens rather than an edit, and why unmerging splits the history back exactly
 * and for free. The rewrite happens here, on the way into a reader, so `replay`, the
 * bootstrap, `headToHead` and `series` need no merge logic of their own and cannot disagree
 * about one.
 *
 * The one thing a merge cannot do is compare a model with itself. A round that ran provider
 * A against provider B of the same model collapses to a self-pair once both fold into one
 * identity, and `replay` would fold it in twice — a win and a loss on the same row, and a
 * resample weight in the bootstrap for a comparison that contains none. Those rounds are
 * dropped from the merged view, and the count is reported so the loss is never silent. It is
 * the judgement `bad` already gets: recorded, but evidence of nothing this board measures.
 */

import type { ArenaRound, Contender, RoundSide } from '@shared/types/arena.ts';

/** Contender id → the id its recorded rounds count under. See `ArenaSettings`. */
export type MergeMap = Readonly<Record<string, string>>;

/**
 * Resolve every id the map mentions to the id its rounds count under.
 *
 * An id not in the map maps to itself, so callers can look up without checking first. A
 * target is followed as far as it goes (the Pool only ever writes a direct link to an
 * unmerged entry, but a second merge can make a chain), and a loop — only reachable through
 * hand-edited settings — resolves to the smallest id in the cycle, so the answer does not
 * depend on where the walk happened to enter it.
 */
export function canonicalMap(merged: MergeMap): Map<string, string> {
  const roots = new Map<string, string>();
  const nodes = new Set<string>([...Object.keys(merged), ...Object.values(merged)]);

  for (const start of nodes) {
    if (roots.has(start)) continue;

    // The walk, and where each node sits on it, so a loop can be recognised and cut.
    const path: string[] = [];
    const at = new Map<string, number>();
    let current = start;

    while (!roots.has(current) && !at.has(current)) {
      const next = merged[current];
      // An empty or self-referencing target is not a merge; the node is a root.
      if (!next || next === current) break;
      at.set(current, path.length);
      path.push(current);
      current = next;
    }

    const resolved = roots.get(current);
    if (resolved !== undefined) {
      for (const id of path) roots.set(id, resolved);
      continue;
    }

    const entered = at.get(current);
    const root =
      entered === undefined
        ? current
        : path.slice(entered).reduce((best, id) => (id < best ? id : best), current);

    for (const id of path) roots.set(id, root);
    roots.set(current, root);
  }

  return roots;
}

/** The id a contender's rounds count under. An unresolved id is its own root. */
export function canonicalId(canonical: ReadonlyMap<string, string>, id: string): string {
  return canonical.get(id) ?? id;
}

/**
 * Whether a contender may be drawn by the blind round.
 *
 * A folded one may not. Its rounds already count under the identity that absorbed it, so
 * pulling it as well would have the merged model fight itself and hand the pair a round
 * every board reader then discards — two paid generations for evidence the merge has
 * already declared unreadable. The bench still offers it, because that is where the two
 * providers are compared deliberately rather than drawn at random.
 */
export function drawable(canonical: ReadonlyMap<string, string>, id: string): boolean {
  return canonicalId(canonical, id) === id;
}

/**
 * Every pool entry grouped by the identity it counts under.
 *
 * Two entries under one root is a merge, and the pair is what the UI names — "Sonnet (A) +
 * Sonnet (B)" reads as a model with two providers, where an unqualified single row on a
 * board that says nothing about the fold would just look like the other one vanished.
 * Only pool entries are listed: a folded contender deleted from the pool still contributes
 * its rounds, but there is no row left to name.
 */
export function mergeGroups(
  contenders: readonly Contender[],
  canonical: ReadonlyMap<string, string>,
): Map<string, Contender[]> {
  const groups = new Map<string, Contender[]>();
  for (const contender of contenders) {
    const root = canonicalId(canonical, contender.id);
    const members = groups.get(root);
    if (members) members.push(contender);
    else groups.set(root, [contender]);
  }
  return groups;
}

/** One side folded to its canonical id, for a round that has not been recorded yet. */
export function canonicalSide(canonical: ReadonlyMap<string, string>, side: RoundSide): RoundSide {
  const contenderId = canonicalId(canonical, side.contenderId);
  return contenderId === side.contenderId ? side : { ...side, contenderId };
}

/**
 * Drop a contender's merge links: the ones it owns, and the ones pointing at it.
 *
 * For purging, which erases a contender's rounds for good. A link that points at an id with
 * no rounds and no pool entry would leave everyone folded under it labelled by a bare uuid,
 * and there is nothing left for the fold to mean.
 */
export function withoutContender(merged: MergeMap, id: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [from, to] of Object.entries(merged)) {
    if (from === id || to === id) continue;
    next[from] = to;
  }
  return next;
}

export interface MergedView {
  /**
   * The rounds as a reader of the merged board should see them: both sides' ids folded to
   * the identity they count under, and self-pairs dropped. The stored rounds are untouched.
   */
  rounds: readonly ArenaRound[];
  /**
   * One entry per identity — the folded ones are gone, so a reader that seeds a row per pool
   * entry does not invent an empty row for a contender whose rounds now belong to another.
   */
  contenders: readonly Contender[];
  /** Every id mentioned, resolved. Passed to lookups that hold a raw id — see `canonicalId`. */
  canonical: ReadonlyMap<string, string>;
  /** Rounds dropped because both sides fold into one identity. Zero unless merging. */
  collapsed: number;
}

/**
 * The merged view of a history: what every board reader should be handed.
 *
 * Returns its inputs untouched when nothing is merged, so the common path allocates nothing
 * and cannot change a number.
 */
export function applyMerges(
  rounds: readonly ArenaRound[],
  contenders: readonly Contender[],
  merged: MergeMap,
): MergedView {
  const canonical = canonicalMap(merged);
  if (canonical.size === 0) return { rounds, contenders, canonical, collapsed: 0 };

  const folded: ArenaRound[] = [];
  let collapsed = 0;

  for (const round of rounds) {
    const left = canonicalSide(canonical, round.left);
    const right = canonicalSide(canonical, round.right);
    // The same identity on both sides: nothing about the merged model can be read off it.
    if (left.contenderId === right.contenderId) {
      collapsed++;
      continue;
    }
    folded.push({ ...round, left, right });
  }

  const surviving = contenders.filter(
    (contender) => canonicalId(canonical, contender.id) === contender.id,
  );

  return { rounds: folded, contenders: surviving, canonical, collapsed };
}
