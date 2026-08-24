/**
 * Deriving a user persona from a character card: what the model is sent, and what it is
 * allowed to say back.
 *
 * Pure, like everything else in `shared/` — no I/O, no provider, no React. The run loop lives
 * in `src/features/persona/usePersonaDerive.ts`; this file owns the prompt shape and, more
 * importantly, the contract for reading a reply back.
 *
 * Three rules run through the whole file:
 *
 *  - **Omit, never invent.** A fact the card does not state gets no line. The contract asks
 *    the model to leave it out, and `parseDerivedPersona` drops `unknown` / `N/A` / `—`
 *    values anyway — prompt compliance must not be the only thing standing between the user
 *    and an invented age. A persona rides in *every* request, so a wrong fact there is read
 *    as true for the life of the character.
 *  - **The model returns facts, not prose.** It answers with labelled fields and
 *    `renderPersonaDescription` writes the house format. A finished string could not be
 *    clamped per fact, and the format would drift model to model.
 *  - **The contract is strict; the parser is tolerant, then clamped.** Same shape as
 *    `shared/memory/extract.ts`. A model that ignores the contract produces a messier draft,
 *    never a broken one and never one that blows the token budget.
 */

import { looseParseJson } from '../providers/looseJson.ts';
import type { ApiMessage } from '../types/chat.ts';

/** One `Label: value` line of a persona description. */
export interface PersonaField {
  label: string;
  value: string;
}

export interface DerivedPersona {
  /** Short name to file the persona under. Never empty — falls back to the card's name. */
  name: string;
  fields: PersonaField[];
  /** Set when the reply could not be read at all. `fields` is empty when present. */
  error?: string;
}

/**
 * The card fields that reach the model, macros already resolved by the caller.
 *
 * The absent fields are the point. `scenario` is left out because a persona is reused across
 * every chat, so a situational line ("she is trapped in the tower") is wrong the moment you
 * start a different story — and there is no single canonical scenario to send anyway, since
 * `ChatMetadata.scenario` overrides the card's per chat. `mes_example` is voice rather than
 * identity, `creator_notes` is written for the human, and `tags` are library metadata.
 */
export interface PersonaSourceProfile {
  name: string;
  description?: string;
  personality?: string;
  /** The head of `first_mes` — often the only place appearance is actually stated. */
  firstMessage?: string;
}

/**
 * The labels a derived persona may use, in the order they are written.
 *
 * Nine of these come from the hand-written personas in `data/personas`. `Species` is the
 * exception: cards are routinely non-human and "Elf" is an identity fact, not prose, so it
 * needs a canonical slot rather than landing in the free tail after `Physical`.
 */
export const PERSONA_FIELD_LABELS = [
  'Name',
  'Age',
  'Gender',
  'Species',
  'Nationality',
  'Height',
  'Body',
  'Hair',
  'Eyes',
  'Physical',
] as const;

export type PersonaFieldLabel = (typeof PERSONA_FIELD_LABELS)[number];

/**
 * Labels that mean one of ours under a different name.
 *
 * Deliberately conservative — only true synonyms. `ethnicity` is **not** mapped onto
 * `Nationality`: they are different facts and merging them would silently collapse two
 * entries into one. It lands in the free tail instead, which costs the user one keystroke
 * if they disagree and costs them a fact if we guessed.
 */
const LABEL_SYNONYMS: Readonly<Record<string, PersonaFieldLabel>> = {
  'full name': 'Name',
  'character name': 'Name',
  sex: 'Gender',
  race: 'Species',
  origin: 'Nationality',
  build: 'Body',
  figure: 'Body',
  physique: 'Body',
  'body type': 'Body',
  'hair colour': 'Hair',
  'hair color': 'Hair',
  hairstyle: 'Hair',
  'eye colour': 'Eyes',
  'eye color': 'Eyes',
  'distinguishing features': 'Physical',
  'distinguishing marks': 'Physical',
  'notable features': 'Physical',
  features: 'Physical',
  marks: 'Physical',
};

/**
 * Labels that would put back exactly what the house format leaves out.
 *
 * Unknown labels are otherwise *kept* (see `MAX_EXTRA_FIELDS`), because a stray label costs
 * one keystroke in the draft while a dropped fact costs a re-read of the card. This list is
 * what stops that tolerance from smuggling personality prose and backstory back in.
 */
const BLOCKED_LABELS: ReadonlySet<string> = new Set([
  'personality',
  'traits',
  'temperament',
  'demeanour',
  'demeanor',
  'backstory',
  'background',
  'history',
  'story',
  'scenario',
  'setting',
  'situation',
  'plot',
  'relationships',
  'likes',
  'dislikes',
  'quirks',
  'habits',
  'motivation',
  'motivations',
  'goals',
  'fears',
  'secrets',
  'speech',
  'voice',
  'dialogue',
  'example',
  'examples',
  'greeting',
  'first message',
  'abilities',
  'powers',
  'skills',
  'equipment',
  'inventory',
  'occupation',
  'summary',
  'description',
]);

