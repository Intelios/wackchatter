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

/**
 * Name and description — the two fields a persona is actually recognised by. A variant is
 * also recognised by its label: within a group that shares one name, the label is the part
 * that differs.
 */
export function matchesPersonaQuery(persona: Persona, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    persona.name.toLowerCase().includes(q) ||
    persona.description.toLowerCase().includes(q) ||
    Boolean(persona.variantLabel?.toLowerCase().includes(q))
  );
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

/**
 * Group variants under their base for a roster list.
 *
 * The base stores nothing — a group is whatever points at it — so grouping is a pure pass
 * over the list, never a second copy of the truth. Variants leave their alphabetical slot
 * and follow their base, label-first; a variant whose base is not in the same list (it was
 * hoisted into "Recent", or deleted) keeps its own position and reads as the standalone row
 * it effectively is. Recents are never grouped: that section exists to show recency, and a
 * variant used a minute ago is its own entry there, told apart by its label chip.
 */
export function groupVariantsUnderBase(personas: readonly Persona[]): Persona[] {
  const bases = new Set(personas.filter((persona) => !persona.variantOf).map((p) => p.id));
  const grouped = new Map<string, Persona[]>();
  const rows: Persona[] = [];

  for (const persona of personas) {
    if (persona.variantOf && bases.has(persona.variantOf)) {
      const siblings = grouped.get(persona.variantOf);
      if (siblings) siblings.push(persona);
      else grouped.set(persona.variantOf, [persona]);
      continue;
    }
    rows.push(persona);
  }

  // `rows` still holds the bases in their original order, so this is one ordered walk with
  // the variants spliced in behind theirs — not a re-sort with a second opinion.
  const out: Persona[] = [];
  for (const persona of rows) {
    out.push(persona);
    const siblings = grouped.get(persona.id);
    if (siblings) {
      siblings.sort(
        (a, b) =>
          (a.variantLabel ?? a.name).localeCompare(b.variantLabel ?? b.name) ||
          a.id.localeCompare(b.id),
      );
      out.push(...siblings);
    }
  }
  return out;
}

/**
 * The persona's name as plain text — `Name` or `Name (Label)` — for places that cannot show
 * a label chip: a `<select>`, a stats table, an error message. Parenthesised here only;
 * this must never feed a prompt, where the whole point of a variant is a clean name.
 */
export function personaDisplayName(persona: Persona): string {
  return persona.variantLabel ? `${persona.name} (${persona.variantLabel})` : persona.name;
}

export type PersonaNameMatch =
  | { ok: true; persona: Persona }
  | { ok: false; reason: 'none' }
  /** Two or more equally good matches. The caller reports them rather than guessing. */
  | { ok: false; reason: 'ambiguous'; candidates: Persona[] };

/**
 * Every string a persona answers to: its name, and — for a variant — "name label" and the
 * bare label. The label is what makes a group that shares one name addressable; without it
 * `/persona John Doe` could never be anything but ambiguous.
 */
function matchKeys(persona: Persona): string[] {
  const name = persona.name.toLowerCase();
  if (!persona.variantLabel) return [name];
  const label = persona.variantLabel.toLowerCase();
  return [name, `${name} ${label}`, label];
}

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
    personas.filter((persona) => matchKeys(persona).some((key) => key === q)),
    personas.filter((persona) => matchKeys(persona).some((key) => key.startsWith(q))),
    personas.filter((persona) => matchKeys(persona).some((key) => key.includes(q))),
  ];

  for (const matches of rungs) {
    if (matches.length === 1) return { ok: true, persona: matches[0]! };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches };
  }

  return { ok: false, reason: 'none' };
}
