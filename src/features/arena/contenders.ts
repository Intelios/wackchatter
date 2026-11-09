/**
 * Turning a pool entry into something that can be sent to.
 *
 * A contender is a model, and its model can rot: never picked, its connection deleted, or
 * the connection left without an endpoint. All of them produce an entrant that cannot fight
 * — but never one that is silently dropped. Disabled beats refused, and a pool that quietly
 * loses a row when you tidy your connections is a pool you cannot trust.
 */

import { resolveModelRef } from '@shared/models/slots.ts';
import type { Connection, ResolvedModel } from '@shared/providers/types.ts';
import type { Contender } from '@shared/types/arena.ts';

export interface ResolvedContender {
  contender: Contender;
  /** The contender's model on its connection, or null when this entrant cannot run. */
  connection: ResolvedModel | null;
  /** Why it cannot run, for a `disabledReason`. Null when it can. */
  unavailableReason: string | null;
}

/** What to call a contender. Falls back to the model id, then to something rather than blank. */
export function contenderLabel(contender: Contender): string {
  if (contender.name.trim()) return contender.name.trim();
  return contender.model?.modelId || 'Unnamed contender';
}

export function resolveContender(
  contender: Contender,
  connections: readonly Connection[],
): ResolvedContender {
  const resolution = resolveModelRef(connections, contender.model, 'contender');
  return resolution.ok
    ? { contender, connection: resolution.model, unavailableReason: null }
    : { contender, connection: null, unavailableReason: resolution.reason };
}

export function resolveContenders(
  contenders: readonly Contender[],
  connections: readonly Connection[],
): ResolvedContender[] {
  return contenders.map((contender) => resolveContender(contender, connections));
}

/** The entrants the blind draw may use: enabled, and actually able to run. */
export function eligibleContenders(resolved: readonly ResolvedContender[]): Contender[] {
  return resolved
    .filter((entry) => entry.contender.enabled && entry.connection !== null)
    .map((entry) => entry.contender);
}

/**
 * Why one of these entrants cannot be sent to right now, or null when all of them can.
 *
 * Tournaments need this at times a blind draw never hits: a bracket holds contender ids
 * for its whole life, while the pool row — and the connection underneath it — can be
 * deleted, repointed or emptied at any moment after the draw. The check reads the same
 * resolution a run would use, so what the Fight button says and what the run does cannot
 * disagree. The first unrunnable entrant reports; a match needs every side runnable, so
 * which one is irrelevant.
 */
export function blockedEntrantReason(
  contenderIds: readonly string[],
  resolved: readonly ResolvedContender[],
  nameOf: (contenderId: string) => string,
): string | null {
  for (const id of contenderIds) {
    const entry = resolved.find((item) => item.contender.id === id);
    if (!entry) return `${nameOf(id)} is no longer in the pool.`;
    if (!entry.connection) {
      return `${nameOf(id)} cannot fight — ${entry.unavailableReason}`;
    }
  }
  return null;
}
