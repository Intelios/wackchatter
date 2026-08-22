/**
 * Turning a pool entry into something that can be sent to.
 *
 * A contender is an endpoint plus a model, and either half can rot: the connection can be
 * deleted, lose its base URL, or never have had a model set. All three produce an entrant
 * that cannot fight — but never one that is silently dropped. Disabled beats refused, and a
 * pool that quietly loses a row when you tidy your connections is a pool you cannot trust.
 *
 * The resolution itself is the Co-Creator's `modelOverride` rule: the model belongs to the
 * endpoint it was chosen against, so it is applied by spreading over that connection rather
 * than travelling on its own.
 */

import type { Connection } from '@shared/providers/types.ts';
import type { Contender } from '@shared/types/arena.ts';

export interface ResolvedContender {
  contender: Contender;
  /** The connection with the model applied, or null when this entrant cannot run. */
  connection: Connection | null;
  /** Why it cannot run, for a `disabledReason`. Null when it can. */
  unavailableReason: string | null;
}

/** What to call a contender. Falls back to the model, then to something rather than blank. */
export function contenderLabel(contender: Contender, connection?: Connection | null): string {
  if (contender.name.trim()) return contender.name.trim();
  const model = contender.model.trim() || connection?.model?.trim() || '';
  return model || 'Unnamed contender';
}

export function resolveContender(
  contender: Contender,
  connections: readonly Connection[],
): ResolvedContender {
  const connection = connections.find((entry) => entry.id === contender.connectionId) ?? null;

  if (!connection) {
    return { contender, connection: null, unavailableReason: 'Its connection has been deleted.' };
  }
  if (!connection.baseUrl.trim()) {
    return {
      contender,
      connection: null,
      unavailableReason: `"${connection.name}" has no endpoint set.`,
    };
  }

  // An empty override follows the connection's own model, so the common case — one
  // contender per connection — needs nothing duplicated.
  const model = contender.model.trim() || connection.model.trim();
  if (!model) {
    return {
      contender,
      connection: null,
      unavailableReason: `No model is set for it, and "${connection.name}" has no default.`,
    };
  }

  return { contender, connection: { ...connection, model }, unavailableReason: null };
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
