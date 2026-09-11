/**
 * What to call a contender in a tournament view.
 *
 * Three sources, in order: the live pool entry, the model recorded on a match it fought (so a
 * contender deleted from the pool still has a label, the same fallback the leaderboard makes),
 * and finally the bare id. Resolution never throws and never hides a row — a tournament
 * someone played keeps its names after the pool is tidied.
 *
 * An unnamed, model-less contender resolves to its *connection's* model rather than a generic
 * placeholder: a pool row with no name of its own is the common case here (the Arena's own
 * contenders are often created empty and rely on the endpoint's model), and a placeholder
 * would be both less informative and would shadow the model recorded on a match.
 */

import type { TournamentWithMatches } from '@shared/types/arena.ts';
import type { ResolvedContender } from '../contenders.ts';

/** The pool's own label, or empty when the entry says nothing worth showing. */
function poolLabel(entry: ResolvedContender): string {
  const name = entry.contender.name.trim();
  if (name) return name;
  return entry.contender.model.trim() || entry.connection?.model?.trim() || '';
}

export function tournamentNameFor(
  resolved: readonly ResolvedContender[],
  tournaments: readonly TournamentWithMatches[],
): (contenderId: string) => string {
  const pool = new Map(
    resolved
      .map((entry) => [entry.contender.id, poolLabel(entry)] as const)
      .filter(([, label]) => label !== ''),
  );

  // Last seen wins, so a contender repointed at a new model is labelled with the newest one.
  const recorded = new Map<string, string>();
  for (const tournament of tournaments) {
    for (const match of tournament.matches) {
      for (const side of [match.left, match.right]) {
        const model = side.model.trim();
        if (model) recorded.set(side.contenderId, model);
      }
    }
  }

  return (contenderId) => pool.get(contenderId) || recorded.get(contenderId) || contenderId;
}
