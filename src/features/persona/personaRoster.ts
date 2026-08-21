/**
 * Finding a persona: filtering, ordering, and resolving a typed name.
 *
 * Pure, with no DOM or store in reach, so the rules are unit-testable the same way
 * `buildCharacterTree` and `buildChatMenu` are. Shared by the composer's switcher and the
 * panel's roster deliberately — two copies of "which persona did they mean" would drift,
 * and the drift would show up as the popover and the panel disagreeing about the same
 * library.
 *
 * One thing shapes every function here: **persona names are free to collide.** The id is
 * opaque and the name is an ordinary editable field (see "the persona rule" in AGENTS.md),
 * so two personas called "Wren" is a legal library, not a corrupt one. Nothing below may
 * assume a name identifies anything.
 */

import type { Persona } from '@shared/types/chat.ts';

/** Name and description — the two fields a persona is actually recognised by. */
export function matchesPersonaQuery(persona: Persona, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return persona.name.toLowerCase().includes(q) || persona.description.toLowerCase().includes(q);
}

export interface OrderedPersonas {
  /** Most recently used first. Never includes a persona that no longer exists. */
  recent: Persona[];
  /** Everything else, in the order given — which from the server is already A–Z. */
  rest: Persona[];
}

/**
 * Split the library into "recently used" and "the rest".
 *
 * `recentIds` may name personas that have since been deleted; they are dropped rather than
 * rendered blank. The input order is preserved for `rest` because `listPersonas` already
 * sorts by name — re-sorting here would be a second opinion about the same question.
 */
export function orderPersonas(
  personas: readonly Persona[],
  recentIds: readonly string[],
  limit = Number.POSITIVE_INFINITY,
): OrderedPersonas {
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const recent: Persona[] = [];
  const taken = new Set<string>();

  for (const id of recentIds) {
    if (recent.length >= limit) break;
    // A duplicate id in the stored list must not produce the same row twice.
    if (taken.has(id)) continue;
    const persona = byId.get(id);
    if (!persona) continue;
    taken.add(id);
    recent.push(persona);
  }

  return { recent, rest: personas.filter((persona) => !taken.has(persona.id)) };
}

/**
 * Push an id to the front of the recent list, capped.
 *
 * Returns the same array reference when nothing would change, so a caller can skip a
 * settings write for a switch back to the persona already at the front.
 */
export function withRecentPersona(
  recentIds: readonly string[],
  id: string | null,
  limit: number,
): readonly string[] {
  if (!id) return recentIds;
  if (recentIds[0] === id) return recentIds;
  return [id, ...recentIds.filter((entry) => entry !== id)].slice(0, limit);
}

export type PersonaNameMatch =
  | { ok: true; persona: Persona }
  | { ok: false; reason: 'none' }
  /** Two or more equally good matches. The caller reports them rather than guessing. */
  | { ok: false; reason: 'ambiguous'; candidates: Persona[] };

/**
 * Resolve a typed name, for `/persona <name>`.
 *
 * A ladder of decreasing confidence — exact, then prefix, then substring — and the first
 * rung with any matches decides. A rung with more than one match is ambiguous and stops
 * there rather than falling through: "Wren" matching two personas exactly is not a reason
 * to go looking for a substring match on a third.
 *
 * Guessing is the one thing this must not do. Switching persona rewrites who the next
 * message is attributed to, and a wrong guess is recorded onto the transcript.
 */
export function matchPersonaByName(personas: readonly Persona[], query: string): PersonaNameMatch {
  const q = query.trim().toLowerCase();
  if (!q) return { ok: false, reason: 'none' };

  const rungs = [
    personas.filter((persona) => persona.name.toLowerCase() === q),
    personas.filter((persona) => persona.name.toLowerCase().startsWith(q)),
    personas.filter((persona) => persona.name.toLowerCase().includes(q)),
  ];

  for (const matches of rungs) {
    if (matches.length === 1) return { ok: true, persona: matches[0]! };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches };
  }

  return { ok: false, reason: 'none' };
}
