/**
 * A character card, arranged for reading mid-conversation.
 *
 * The question this answers is "what colour is her hair", asked three hundred messages in,
 * by someone who does not want to leave the chat to find out. The card is already in
 * memory; what it lacks is a shape you can scan.
 *
 * So this builds a list of sections, by a ladder that always terminates:
 *
 *   headings  the field's own headings, when it has two or more of one style
 *   groups    its PList / W++ groups, same rule
 *   fields    Description, Personality, Scenario, Examples, Lorebook
 *   raw       one section holding the whole card
 *
 * The rungs above `fields` are the guess, and they are allowed to fail — `cardStructure.ts`
 * returns `null` and the field simply stays whole. That is deliberate and load-bearing: the
 * cards this will meet were written by strangers, so a feature that depended on parsing
 * them would be a feature that works on the author's own library and nowhere else.
 *
 * Two invariants hold the design up, and both are asserted in `cardSheet.test.ts` rather
 * than merely intended:
 *
 *  - **A split refines a field; it never replaces the card.** A description that divides
 *    into Appearance and Backstory still leaves Personality, Scenario, Examples and the
 *    lorebook as their own sections. A guess can therefore cost you a section chip you
 *    ignore, but never a section you cannot reach.
 *  - **Sections partition their field exactly.** Every character of every field lands in
 *    exactly one section. Nothing is summarised, reordered, or dropped.
 *
 * Pure, like `creatorNotes.ts` beside it and for the same reason: there is no DOM harness
 * in this project, so the part worth testing has to be reachable without one.
 */

import type { CardDataV2, CharacterBook } from '@shared/types/card.ts';
import { type FieldSplit, type SplitStyle, splitCardText } from './cardStructure.ts';

/** The card text worth reading back. Order is the order the sections appear in. */
export type CardField = 'description' | 'personality' | 'scenario' | 'mes_example' | 'lorebook';

const FIELD_ORDER: readonly CardField[] = [
  'description',
  'personality',
  'scenario',
  'mes_example',
  'lorebook',
];

export const CARD_FIELD_LABELS: Readonly<Record<CardField, string>> = {
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  mes_example: 'Examples',
  lorebook: 'Lorebook',
};

/**
 * Fields a split may be attempted on.
 *
 * Example dialogue and the lorebook are excluded on purpose. Both are already transcripts
 * of a sort — `{{char}}: Hello` lines, entries with their own keys — and every heuristic in
 * `cardStructure.ts` false-positives on them, which would turn one readable section into
 * forty chips named after whatever the speaker said first.
 */
const STRUCTURED_FIELDS: readonly CardField[] = ['description', 'personality', 'scenario'];

/** Which rung of the ladder produced a sheet's sections. */
export type CardSheetRung = 'headings' | 'groups' | 'fields' | 'raw';

/** Where a section came from, so the view can explain itself if it ever needs to. */
export type CardSectionSource =
  | { kind: 'field'; field: CardField }
  | { kind: 'split'; field: CardField; style: SplitStyle }
  | { kind: 'card' };

export interface CardSection {
  /**
   * Stable across re-parses, and derived from the field and the label rather than from a
   * position — so the section you had open survives an edit that adds a paragraph above it.
   */
  id: string;
  /** The card's own words, tidied. Never invented. */
  label: string;
  text: string;
  source: CardSectionSource;
}

export interface CardSheet {
  rung: CardSheetRung;
  /** Never empty. Exactly one entry when `rung` is `raw`. */
  sections: CardSection[];
}

/**
 * Labels that mean "what they look like".
 *
 * Normalised forms — see `normalizeSectionLabel`. This is the one place the app guesses at
 * meaning rather than structure, and it earns it: appearance is what people open the sheet
 * for, so opening on it is right far more often than opening on whatever came first.
 */
export const APPEARANCE_ALIASES: ReadonlySet<string> = new Set([
  'appearance',
  'appearances',
  'physical-appearance',
  'physical-description',
  'physical',
  'looks',
  'body',
  'features',
]);

/** Lowercased, with every run of non-alphanumerics folded to a single dash. */
export function normalizeSectionLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A lorebook rendered as one readable block.
 *
 * Keys are included, not just content: an entry about a scar is keyed on "scar" and may
 * never say the word in its body, so dropping the keys would make the entry unfindable by
 * the only term anyone would search for. Disabled entries are included too — they are still
 * part of what the card says, and this is a reading surface, not a prompt preview.
 */
