/** Working-card projection and three-way comparison. No file I/O or prompt assembly. */
import { blankCardData } from '../card/blank.ts';
import type { CardDataV2, TavernCard } from '../types/card.ts';
import {
  type CardStash,
  SINGLE_SLOTS,
  type SingleCardSlot,
  type StashProvenance,
} from '../types/cocreator.ts';

export type DraftField = SingleCardSlot | 'alternate_greetings' | 'tags';
export type DraftValue = string | string[];
export interface DraftConflict {
  field: DraftField;
  library: DraftValue;
  draft: DraftValue;
}
export type DraftChoices = Partial<Record<DraftField | 'portrait', 'library' | 'draft'>>;
const fields: readonly DraftField[] = [...SINGLE_SLOTS, 'alternate_greetings', 'tags'];

export function projectDraft(stash: CardStash, baseline: TavernCard | null): TavernCard {
  const card = baseline ?? { spec: 'chara_card_v2', spec_version: '2.0', data: blankCardData('') };
  const data = { ...card.data };
  for (const field of SINGLE_SLOTS) data[field] = stash[field]?.text ?? '';
  data.name = data.name.trim() ? data.name : card.data.name || 'Untitled Character';
  data.alternate_greetings = stash.alternate_greetings.map((e) => e.text);
  data.tags = stash.tags.map((e) => e.text);
  return { ...card, data };
}

function value(card: TavernCard, field: DraftField): DraftValue {
  return card.data[field] ?? (field === 'tags' || field === 'alternate_greetings' ? [] : '');
}
const equal = (a: DraftValue, b: DraftValue) => JSON.stringify(a) === JSON.stringify(b);

export function compareDraft(
  baseline: TavernCard | null,
  library: TavernCard,
  draft: TavernCard,
  choices: DraftChoices = {},
) {
  const patch: Partial<CardDataV2> = {};
  const conflicts: DraftConflict[] = [];
  for (const field of fields) {
    const ours = value(draft, field);
    const theirs = value(library, field);
    if (equal(ours, theirs) || (baseline && equal(ours, value(baseline, field)))) continue;
    const conflicting = !baseline || !equal(theirs, value(baseline, field));
    if (conflicting && !choices[field]) {
      conflicts.push({ field, library: theirs, draft: ours });
      continue;
    }
    if (choices[field] === 'library') continue;
    Object.assign(patch, { [field]: ours });
  }
  return { patch, conflicts };
}

/** Replace the exact entry selected in the menu, even if greetings were reordered. */
export function replaceGreeting(
  stash: CardStash,
  id: string,
  text: string,
  provenance: StashProvenance,
): CardStash {
  if (stash.first_mes?.id === id) return { ...stash, first_mes: { id, text, provenance } };
  if (!stash.alternate_greetings.some((e) => e.id === id)) return stash;
  return {
    ...stash,
    alternate_greetings: stash.alternate_greetings.map((e) =>
      e.id === id ? { id, text, provenance } : e,
    ),
  };
}
