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
  /** Persona id in use when the chat was created. */
  persona?: string;
  [key: string]: unknown;
}

export interface Chat {
  id: string;
  /** Character avatar filename — the character this chat belongs to. */
  characterId: string;
  title: string;
  created: number;
  modified: number;
  metadata: ChatMetadata;
  messages: ChatMessage[];
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
  position?: 'inPrompt' | 'atDepth' | 'none';
  role?: 'system' | 'user' | 'assistant';
}

/** The message shape sent to the provider. */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Set when names_behavior is COMPLETION. */
  name?: string;
}
