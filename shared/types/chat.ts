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
  /** Provider id used to generate this message. */
  api?: string;
  model?: string;
  token_count?: number;
  /** Reasoning / thinking text, shown collapsed. */
  reasoning?: string;
  /** Set when generation was interrupted. */
  truncated?: boolean;
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
  [key: string]: unknown;
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
