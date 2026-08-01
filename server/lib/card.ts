/**
 * Character card reading, normalising and writing.
 *
 * The compatibility rules this file exists to enforce:
 *  1. Read precedence is ccv3 over chara. Write BOTH chunks.
 *  2. Payload is base64(utf8(JSON)) inside a tEXt chunk.
 *  3. Fields live at both the top level (V1 legacy) and under data.* — keep them in sync.
 *  4. Unknown keys must survive edits. We merge onto the parsed original rather than
 *     rebuilding from a known field list, which is how ST preserves V3-only fields it
 *     never writes itself (nickname, creation_date, assets, source, group_only_greetings).
 */

import { Buffer } from 'node:buffer';
import type { CardDataV2, TavernCard } from '../../shared/types/card.ts';
import { CARD_SPEC_V2, CARD_SPEC_V3, V1_REQUIRED_FIELDS } from '../../shared/types/card.ts';
import { readTextChunks, replaceTextChunks } from './png.ts';

const CHARA_KEYWORD = 'chara';
const CCV3_KEYWORD = 'ccv3';

/** Fields mirrored between the top level (V1) and data.* (V2). */
const MIRRORED_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
] as const;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Pull the raw embedded JSON string out of a card PNG.
 * @throws if the PNG carries no character metadata.
 */
export function readCardJson(png: Uint8Array): string {
  const chunks = readTextChunks(png);
  if (chunks.length === 0) {
    throw new Error('No PNG text metadata — this image is not a character card.');
  }

  // ccv3 wins over chara when both are present.
  const ccv3 = chunks.find((c) => c.keyword.toLowerCase() === CCV3_KEYWORD);
  if (ccv3) return Buffer.from(ccv3.text, 'base64').toString('utf8');

  const chara = chunks.find((c) => c.keyword.toLowerCase() === CHARA_KEYWORD);
  if (chara) return Buffer.from(chara.text, 'base64').toString('utf8');

  throw new Error('No character metadata found in PNG (expected a "chara" or "ccv3" chunk).');
}