/** Hard caps, applied after parsing. A model that ignores the contract cannot blow the budget. */
export const MAX_FIELDS = 12;
const MAX_EXTRA_FIELDS = 3;
const MAX_LABEL_CHARS = 24;
const MAX_VALUE_CHARS = 120;
/** A truncation shorter than this is not worth backing up to a word boundary for. */
const MIN_VALUE_CHARS = 80;
const MAX_NAME_CHARS = 60;

/** How much of `first_mes` is sent. Appearance is described in the opening; dialogue fills the tail. */
const MAX_OPENING_CHARS = 1200;
/** A paragraph break this close to the cut is used instead of a hard cut. */
const OPENING_BREAK_WINDOW = 200;

/**
 * Values that mean "the card did not say".
 *
 * Dropping these is where "omit, never invent" is enforced in *code* rather than left to the
 * model doing as it was told.
 */
const PLACEHOLDER_VALUE =
  /^(unknown|undisclosed|unspecified|not (stated|specified|given|mentioned|said)|n\/?a|none|null|nil|-+|—+|\?+)$/i;

/**
 * Style guidance only. The output contract is appended by `buildDerivationMessages` and is
 * deliberately not part of this string: someone rewriting the style must not be able to
 * break parsing, because a reply that no longer parses is the one failure they could not
 * diagnose from the panel.
 */
export const DEFAULT_PERSONA_DERIVE_PROMPT =
  'You are given a roleplay character. Reduce them to a short player profile — the handful of plain facts someone would need in order to play as this character: who they are and what they look like.\n\nWrite only what the source states or shows directly. If it never says how old they are, leave age out. If it never gives their nationality, leave it out. Do not estimate, do not infer from context, and do not fill a gap because the gap looks untidy — an omitted fact costs the reader nothing, and a guessed one is read as true forever.\n\nKeep every value to a short phrase, not a sentence. Record appearance and identity: age, gender, species, where they are from, height, build, hair, eyes, and any distinguishing physical feature. Do not record temperament, manner, backstory, relationships, abilities, possessions, or the situation they happen to be in — none of that belongs in a player profile, and the profile is reused across completely different stories.';

/**
 * The output contract. Not editable, appended after the style prompt.
 *
 * Strict on purpose, against a tolerant parser: telling the model "only these labels" keeps
 * it tight, while `parseDerivedPersona` still refuses to throw away a fact just because the
 * model got creative with a label.
 */
export const PERSONA_JSON_CONTRACT = `Reply with a single JSON object and nothing else. No prose before or after it, no code fence.

{
  "name": "Iris",
  "fields": [
    { "label": "Name", "value": "Iris Benedetti" },
    { "label": "Age", "value": "23" },
    { "label": "Gender", "value": "Female" },
    { "label": "Nationality", "value": "Italian" },
    { "label": "Height", "value": "5'6\\"" },
    { "label": "Hair", "value": "Long flowing natural golden blonde" },
    { "label": "Eyes", "value": "One emerald green, one sapphire blue" }
  ]
}

"name" is the short name to file the profile under, usually the first name. The "Name" field is the full name as the source gives it.

Use these labels, in this order, and only these: ${PERSONA_FIELD_LABELS.join(', ')}. Omit any the source does not state — do not write the label with an empty value, and never write "unknown" or "unspecified". Write at most ${MAX_FIELDS} fields. One fact per field, on one line.`;

