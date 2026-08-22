/**
 * The card being assembled out of a design conversation.
 *
 * The model never writes here. Every entry arrived because the user clicked "Use as →
 * <field>" on something they had read, which is the whole difference between this feature
 * and an auto-filling character generator.
 *
 * Each entry keeps its provenance — which message and which swipe it came from, and which
 * model wrote it — because free model swapping means a finished card can be the work of
 * three different models, and "where did this line come from" is a question the user will
 * ask while tuning it in the Studio.
 *
 * Pure and shared for the same reason `shared/chat/message.ts` is: the client manipulates a
 * stash, and the server has to count its filled slots for the session list. One
 * implementation, so the badge cannot disagree with the panel.
 */

import type { CardDataV2 } from '../types/card.ts';
import {
  type CardSlot,
  type CardStash,
  SINGLE_SLOTS,
  type SingleCardSlot,
  type StashEntry,
  type StashProvenance,
} from '../types/cocreator.ts';

export function emptyStash(): CardStash {
  return { alternate_greetings: [], tags: [] };
}

function isSingle(slot: CardSlot): slot is SingleCardSlot {
  return slot !== 'alternate_greeting' && slot !== 'tags';
}

/** Whether assigning to this slot would destroy something — the two-click confirm's test. */
export function isSlotFilled(stash: CardStash, slot: CardSlot): boolean {
  // Appending to a list never destroys anything, so a list slot is never "filled".
  return isSingle(slot) && Boolean(stash[slot]?.text);
}

/**
 * File text into a slot.
 *
 * Single slots replace. `alternate_greeting` appends one entry. `tags` splits on commas and
 * appends each new tag, skipping any already present under a different case — a tag list
 * grows across a conversation, and replacing it on every mention would lose the ones agreed
 * earlier.
 */
export function setSlot(
  stash: CardStash,
  slot: CardSlot,
  text: string,
  provenance: StashProvenance,
): CardStash {
  if (isSingle(slot)) {
    return { ...stash, [slot]: { id: crypto.randomUUID(), text, provenance } };
  }

  if (slot === 'alternate_greeting') {
    if (!text.trim()) return stash;
    return {
      ...stash,
      alternate_greetings: [
        ...stash.alternate_greetings,
        { id: crypto.randomUUID(), text, provenance },
      ],
    };
  }

  const seen = new Set(stash.tags.map((entry) => entry.text.toLowerCase()));
  const added: StashEntry[] = [];
  for (const raw of text.split(',')) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    added.push({ id: crypto.randomUUID(), text: tag, provenance });
  }
  if (added.length === 0) return stash;
  return { ...stash, tags: [...stash.tags, ...added] };
}

export function editSlot(stash: CardStash, slot: SingleCardSlot, text: string): CardStash {
  const entry = stash[slot];
  if (!entry) return stash;
  return { ...stash, [slot]: { ...entry, text, edited: true } };
}

export function editGreeting(stash: CardStash, index: number, text: string): CardStash {
  const entry = stash.alternate_greetings[index];
  if (!entry) return stash;
  const alternate_greetings = [...stash.alternate_greetings];
  alternate_greetings[index] = { ...entry, text, edited: true };
  return { ...stash, alternate_greetings };
}

/** Move one greeting to a new index, shifting the rest — a permutation, not a swap. */
export function reorderGreetings(stash: CardStash, from: number, to: number): CardStash {
  const list = stash.alternate_greetings;
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return stash;
  const alternate_greetings = [...list];
  const [moved] = alternate_greetings.splice(from, 1);
  alternate_greetings.splice(to, 0, moved!);
  return { ...stash, alternate_greetings };
}

export function removeGreeting(stash: CardStash, index: number): CardStash {
  if (index < 0 || index >= stash.alternate_greetings.length) return stash;
  return { ...stash, alternate_greetings: stash.alternate_greetings.filter((_, i) => i !== index) };
}

export function removeTag(stash: CardStash, index: number): CardStash {
  if (index < 0 || index >= stash.tags.length) return stash;
  return { ...stash, tags: stash.tags.filter((_, i) => i !== index) };
}