/** Read and normalise a card from PNG bytes. */
export function readCard(png: Uint8Array): TavernCard {
  const json = readCardJson(png);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Character metadata is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  return normalizeCard(parsed);
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Does this object look like a bare V1 card? */
export function looksLikeV1Card(value: Record<string, unknown>): boolean {
  return V1_REQUIRED_FIELDS.every((field) => Object.hasOwn(value, field));
}

/**
 * Bring any card shape (V1, V2, V3) into our normalised form: a full `data` block with
 * the V1 mirror kept in sync, and every unrecognised key left exactly where it was.
 */
export function normalizeCard(raw: unknown): TavernCard {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Character card must be a JSON object.');
  }

  const source = { ...(raw as Record<string, unknown>) };
  const hasSpec = typeof source.spec === 'string';
  const rawData =
    source.data && typeof source.data === 'object' && !Array.isArray(source.data)
      ? { ...(source.data as Record<string, unknown>) }
      : undefined;

  if (!hasSpec && !rawData && !looksLikeV1Card(source)) {
    throw new Error('Unrecognised character card: no "spec" field and missing required V1 fields.');
  }

  // For a bare V1 card the top level is the source of truth; otherwise data.* is.
  const primary = rawData ?? source;

  const data: CardDataV2 = {
    // Preserve everything already in data.* first, then normalise the fields we rely on.
    ...(rawData ?? {}),

    name: asString(primary.name ?? source.name),
    description: asString(primary.description ?? source.description),
    personality: asString(primary.personality ?? source.personality),
    scenario: asString(primary.scenario ?? source.scenario),
    first_mes: asString(primary.first_mes ?? source.first_mes),
    mes_example: asString(primary.mes_example ?? source.mes_example),

    creator_notes: asString(primary.creator_notes ?? source.creatorcomment ?? source.creator_notes),
    system_prompt: asString(primary.system_prompt),
    post_history_instructions: asString(primary.post_history_instructions),
    alternate_greetings: asStringArray(primary.alternate_greetings),

    tags: asStringArray(primary.tags ?? source.tags),
    creator: asString(primary.creator),
    character_version: asString(primary.character_version),

    extensions: {
      ...((primary.extensions as Record<string, unknown> | undefined) ?? {}),
      talkativeness: numberOr(
        (primary.extensions as Record<string, unknown> | undefined)?.talkativeness ??
          source.talkativeness,
        0.5,
      ),
      fav: Boolean(
        (primary.extensions as Record<string, unknown> | undefined)?.fav ?? source.fav ?? false,
      ),
    },
  };

  if (primary.character_book && typeof primary.character_book === 'object') {
    const book = primary.character_book as Record<string, unknown>;
    data.character_book = {
      ...book,
      // ST omits this despite its own validator requiring it.
      extensions: (book.extensions as Record<string, unknown> | undefined) ?? {},
      entries: Array.isArray(book.entries) ? book.entries : [],
    } as CardDataV2['character_book'];
  }

  const card: TavernCard = {
    ...source,
    spec: source.spec === CARD_SPEC_V3 ? CARD_SPEC_V3 : CARD_SPEC_V2,
    spec_version: source.spec === CARD_SPEC_V3 ? asString(source.spec_version, '3.0') : '2.0',
    data,
  };

  return syncLegacyMirror(card);
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Copy data.* down onto the V1 legacy top-level fields, as ST's readFromV2 does. */
export function syncLegacyMirror(card: TavernCard): TavernCard {
  for (const field of MIRRORED_FIELDS) {
    card[field] = card.data[field];
  }
  card.creatorcomment = card.data.creator_notes;
  card.tags = card.data.tags;
  card.talkativeness = numberOr(card.data.extensions.talkativeness, 0.5);
  card.fav = Boolean(card.data.extensions.fav);
  // Vestigial in the payload — the real identity is the filename. ST hardcodes "none".
  card.avatar = 'none';
  return card;
}

// ---------------------------------------------------------------------------
// Merging edits
// ---------------------------------------------------------------------------

/**
 * Apply a partial `data` update to an existing card without disturbing anything else.
 *
 * This is the single most important function for not corrupting a user's library:
 * we start from the original parsed card and set only what changed, so V3-only and
 * third-party keys (chub, risuai, pygmalion_id, assets, source, ...) come through intact.
 *
 * **The spread is shallow, so a `character_book` in `updates` REPLACES the stored one
 * wholesale.** That is deliberate and must stay that way: entries are an array, and a
 * deep merge over an array cannot express "this entry was deleted". It does mean a
 * caller must never hand this a book the client assembled — the embedded-book endpoints
 * read the stored card, mutate one entry, and pass the result back, so a stale browser
 * cannot write a mass deletion into the PNG. See routes/characters.ts.
 */
export function mergeCardData(original: TavernCard, updates: Partial<CardDataV2>): TavernCard {
  const merged: TavernCard = {
    ...original,
    data: {
      ...original.data,
      ...updates,
      extensions: {
        ...original.data.extensions,
        ...(updates.extensions ?? {}),
      },
    },
  };
  return syncLegacyMirror(merged);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Serialise a card the way ST does when embedding: compact JSON, no pretty-printing. */
export function serializeCard(card: TavernCard): string {
  return JSON.stringify(card);
}

/**
 * Embed a card into PNG bytes, writing both the `chara` (V2) and `ccv3` (V3) chunks.
 * The image data is untouched; only tEXt chunks are replaced.
 */
export function writeCard(png: Uint8Array, card: TavernCard): Uint8Array {
  const v2 = { ...card, spec: CARD_SPEC_V2, spec_version: '2.0' };
  const v3 = { ...card, spec: CARD_SPEC_V3, spec_version: '3.0' };

  return replaceTextChunks(
    png,
    [CHARA_KEYWORD, CCV3_KEYWORD],
    [
      { keyword: CHARA_KEYWORD, text: Buffer.from(serializeCard(v2), 'utf8').toString('base64') },
      { keyword: CCV3_KEYWORD, text: Buffer.from(serializeCard(v3), 'utf8').toString('base64') },
    ],
  );
}

/** A blank card, for "create new character". */
export function createBlankCard(name: string): TavernCard {
  return normalizeCard({
    spec: CARD_SPEC_V2,
    spec_version: '2.0',
    data: {
      name,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
    },
  });
}

/**
 * Strip local-only UI state before export, matching ST's unsetPrivateFields, so an
 * exported card doesn't carry our favourites/chat pointers into someone else's install.
 */
export function stripPrivateFields(card: TavernCard): TavernCard {
  // `chat` is a pointer into our own chat store and is meaningless elsewhere.
  const { chat: _chat, ...rest } = card;
  const copy: TavernCard = {
    ...rest,
    data: { ...card.data, extensions: { ...card.data.extensions } },
  };
  copy.fav = false;
  copy.data.extensions.fav = false;
  return copy;
}
