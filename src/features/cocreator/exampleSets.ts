/**
 * Co-Creator Example Sets logic and helpers.
 *
 * Pure and separate from the UI popover so all set operations (adding, updating,
 * removing, renaming) are unit-tested without React.
 */

import type { ExampleFields, ExampleSet } from '@shared/types/cocreator.ts';

/** The lowest free `Set N`, so creating sets without typing a name avoids collision. */
export function nextSetName(sets: readonly ExampleSet[]): string {
  const taken = new Set(
    sets
      .map((set) => /^Set (\d+)$/.exec(set.name)?.[1])
      .filter((n): n is string => n !== undefined),
  );

  let n = 1;
  while (taken.has(String(n))) n += 1;
  return `Set ${n}`;
}

export function createExampleSet(
  name: string,
  cards: readonly string[],
  fields: ExampleFields,
  id: string = crypto.randomUUID(),
): ExampleSet {
  return {
    id,
    name: name.trim(),
    cards: [...cards],
    fields: { ...fields },
  };
}

export function addExampleSet(
  sets: readonly ExampleSet[],
  name: string,
  cards: readonly string[],
  fields: ExampleFields,
  id: string = crypto.randomUUID(),
): ExampleSet[] {
  const effectiveName = name.trim() || nextSetName(sets);
  return [...sets, createExampleSet(effectiveName, cards, fields, id)];
}

export function updateExampleSet(
  sets: readonly ExampleSet[],
  id: string,
  patch: Partial<Omit<ExampleSet, 'id'>>,
): ExampleSet[] {
  return sets.map((set) => {
    if (set.id !== id) return set;
    return {
      ...set,
      ...patch,
      ...(patch.cards ? { cards: [...patch.cards] } : {}),
      ...(patch.fields ? { fields: { ...patch.fields } } : {}),
    };
  });
}

export function removeExampleSet(sets: readonly ExampleSet[], id: string): ExampleSet[] {
  return sets.filter((set) => set.id !== id);
}