/** Lowercase, strip a trailing colon, collapse whitespace. The key labels are matched on. */
function normalizeLabel(label: string): string {
  return label.trim().replace(/:+$/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One line per fact, so a newline inside a value would break the blank-line reading of the
 * whole description. Same normalisation `formatWindow` applies for the same reason.
 */
function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateValue(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  let cut = value.slice(0, MAX_VALUE_CHARS);
  const space = cut.lastIndexOf(' ');
  if (space >= MIN_VALUE_CHARS) cut = cut.slice(0, space);
  return cut.trimEnd().replace(/[,;]+$/, '');
}

const CANONICAL_BY_KEY: ReadonlyMap<string, PersonaFieldLabel> = new Map([
  ...PERSONA_FIELD_LABELS.map((label) => [label.toLowerCase(), label] as const),
  ...Object.entries(LABEL_SYNONYMS).map(([key, label]) => [key, label] as const),
]);

/**
 * The house format: one `Label: value` line per fact, a blank line between, no trailing
 * newline. This is the one place it is written.
 *
 * There is no inverse parser on purpose — the draft is edited as plain text like every other
 * persona description in the app, and `PersonaField[]` exists only between parse and render.
 */
export function renderPersonaDescription(fields: readonly PersonaField[]): string {
  return fields
    .filter((field) => field.label.trim() && field.value.trim())
    .map((field) => `${field.label.trim()}: ${field.value.trim()}`)
    .join('\n\n');
}

/**
 * Read a reply into ordered, clamped fields.
 *
 * Every label is resolved against the canonical vocabulary rather than trusted, every value
 * is length-clamped, and a placeholder value is dropped outright. `fallbackName` is the
 * card's name — the one legitimate fallback in the file, because a persona with no name is
 * unusable and the card always has one.
 */
export function parseDerivedPersona(text: string, fallbackName: string): DerivedPersona {
  const parsed = looseParseJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return { name: fallbackName, fields: [], error: 'The model did not return readable JSON.' };
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.fields)) {
    return {
      name: fallbackName,
      fields: [],
      error: 'The model returned JSON without a "fields" list.',
    };
  }

  const known = new Map<PersonaFieldLabel, string>();
  const extra: PersonaField[] = [];

  for (const entry of record.fields) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const field = entry as Record<string, unknown>;
    // Never String()-coerced: a number where a label belongs means the model lost the shape,
    // and "7: Female" is worse than a missing line.
    if (typeof field.label !== 'string' || typeof field.value !== 'string') continue;

    const value = normalizeValue(field.value);
    if (!value || PLACEHOLDER_VALUE.test(value)) continue;

    const key = normalizeLabel(field.label);
    if (!key || BLOCKED_LABELS.has(key)) continue;

    const canonical = CANONICAL_BY_KEY.get(key);
    if (canonical) {
      // First occurrence wins, and the label is rewritten to our spelling whatever the model
      // typed — that is what makes the output identical across models.
      if (!known.has(canonical)) known.set(canonical, truncateValue(value));
      continue;
    }

    // An over-long unknown label is prose in the wrong slot. Dropped rather than truncated:
    // a truncated label is gibberish, where a dropped one is just a fact the user retypes.
    const label = field.label.trim().replace(/:+$/, '').replace(/\s+/g, ' ');
    if (!label || label.length > MAX_LABEL_CHARS) continue;
    if (extra.length >= MAX_EXTRA_FIELDS) continue;
    if (extra.some((existing) => existing.label.toLowerCase() === label.toLowerCase())) continue;
    extra.push({ label, value: truncateValue(value) });
  }

  const stated = typeof record.name === 'string' ? normalizeValue(record.name) : '';
  const name = (stated || known.get('Name') || fallbackName).slice(0, MAX_NAME_CHARS);
  if (!known.has('Name') && name) known.set('Name', name);

  const fields: PersonaField[] = [];
  for (const label of PERSONA_FIELD_LABELS) {
    const value = known.get(label);
    if (value) fields.push({ label, value });
  }
  fields.push(...extra);

  return { name, fields: fields.slice(0, MAX_FIELDS) };
}

/**
 * Send the head of the opening message, cut at a paragraph break when one is close to the
 * budget. Appearance is described in the first paragraph or two; the rest is dialogue, which
 * costs tokens and tells us nothing about what the character looks like.
 */
function truncateOpening(text: string): string {
  if (text.length <= MAX_OPENING_CHARS) return text;
  const head = text.slice(0, MAX_OPENING_CHARS);
  const breakAt = head.lastIndexOf('\n\n');
  if (breakAt >= MAX_OPENING_CHARS - OPENING_BREAK_WINDOW) return head.slice(0, breakAt).trimEnd();
  return head.trimEnd();
}

/**
 * The full request, hand-built rather than assembled.
 *
 * `assemblePrompt` is deliberately not used, for the reason given in
 * `shared/memory/extract.ts`: it exists to apply the user's preset, and the whole point of
 * this call is that the preset's main prompt, jailbreak and post-history instructions are
 * absent. The classic summariser goes through assembly and has to open with "Ignore previous
 * instructions" to claw its way back out from underneath them — that is the wart this
 * avoids, not a pattern to copy. Going through assembly would also make this a fifth
 * `assemblePrompt` caller and inherit the regex-script obligation, for a call that has no
 * transcript.
 */
export function buildDerivationMessages(options: {
  derivePrompt: string;
  card: PersonaSourceProfile;
}): ApiMessage[] {
  const { derivePrompt, card } = options;

  const blocks = [`Name: ${card.name.trim()}`];
  if (card.description?.trim()) blocks.push(`Description:\n${card.description.trim()}`);
  if (card.personality?.trim()) blocks.push(`Personality:\n${card.personality.trim()}`);
  if (card.firstMessage?.trim()) {
    blocks.push(
      `Opening message (prose in the character's voice — read it only for physical details the description does not state):\n${truncateOpening(
        card.firstMessage.trim(),
      )}`,
    );
  }

  return [
    { role: 'system', content: `${derivePrompt.trim()}\n\n${PERSONA_JSON_CONTRACT}` },
    { role: 'user', content: blocks.join('\n\n') },
  ];
}
