/**
 * The Personas tool's rules, pure so they are pinned by tests: who sits on the "you" card,
 * who is listed below it, and how a persona's placement reads as a sentence.
 */

import type { Persona } from '@shared/types/chat.ts';
import {
  matchesPersonaQuery,
  orderPersonas,
  recentGroupIds,
  variantsByBase,
} from '../features/persona/personaRoster.ts';

export interface PersonaRow {
  persona: Persona;
  /** How many variants the row stands for besides itself. Zero for a plain persona. */
  variants: number;
}

export interface PersonaRoster {
  /** The persona you're writing as, or null for none (or one that no longer exists). */
  you: Persona | null;
  /** Your persona's group, base first: the tabs on the card. Empty without variants. */
  tabs: Persona[];
  /** Everyone else, most recently used first, then A–Z. */
  others: PersonaRow[];
}

/**
 * The roster around the persona you're writing as.
 *
 * A persona and its variants are one row, standing on the base. Your own group sits on
 * the card instead, so it is not listed again. A search flattens the groups: every match,
 * variants included, is its own row, because the one you are looking for may be a variant.
 */
export function personaRoster(
  personas: readonly Persona[],
  activeId: string | null,
  recentIds: readonly string[],
  query: string,
): PersonaRoster {
  const you = personas.find((persona) => persona.id === activeId) ?? null;
  const groups = variantsByBase(personas);
  const baseOf = (persona: Persona) =>
    persona.variantOf && groups.has(persona.variantOf) ? persona.variantOf : persona.id;
  const yourBase = you ? baseOf(you) : null;
  const yourBasePersona = yourBase
    ? (personas.find((persona) => persona.id === yourBase) ?? null)
    : null;
  const yourVariants = yourBase ? (groups.get(yourBase) ?? []) : [];
  const tabs = yourBasePersona && yourVariants.length ? [yourBasePersona, ...yourVariants] : [];

  const recent = recentGroupIds(personas, recentIds);
  if (query.trim()) {
    const matches = personas.filter(
      (persona) => persona.id !== activeId && matchesPersonaQuery(persona, query),
    );
    const { recent: first, rest } = orderPersonas(matches, recent);
    return { you, tabs, others: [...first, ...rest].map((persona) => ({ persona, variants: 0 })) };
  }

  const absorbed = new Set<string>();
  for (const siblings of groups.values()) for (const persona of siblings) absorbed.add(persona.id);
  const rows = personas.filter(
    (persona) => !absorbed.has(persona.id) && baseOf(persona) !== yourBase,
  );
  const { recent: first, rest } = orderPersonas(rows, recent);
  return {
    you,
    tabs,
    others: [...first, ...rest].map((persona) => ({
      persona,
      variants: groups.get(persona.id)?.length ?? 0,
    })),
  };
}

export type PersonaPosition = NonNullable<Persona['position']>;
export type PersonaRole = NonNullable<Persona['role']>;

/** Where a description can go, as the word that finishes "Sent …". */
export const POSITION_WORDS: readonly { value: PersonaPosition; label: string }[] = [
  { value: 'inPrompt', label: 'in the prompt, at the persona marker' },
  { value: 'topAuthorNote', label: 'above the Author’s Note' },
  { value: 'bottomAuthorNote', label: 'below the Author’s Note' },
  { value: 'atDepth', label: 'into the chat' },
  { value: 'none', label: 'nowhere' },
];

export const ROLE_WORDS: readonly { value: PersonaRole; label: string }[] = [
  { value: 'system', label: 'system' },
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
];

/** How deep into the chat, in words. Zero is after the last message. */
export function depthWords(depth: number): string {
  if (depth <= 0) return 'after the last message';
  return depth === 1 ? '1 message from the end' : `${depth} messages from the end`;
}

/** The depths offered: 0 to 20, and the persona's own when it was set deeper by hand. */
export function depthChoices(current: number): { value: number; label: string }[] {
  const depths = Array.from({ length: 21 }, (_, depth) => depth);
  if (current > 20) depths.push(current);
  return depths.map((value) => ({ value, label: depthWords(value) }));
}

/** The placement, short, for the card's facts line. */
export function placementShort(persona: Persona): string {
  switch (persona.position ?? 'inPrompt') {
    case 'inPrompt':
      return 'In the prompt';
    case 'topAuthorNote':
      return 'Above the Author’s Note';
    case 'bottomAuthorNote':
      return 'Below the Author’s Note';
    case 'atDepth':
      return `${persona.role ?? 'system'}, ${depthWords(persona.depth ?? 2)}`;
    case 'none':
      return 'Only through {{persona}}';
  }
}
