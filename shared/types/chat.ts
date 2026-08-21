/**
 * Chat and message types.
 *
 * Storage is ours (SQLite) and deliberately not ST-compatible, but the message model
 * follows ST's swipes[] / swipe_id / swipe_info[] shape because it is the right one:
 * a swipe is an alternate take on the same turn, not a separate message.
 */

export interface SwipeInfo {
  send_date: string;
  gen_started?: string;
  gen_finished?: string;
  extra?: MessageExtra;
}

export interface MessageExtra {
  /**
   * Provider id used to generate this message. A ProviderId, never a connection name —
   * see `connection_id` for which endpoint it actually was.
   */
  api?: string;
  model?: string;
  /**
   * Completion tokens. Reported usage when the provider gives it, our own estimate
   * otherwise, and never the prompt side — so this is what was written, not what was paid.
   */
  token_count?: number;
  /**
   * Which saved connection generated this. Recorded from 2026-08 onwards; missing on
   * everything older, which is why the stats screen says "not recorded" rather than
   * attributing those to whatever connection happens to be selected now.
   */
  connection_id?: string;
  /**
   * Which preset was in force. Recorded per swipe rather than per chat, since a preset can
   * be switched mid-conversation and the swipe is the thing it actually shaped.
   */
  preset_id?: string;
  /**
   * Prompt tokens, only ever as reported by the provider. Deliberately never estimated:
   * a local count would miss whatever world info and injections the request really carried.
   */
  prompt_tokens?: number;
  /** Reasoning / thinking text, shown collapsed. */
  reasoning?: string;
  /** Set when generation was interrupted. */
  truncated?: boolean;
  /** Co-Creator-only provenance for user actions whose wording is editable. */
  coCreatorAction?: 'analyseExamples';
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  name: string;
  is_user: boolean;
  /**
   * Hidden from the prompt but still shown in the transcript.
   * This is ST's "hide message from prompt" mechanism.
   */
  is_system: boolean;
  /**
   * Which memory hid this message. Absent means a person hid it by hand.
   *
   * Sits beside `is_system` rather than in `MessageExtra` because hiding is a property of
   * the message, and `extra` belongs to the selected swipe — parked there, swiping would
   * change what is recorded as having hidden the turn.
   *
   * Provenance, not a second hide flag. `is_system` is one boolean, so without this a
   * memory covering messages 40–90 could not be deleted without also unhiding a manual
   * `/hide 0-50` that happened to overlap it.
   */
  hiddenBy?: string;
  /**
   * User messages only: the persona this message was sent as, recorded at send time so a
   * later persona switch cannot re-face the transcript. Null means it was sent with no
   * persona; missing means a legacy message from before speakers were recorded.
   */
  persona_id?: string | null;
  mes: string;
  send_date: string;
  gen_started?: string;
  gen_finished?: string;
  swipes?: string[];
  swipe_id?: number;
  swipe_info?: SwipeInfo[];
  extra?: MessageExtra;
}

export interface ChatMetadata {
  /** Overrides the character's scenario for this chat only. */
  scenario?: string;
  /**
   * Persona snapshot for this chat.
   *
   * Missing means a pre-snapshot legacy chat, a string is an explicit persona id, and
   * null means the user explicitly chose no persona. These must not be collapsed into
   * one another: a transcript records who "you" were when it was written.
   */
  persona?: string | null;
  /** SillyTavern-compatible variables scoped to this chat. */
  variables?: MacroVariableMap;
  /** Lightweight, chat-scoped Author's Note configuration. */
  authorNote?: Partial<AuthorNoteSettings>;
  /** Standing instructions injected into every prompt for this chat. */
  guides?: PersistentGuide[];
  /** Editable rolling story memory and the last transcript message it covers. */
  summary?: StorySummary;
  /**
   * Discrete recalled memories — the alternative to `summary`, never a companion to it.
   * Which of the two reaches the model is `AppSettings.memoryMode`; assembly injects one
   * or neither, so a chat can carry both without them ever being sent together.
   */
  memories?: Memory[];
  /**
   * Last transcript message covered by a memory. The Memory counterpart of
   * `StorySummary.checkpointMessageId`, and absent for the same reason: nothing extracted
   * yet, so the backlog starts at the top.
   */
  memoryWatermark?: string;
  /** Provenance recorded when this chat was created as a branch of another chat. */
  branchedFrom?: BranchOrigin;
  [key: string]: unknown;
}

/**
 * One recalled moment: a titled scene, a short narrative description, and the transcript
 * range it was written from.
 *
 * Lives in `ChatMetadata` rather than in `data/lorebooks`, which is what makes branching
 * safe against backwards leaks — a branch snapshots metadata, so a memory written after
 * the branch point cannot leak into the parent. The forward direction is not free,
 * though: `branchChat` copies messages with fresh ids, so `remapBranchMetadata`
 * (shared/chat/branch.ts) rewrites every range onto the branch's own ids, clamps ranges
 * that straddle the fork, and drops memories written from transcript past it.
 *
 * `range` is by message id, never by index. Indices shift under delete, branch and swipe;
 * the whole reason the extractor is never shown a global index is that it must not be able
 * to name a message that has since moved.
 */
