/**
 * Cards from the user's own library, rendered as few-shot examples for the design assistant.
 *
 * This is the co-creator's one real advantage over designing a card in a general chat app:
 * the examples are cards the user already chose to keep, so "write it like these" is a
 * concrete instruction rather than an adjective.
 *
 * Rendered as readable labelled text, never as JSON. A model shown a JSON card tends to
 * answer with a JSON card, and the whole handover contract here is fenced prose blocks.
 *
 * Only avatar filenames are stored on a session; the cards are read live at prompt-build
 * time. So an example edited in the Studio is immediately what the model sees, and a deleted
 * one degrades to "missing" rather than to a stale snapshot.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import {
  DEFAULT_EXAMPLE_FIELDS,
  type ExampleField,
  type ExampleFields,
  type ExampleSelection,
} from '@shared/types/cocreator.ts';

export const EXAMPLE_FIELD_ORDER: readonly ExampleField[] = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'tags',
  'alternate_greetings',
  'mes_example',
  'character_book',
];

export const EXAMPLE_FIELD_LABELS: Readonly<Record<ExampleField, string>> = {
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  first_mes: 'First message',
  tags: 'Tags',
  alternate_greetings: 'Alternate greetings',
  mes_example: 'Example dialogue',
  character_book: 'Embedded lorebook',
};

export function emptyExampleSelection(): ExampleSelection {
  return { cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } };
}

export interface RenderedExample {
  avatar: string;
  name: string;
  /** Readable labelled text, including this example's own heading. */
  text: string;
  tokens: number;
}

export interface RenderedExamples {
  /** The whole block, ready to be one system message. Empty when nothing is attached. */
  text: string;
  examples: RenderedExample[];
  /** Tokens for the whole block, including the framing preamble. */
  tokens: number;
}

export const EXAMPLE_PREAMBLE =
  "The following are example character cards from the user's own library. They show the " +
  'style, length and level of detail the user likes. Study how they are written — voice, ' +
  'structure, formatting, how much is stated versus implied — and carry that register into ' +
  'the card you are helping build. Do not reuse their characters, names, settings or ' +
  'phrasing, and do not treat any of them as the character being designed.';

function section(label: string, value: string | undefined): string {
  // A blank field is omitted rather than emitted as an empty heading: an empty label teaches
  // the model that empty is an acceptable answer.
  const text = value?.trim();
  return text ? `${label}:\n${text}\n\n` : '';
}

function renderBook(card: CardDataV2): string {
  // The EMBEDDED book's `entries` is an array (unlike a standalone lorebook's numeric-keyed
  // object), so plain iteration is correct here and the `bookEntries()` ordering rule does
  // not apply. It looks like it should.
  const entries = card.character_book?.entries ?? [];
  const lines = entries
    .filter((entry) => entry.enabled !== false && entry.content.trim())
    .map((entry) => `- ${entry.keys.join(', ') || '(no keys)'} → ${entry.content.trim()}`);
  return lines.length ? `Lorebook:\n${lines.join('\n')}\n\n` : '';
}

/** Render one example card. `index` is 1-based and appears in the heading. */
export function renderExample(
  card: CardDataV2,
  avatar: string,
  index: number,
  fields: ExampleFields,
  count: TokenCounter,
): RenderedExample {
  const name = card.name?.trim() || 'Unnamed';
  let text = `### Example card ${index} — ${name}\n\n`;

  if (fields.tags && card.tags?.length) text += `Tags: ${card.tags.join(', ')}\n\n`;
  if (fields.description) text += section('Description', card.description);
  if (fields.personality) text += section('Personality', card.personality);
  if (fields.scenario) text += section('Scenario', card.scenario);
  if (fields.first_mes) text += section('First message', card.first_mes);

  if (fields.alternate_greetings && card.alternate_greetings?.length) {
    const listed = card.alternate_greetings
      .filter((greeting) => greeting.trim())
      .map((greeting, i) => `${i + 1}. ${greeting.trim()}`)
      .join('\n\n');
    if (listed) text += `Alternate greetings:\n${listed}\n\n`;
  }
  // `<START>` markers are left verbatim: they are the format, and a model shown them writes
  // example dialogue that already parses.
  if (fields.mes_example) text += section('Example dialogue', card.mes_example);
  if (fields.character_book) text += renderBook(card);

  const trimmed = `${text.trimEnd()}\n`;
  return { avatar, name, text: trimmed, tokens: count.countText(trimmed) };
}

export interface ExampleCard {
  avatar: string;
  card: CardDataV2;
}

export function renderExamples(
  cards: readonly ExampleCard[],
  fields: ExampleFields,
  count: TokenCounter,
): RenderedExamples {
  if (cards.length === 0) return { text: '', examples: [], tokens: 0 };

  const examples = cards.map((entry, index) =>
    renderExample(entry.card, entry.avatar, index + 1, fields, count),
  );
  const text = `${EXAMPLE_PREAMBLE}\n\n${examples.map((example) => example.text).join('\n')}`;
  return { text, examples, tokens: count.countText(text) };
}
