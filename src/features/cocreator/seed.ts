/**
 * Seeding a design session from an existing card — the Studio's handoff.
 *
 * The user already has a character they like and wants help extending it (an alternate
 * scenario, a new greeting) rather than building one from scratch. Both halves of the seed
 * follow the co-creator's existing invariants:
 *
 *  - The transcript turn is visible user text, exactly like "Show the assistant": everything
 *    the model sees is in the transcript the user can read. The seed is not a hidden system
 *    parameter, so the user can verify what the model was shown, edit it, or delete it — and
 *    on a long session the packer may drop it exactly like any other old turn.
 *  - The pre-filled stash is the same stash "Use as" writes into, so Finish produces a
 *    complete variant of the card rather than a hollow one holding only the fields the model
 *    happened to propose. The model still never writes a field: the seed is the user's own
 *    card, and each entry's provenance records that (`source: 'seed'`).
 *
 * The turn deliberately carries MORE than the stash can (the embedded lorebook): the model
 * needs the card's lore to write a coherent variant, while Finish copies the lorebook itself
 * through the session's seed reference rather than through slots.
 */

import { timestamp } from '@shared/chat/message.ts';
import type { CharacterDetail } from '@shared/types/card.ts';
import { type CardStash, SINGLE_SLOTS, type StashEntry } from '@shared/types/cocreator.ts';
import { renderBook, section } from './examples.ts';

export const SEED_TURN_PREAMBLE =
  'This is the character we are working on together — not an example to imitate, but the ' +
  'card itself, exactly as it stands today. Everything below defines this character; keep it ' +
  'in mind for every suggestion, and propose card content in the same labelled blocks as ' +
  'always.';

/** The card as the opening user turn of a seeded session. Readable text, never JSON. */
export function renderSeedTurn(detail: CharacterDetail): string {
  const card = detail.card.data;

  let text = `### The character — ${card.name?.trim() || 'Unnamed'}\n\n`;
  if (card.tags?.length) text += `Tags: ${card.tags.join(', ')}\n\n`;
  text += section('Description', card.description);
  text += section('Personality', card.personality);
  text += section('Scenario', card.scenario);
  text += section('First message', card.first_mes);

  const listed = (card.alternate_greetings ?? [])
    .filter((greeting) => greeting.trim())
    .map((greeting, index) => `${index + 1}. ${greeting.trim()}`)
    .join('\n\n');
  if (listed) text += `Alternate greetings:\n${listed}\n\n`;

  text += section('Example dialogue', card.mes_example);
  text += section('System prompt', card.system_prompt);
  text += section('Post-history instructions', card.post_history_instructions);
  text += section('Creator notes', card.creator_notes);
  text += renderBook(card);

  return `${SEED_TURN_PREAMBLE}\n\n${text.trimEnd()}\n`;
}

/**
 * The card's fields pre-filed into the stash.
 *
 * Alternate greetings keep their card order — the order is semantic (it becomes the opening
 * message's swipes). Tags come from the card's own array rather than a comma split: the card
 * already holds the list, and splitting a tag containing a comma would corrupt it.
 */
export function seedStash(detail: CharacterDetail, messageId: string): CardStash {
  const card = detail.card.data;
  const entry = (text: string): StashEntry => ({
    id: crypto.randomUUID(),
    text,
    provenance: {
      messageId,
      swipeIndex: 0,
      at: timestamp(),
      source: 'seed',
    },
  });

  const stash: CardStash = { alternate_greetings: [], tags: [] };
  for (const slot of SINGLE_SLOTS) {
    const value = card[slot];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) stash[slot] = entry(text);
  }
  for (const greeting of card.alternate_greetings ?? []) {
    const text = greeting.trim();
    if (text) stash.alternate_greetings.push(entry(text));
  }
  for (const tag of card.tags ?? []) {
    const text = tag.trim();
    if (text) stash.tags.push(entry(text));
  }
  return stash;
}
