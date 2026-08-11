/**
 * Character card types, matching the Tavern V2/V3 spec as SillyTavern implements it.
 *
 * Compatibility notes that drive the shape of these types:
 *  - A real card carries fields at BOTH the top level (V1 legacy) and under `data.*` (V2).
 *    ST keeps them in sync; so do we.
 *  - Unknown keys must survive a round-trip. ST achieves this by merging onto the previously
 *    parsed JSON rather than rebuilding from a known field list. Hence the index signatures.
 */

export interface CharacterBookEntry {
  keys: string[];
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  /** Lossy: the numeric position survives in `extensions.position`. */
  position?: 'before_char' | 'after_char';
  use_regex?: boolean;
  [key: string]: unknown;
}

export interface CharacterBook {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  /** ST omits this despite its own validator requiring it. Always emit at least `{}`. */
  extensions: Record<string, unknown>;
  entries: CharacterBookEntry[];
  [key: string]: unknown;
}

/** ST's own namespaced additions under `data.extensions`. */
export interface CardExtensions {
  talkativeness?: number;
  fav?: boolean;
  /** Name of a linked standalone lorebook. */
  world?: string;
  depth_prompt?: {
    depth: number;
    prompt: string;
    role: 'system' | 'user' | 'assistant';
  };
  regex_scripts?: unknown[];
  [key: string]: unknown;
}

/** The V2 `data` block. V3 adds fields but does not change any of these. */
export interface CardDataV2 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;

  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: CharacterBook;

  tags: string[];
  creator: string;
  character_version: string;
  extensions: CardExtensions;

  // V3 additions. ST never writes these but preserves them, and so must we.
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  group_only_greetings?: string[];
  creation_date?: number;
  modification_date?: number;
  assets?: Array<{ type: string; uri: string; name: string; ext: string }>;

  [key: string]: unknown;
}

/**
 * A full card as stored in the PNG. Top-level fields are the V1 legacy mirror of `data.*`.
 * `spec` is absent on bare V1 cards.
 */
export interface TavernCard {
  spec?: 'chara_card_v2' | 'chara_card_v3';
  spec_version?: string;
  data: CardDataV2;

  // V1 legacy mirror — kept in sync with `data.*` on write.
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creatorcomment?: string;
  tags?: string[];
  talkativeness?: number;
  fav?: boolean | string;
  create_date?: string;
  /** Vestigial. ST hardcodes "none". The real identity is the PNG filename. */
  avatar?: string;

  [key: string]: unknown;
}

/** A card as surfaced to the UI: the card plus its on-disk identity. */
export interface CharacterSummary {
  /** PNG filename including extension — the unique ID, e.g. "Seraphina.png". */
  avatar: string;
  /**
   * Which folder the card's file sits in: '' at the top level, otherwise a '/'-separated
   * path below data/characters.
   *
   * Deliberately NOT part of the identity. Chats key on `avatar` alone, so a card can be
   * reorganised — in the app or in a file browser — without anything else having to follow.
   */
  folder: string;
  name: string;
  description: string;
  creator: string;
  tags: string[];
  character_version: string;
  hasLorebook: boolean;
  /** ms epoch, from file mtime. */
  modified: number;
}

export interface CharacterDetail extends CharacterSummary {
  card: TavernCard;
}

export const CARD_SPEC_V2 = 'chara_card_v2' as const;
export const CARD_SPEC_V3 = 'chara_card_v3' as const;

/** Fields a bare V1 card must have to be recognised as a card at all. */
export const V1_REQUIRED_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
] as const;