/** Empty one slot. Clearing a list slot empties the whole list. */
export function clearSlot(stash: CardStash, slot: CardSlot): CardStash {
  if (slot === 'alternate_greeting') {
    return stash.alternate_greetings.length === 0 ? stash : { ...stash, alternate_greetings: [] };
  }
  if (slot === 'tags') {
    return stash.tags.length === 0 ? stash : { ...stash, tags: [] };
  }
  // Identity when there was nothing there: an edit that changes nothing must not dirty the
  // session and cost a revision, the same rule `message/setHidden` follows.
  if (!stash[slot]) return stash;
  const next = { ...stash };
  delete next[slot];
  return next;
}

export function clearAll(): CardStash {
  return emptyStash();
}

/** How many slots carry something — the session list's badge. */
export function stashedSlotCount(stash: CardStash): number {
  let count = SINGLE_SLOTS.filter((slot) => Boolean(stash[slot]?.text)).length;
  if (stash.alternate_greetings.length > 0) count += 1;
  if (stash.tags.length > 0) count += 1;
  return count;
}

/**
 * Project to the patch Finish sends to `PATCH /api/characters/:avatar`.
 *
 * Only filled slots appear: an absent slot must not blank a field. `name` is deliberately
 * never emitted — it is the card's filename identity and goes through create/rename. Nor is
 * `character_book` or `extensions`: `mergeCardData`'s spread is shallow (server/lib/card.ts:199),
 * so a book in a patch would replace the stored one wholesale, which is exactly why lorebook
 * entries are not a stashable slot. Their correct path is the per-entry endpoints.
 */
export function toCardPatch(stash: CardStash): Partial<CardDataV2> {
  const patch: Partial<CardDataV2> = {};
  for (const slot of SINGLE_SLOTS) {
    if (slot === 'name') continue;
    const entry = stash[slot];
    if (entry?.text) patch[slot] = entry.text;
  }
  if (stash.alternate_greetings.length > 0) {
    patch.alternate_greetings = stash.alternate_greetings.map((entry) => entry.text);
  }
  if (stash.tags.length > 0) {
    patch.tags = stash.tags.map((entry) => entry.text);
  }
  return patch;
}

function normalizeProvenance(raw: unknown): StashProvenance {
  const value = (raw ?? {}) as Partial<StashProvenance>;
  const source = value.source;
  const provenance: StashProvenance = {
    messageId: typeof value.messageId === 'string' ? value.messageId : '',
    swipeIndex: Number.isSafeInteger(value.swipeIndex)
      ? Math.max(0, value.swipeIndex as number)
      : 0,
    at: typeof value.at === 'string' ? value.at : '',
    source: source === 'block' || source === 'selection' || source === 'seed' ? source : 'message',
  };
  if (typeof value.model === 'string') provenance.model = value.model;
  if (typeof value.label === 'string') provenance.label = value.label;
  return provenance;
}

function normalizeEntry(raw: unknown): StashEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<StashEntry>;
  if (typeof value.text !== 'string') return null;
  const entry: StashEntry = {
    // Minted only when missing, so an entry keeps its identity across a round-trip.
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    text: value.text,
    provenance: normalizeProvenance(value.provenance),
  };
  if (value.edited) entry.edited = true;
  return entry;
}

function normalizeList(raw: unknown): StashEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeEntry)
    .filter((entry): entry is StashEntry => entry !== null && entry.text.length > 0);
}

/**
 * Repair a stash read back from the database.
 *
 * The single normalisation point, for the same reason `normalizeState` is one for a message
 * row: a hand-edited database or an older build's shape must not produce a stash the rest of
 * this module has to defend against.
 */
export function normalizeStash(raw: unknown): CardStash {
  if (!raw || typeof raw !== 'object') return emptyStash();
  const value = raw as Record<string, unknown>;
  const stash: CardStash = {
    alternate_greetings: normalizeList(value.alternate_greetings),
    tags: normalizeList(value.tags),
  };
  for (const slot of SINGLE_SLOTS) {
    const entry = normalizeEntry(value[slot]);
    if (entry) stash[slot] = entry;
  }
  return stash;
}
