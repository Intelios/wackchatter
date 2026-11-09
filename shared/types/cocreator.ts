/**
 * Character Co-Creator types: a design conversation and the card being assembled out of it.
 *
 * A session is deliberately not a `Chat`. It has no character, is never backed up on delete,
 * and must not appear in the recent-chats list or the per-character picker — so it gets its
 * own tables and its own shapes rather than a sentinel `character_id`.
 *
 * The transcript reuses `ChatMessage` because the swipe model is exactly the same thing:
 * an alternate take on one turn. That is what lets `shared/chat/message.ts` serve both.
 */

import type { CompactionState } from '../cocreator/compaction.ts';
import type { ModelRef } from '../models/slots.ts';
import type { TavernCard } from './card.ts';
import type { ApiMessage, ChatMessage } from './chat.ts';

/** The card fields a piece of generated content may be filed into. */
export type CardSlot =
  | 'name'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'alternate_greeting'
  | 'mes_example'
  | 'tags'
  | 'creator_notes'
  | 'system_prompt'
  | 'post_history_instructions';

/** Every slot, in the order the Use-as menu and the stash panel show them. */
export const CARD_SLOTS: readonly CardSlot[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greeting',
  'mes_example',
  'tags',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
];

/** Slots holding exactly one value. Assigning to one of these replaces what was there. */
export type SingleCardSlot = Exclude<CardSlot, 'alternate_greeting' | 'tags'>;

export const SINGLE_SLOTS: readonly SingleCardSlot[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
];

export interface StashProvenance {
  /** Absent on existing entries, which originated in the main conversation. */
  conversation?: 'side';
  /** Empty means the origin was not recorded — a repaired entry from an older shape. */
  messageId: string;
  swipeIndex: number;
  /** From the swipe's `extra.model`. Absent when the swipe predates model recording. */
  model?: string;
  /** ISO, from shared/chat/message.ts `timestamp()`. Empty when not recorded. */
  at: string;
  /**
   * 'seed' is the Studio handoff: the entry arrived with the card the session was seeded
   * from, not out of anything the model wrote. It is the one source no model produced.
   */
  source: 'block' | 'message' | 'selection' | 'seed';
  /** The label as written, when the block it came from named no known slot. */
  label?: string;
}

export interface StashEntry {
  /**
   * Opaque and stable for the life of the entry.
   *
   * The persona rule, and for the persona reason: greetings are reorderable and every slot
   * is editable, so React needs an identity that survives both. Keying on position would
   * remount a row the moment it moved.
   */
  id: string;
  text: string;
  provenance: StashProvenance;
  /** Set once the user hand-edits it, so the panel can read "edited, from swipe 2". */
  edited?: boolean;
}

export interface CardStash {
  name?: StashEntry;
  description?: StashEntry;
  personality?: StashEntry;
  scenario?: StashEntry;
  first_mes?: StashEntry;
  mes_example?: StashEntry;
  creator_notes?: StashEntry;
  system_prompt?: StashEntry;
  post_history_instructions?: StashEntry;
  /**
   * Ordered, and the order is semantic rather than cosmetic: `greetingMessage`
   * (shared/chat/message.ts:350) turns `[first_mes, ...alternate_greetings]` into the
   * opening message's swipes in exactly this order.
   */
  alternate_greetings: StashEntry[];
  /** Split on commas when filed, appended, de-duplicated case-insensitively. */
  tags: StashEntry[];
}

/**
 * Which parts of an example card are sent.
 *
 * The name is always sent — it is what makes the analysis verifiable, since the user checks
 * that the model named every card they attached.
 */
export type ExampleField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'tags'
  | 'alternate_greetings'
  | 'mes_example'
  | 'character_book';

export type ExampleFields = Record<ExampleField, boolean>;

/** The curated set is on; the token-heavy parts are opt-in. */
export const DEFAULT_EXAMPLE_FIELDS: Readonly<ExampleFields> = {
  description: true,
  personality: true,
  scenario: true,
  first_mes: true,
  tags: true,
  alternate_greetings: false,
  mes_example: false,
  character_book: false,
};

export interface ExampleSelection {
  /**
   * Avatar filenames, in attachment order.
   *
   * Filenames only, never a copy of the card. An example edited in the Studio is immediately
   * what the model sees, and a deleted one degrades to "missing" rather than to a stale
   * snapshot of something the user no longer has.
   */
  cards: string[];
  fields: ExampleFields;
}

/**
 * A named collection of example cards and field settings that can be saved and reused
 * across Co-Creator sessions.
 *
 * The persona rule: `id` is opaque and stable; `name` is user-editable.
 */