export function formatBookSection(book: CharacterBook | undefined): string {
  if (!book?.entries?.length) return '';

  return book.entries
    .map((entry) => {
      const keys = (entry.keys ?? []).map((key) => key.trim()).filter(Boolean);
      const title = [entry.comment?.trim(), keys.join(', ')].filter(Boolean).join(' — ');
      return [title, (entry.content ?? '').trim()].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build the sheet for a card.
 *
 * `render` resolves macros — the same pass the greeting gets, so `{{user}}` in a
 * description reads as the persona's name rather than as braces. It runs on a fresh
 * runtime, so a `{{setvar}}` hiding in a description cannot write to the chat by being
 * read.
 */
export function readCardSheet(
  card: CardDataV2,
  render: (text: string) => string = identity,
): CardSheet {
  const fields = FIELD_ORDER.map((field) => ({
    field,
    text: render(fieldText(card, field)),
  })).filter((entry) => entry.text.trim());

  const sections: CardSection[] = [];
  let rung: CardSheetRung = 'fields';

  for (const { field, text } of fields) {
    const split = STRUCTURED_FIELDS.includes(field)
      ? splitCardText(text, CARD_FIELD_LABELS[field])
      : null;
    if (!split) {
      sections.push({
        id: `field:${field}`,
        label: CARD_FIELD_LABELS[field],
        text,
        source: { kind: 'field', field },
      });
      continue;
    }
    rung = betterRung(rung, split.style);
    sections.push(...splitSections(field, text, split));
  }

  /*
   * One section is not an index.
   *
   * A card with only a description would otherwise open on a chip row of one, which reads
   * as a broken tab bar rather than as a card with a single field. The floor drops the row
   * entirely and shows the text, which is all a one-field card ever had to offer.
   */
  if (sections.length < 2) {
    return {
      rung: 'raw',
      sections: [
        {
          id: 'card',
          label: 'Card',
          text: sections[0]?.text ?? '',
          source: { kind: 'card' },
        },
      ],
    };
  }

  return { rung, sections: withUniqueIds(sections) };
}

/**
 * Which section to open on a card nobody has opened before.
 *
 * Appearance where the card offers it, under any of its usual names; otherwise the first
 * section, which at the field rung is the description — the closest thing to "the card"
 * that a card has.
 */
export function defaultSectionId(sheet: CardSheet): string {
  const appearance = sheet.sections.find((section) =>
    APPEARANCE_ALIASES.has(normalizeSectionLabel(section.label)),
  );
  return (appearance ?? sheet.sections[0])?.id ?? 'card';
}

/** The section matching `id`, or the default when it names one the card no longer has. */
export function resolveSectionId(sheet: CardSheet, id: string | null): string {
  if (id && sheet.sections.some((section) => section.id === id)) return id;
  return defaultSectionId(sheet);
}

function identity(text: string): string {
  return text;
}

function fieldText(card: CardDataV2, field: CardField): string {
  if (field === 'lorebook') return formatBookSection(card.character_book);
  return typeof card[field] === 'string' ? (card[field] as string) : '';
}

/** Slice a split field into its sections, keeping every character. */
function splitSections(field: CardField, text: string, split: FieldSplit): CardSection[] {
  return split.parts.map((part) => ({
    id: `${field}:${normalizeSectionLabel(part.label) || 'section'}`,
    label: part.label,
    text: text.slice(part.start, part.end),
    source: { kind: 'split' as const, field, style: split.style },
  }));
}

const RUNG_RANK: Readonly<Record<CardSheetRung, number>> = {
  raw: 0,
  fields: 1,
  groups: 2,
  headings: 3,
};

function betterRung(current: CardSheetRung, style: SplitStyle): CardSheetRung {
  const found: CardSheetRung = style === 'plist' || style === 'wpp' ? 'groups' : 'headings';
  return RUNG_RANK[found] > RUNG_RANK[current] ? found : current;
}

/**
 * Two headings can share a name — a card with an Appearance under both a human and a
 * werewolf form is not malformed, it is thorough. Ids have to stay unique anyway, since
 * they are what the section memory and the chip keys are built on.
 */
function withUniqueIds(sections: CardSection[]): CardSection[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const count = (seen.get(section.id) ?? 0) + 1;
    seen.set(section.id, count);
    return count === 1 ? section : { ...section, id: `${section.id}-${count}` };
  });
}