export interface Memory {
  id: string;
  /** Short scene name, e.g. "First Meeting". Shown as the card heading. */
  title: string;
  /** Two to four sentences, all-seeing narrator voice. */
  text: string;
  /**
   * Recall triggers. Become `WorldInfoEntry.key`, so the activation engine matches them
   * exactly as it matches a lorebook entry's keys — including `/pattern/flags` literals.
   */
  keywords: string[];
  /**
   * At most a couple of verbatim lines from the covered range.
   *
   * Memories that keep some real dialogue stop characters drifting into flat
   * narrator-summary voice, which is the standard complaint about rolling summaries.
   */
  quotes?: string[];
  /**
   * The transcript span this was written from, inclusive at both ends.
   *
   * Absent on a hand-written memory, which need not describe any span at all — a fact
   * somebody wants the model to hold is still a memory. Nothing derived from a range
   * (hiding, staleness, the watermark) applies to one without it.
   */
  range?: { startId: string; endId: string };
  /** Always in the prompt. Becomes `WorldInfoEntry.constant`. */
  pinned: boolean;
  /** Excluded from injection entirely, without being deleted. */
  enabled: boolean;
  source: 'generated' | 'manual';
  /** Set on any user edit. Extraction never overwrites an edited memory. */
  edited: boolean;
  generatedAt: number;
  /** Model that wrote it, for the same reason `MessageExtra.model` exists. */
  model?: string;
  /**
   * Set when a covered message was edited or deleted after `generatedAt`.
   *
   * Surfaced as a badge and never auto-corrected: a memory quietly describing text that no
   * longer exists is the failure every comparable extension documents, and silently
   * rewriting someone's edited memory would be a worse one.
   */
  stale?: 'edited' | 'deleted';
}

export interface BranchOrigin {
  chatId: string;
  messageId: string;
}

export interface StorySummary {
  text: string;
  /** Missing means the current text has no generated/transcript checkpoint yet. */
  checkpointMessageId?: string;
}

/**
 * A standing instruction that sits in every prompt for one chat.
 *
 * Per chat rather than per character, matching where SillyTavern keeps the same thing
 * (`chat_metadata.script_injects`): a guide is a steering decision about *this* story, and
 * one that leaked into every future chat with the character would be invisible the moment
 * you forgot you set it.
 *
 * `id` is opaque and `name` is editable, the persona rule rather than the lorebook one —
 * renaming a guide must not detach the text from the entry that owns it.
 */
export interface PersistentGuide {
  id: string;
  name: string;
  text: string;
  enabled: boolean;
}

/** Values supported by SillyTavern's legacy variable macros. */
export type MacroValue = string | number;
export type MacroVariableMap = Record<string, MacroValue>;

export type AuthorNotePosition = 'beforeScenario' | 'afterScenario' | 'atDepth';

export interface AuthorNoteSettings {
  text: string;
  /** Inject every N user turns. Values <= 0 disable the note. */
  interval: number;
  position: AuthorNotePosition;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}

export const DEFAULT_AUTHOR_NOTE: Readonly<AuthorNoteSettings> = {
  text: '',
  interval: 1,
  position: 'atDepth',
  depth: 4,
  role: 'system',
};

export interface MacroWarning {
  macro: string;
  /** Prompt identifier, message id, or synthesized section that contained it. */
  source: string;
}

export interface Chat {
  id: string;
  /** Character avatar filename — the character this chat belongs to. */
  characterId: string;
  title: string;
  created: number;
  modified: number;
  /** Monotonic whole-chat revision used to reject stale client saves. */
  revision: number;
  metadata: ChatMetadata;
  messages: ChatMessage[];
}

/** A complete immutable client save. The server accepts it only at its revision. */
export interface ChatSaveSnapshot {
  chatId: string;
  revision: number;
  title: string;
  metadata: ChatMetadata;
  messages: ChatMessage[];
}

/** Returned for a save that lost a revision race. */
export interface StaleChatRevision {
  code: 'stale_revision';
  currentRevision: number;
}

export interface ChatSummary {
  id: string;
  characterId: string;
  title: string;
  created: number;
  modified: number;
  messageCount: number;
  /** Preview text from the last message. */
  lastMessage: string;
}

/** A deleted chat waiting in the trash bin (data/backups), still restorable. */
export interface ChatBackupSummary {
  /** The backup file stem — the id the restore and delete endpoints take. */
  backupId: string;
  /** The chat as it was deleted. Restore recreates it under a fresh id. */
  chatId: string;
  characterId: string;
  title: string;
  messageCount: number;
  /** Epoch ms when the chat was deleted, which is when the backup was taken. */
  deleted: number;
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  /** Avatar filename in data/personas/avatars, or null for the generated fallback. */
  avatar: string | null;
  /** Injection depth when position is 'atDepth'. */
  depth?: number;
  position?: 'inPrompt' | 'topAuthorNote' | 'bottomAuthorNote' | 'atDepth' | 'none';
  role?: 'system' | 'user' | 'assistant';
  /** Standalone lorebook id activated whenever this persona is active. */
  lorebookId?: string | null;
}

/** The message shape sent to the provider. */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Set when names_behavior is COMPLETION. */
  name?: string;
}