export interface ExampleSet {
  id: string;
  name: string;
  cards: string[];
  fields: ExampleFields;
}

/**
 * Per-session overrides of `AppSettings.coCreator` and its model slot.
 *
 * Absent follows the app setting; the app setting's own null has its own meaning ("use the
 * active preset"). Collapsing absent into null would make a session silently stop tracking
 * a later change to the app default. `model` is the one exception to that worth naming: a
 * session's pick is a whole `ModelRef`, so a session never pairs one screen's connection
 * with another screen's model.
 */
export interface SessionModelSettings {
  /** Design-specific allowances; independent of the chat sampler preset. */
  outputTokens?: number;
  contextTokens?: number;
  /** Absent runs on the `cocreator` slot (or the `sideChat` slot, for the side chat). */
  model?: ModelRef;
  presetId?: string | null;
  systemPrompt?: string;
  analysisPrompt?: string;
}

export type SideChatModelSettings = Pick<
  SessionModelSettings,
  'model' | 'outputTokens' | 'contextTokens'
>;

/** The side chat's model is the `sideChat` slot, which never borrows the chat's. */
export interface SideChatDefaults {
  outputTokens: number;
  contextTokens: number;
}

export const DEFAULT_SIDE_CHAT: Readonly<SideChatDefaults> = {
  outputTokens: 2048,
  contextTokens: 131072,
};

export interface SideChatSnapshot {
  capturedAt: number;
  systemPrompt: string;
  exampleBlock: string;
  /** Current accepted card, frozen when the scratchpad is opened/reset. */
  draftBlock?: string;
  /** Frozen selected text, not references to editable main messages. */
  messages: ApiMessage[];
}

export interface CocreatorCardBaseline {
  card: TavernCard;
  /** Hash of the portrait independently of the embedded card text. */
  portraitVersion: string | null;
  /** The pre-upgrade starting card is unknown; compare differences before the first save. */
  legacy?: boolean;
}

/** An id makes recording a completed save idempotent, including after a reference rename. */
export interface CocreatorPublication {
  id: string;
  avatar: string | null;
}

export interface CocreatorSideChat {
  compaction?: CompactionState;
  snapshot: SideChatSnapshot;
  settings: SideChatModelSettings;
  messages: ChatMessage[];
}

export interface CocreatorSession {
  compaction?: CompactionState;
  id: string;
  title: string;
  created: number;
  modified: number;
  /** Monotonic whole-session revision used to reject stale client saves. */
  revision: number;
  stash: CardStash;
  examples: ExampleSelection;
  settings: SessionModelSettings;
  /** Filename under data/cocreator/avatars, or null. */
  avatar: string | null;
  /** The card Finish produced, or null. Kept so the session stays the card's reasoning. */
  finishedAvatar: string | null;
  /**
   * The original card, distinct from the current save target after creating a copy.
   * or null. Write-once at creation: the desk never edits it, so it is deliberately NOT part
   * of the save snapshot — whole-session saves preserve the column. A rename follows the
   * reference cascade; deleting it detaches this reference while the baseline and inherited
   * portrait remain in the session. Updating a missing target is disabled.
   */
  seedAvatar: string | null;
  baseline: CocreatorCardBaseline | null;
  /** Authoritative server reference, preserved by ordinary whole-document saves. */
  targetAvatar: string | null;
  portraitChanged: boolean;
  publication: CocreatorPublication | null;
  messages: ChatMessage[];
  sideChat: CocreatorSideChat | null;
}

export interface CocreatorSessionSummary {
  id: string;
  title: string;
  created: number;
  modified: number;
  messageCount: number;
  /** Preview text from the last message. */
  lastMessage: string;
  /** How many card slots carry something — the list's badge. */
  stashedSlots: number;
  avatar: string | null;
  finishedAvatar: string | null;
}

/** A complete immutable client save. The server accepts it only at its revision. */
export interface CocreatorSaveSnapshot {
  compaction?: CompactionState;
  sessionId: string;
  revision: number;
  title: string;
  stash: CardStash;
  examples: ExampleSelection;
  settings: SessionModelSettings;
  /**
   * The card Finish produced. Part of the document the revision guards, unlike `avatar`,
   * which the avatar endpoints own outright — Finish records it through this save, so it
   * must ride the snapshot or the recording never reaches the server.
   */
  finishedAvatar: string | null;
  baseline?: CocreatorCardBaseline | null;
  publication?: CocreatorPublication | null;
  messages: ChatMessage[];
  sideChat: CocreatorSideChat | null;
}
