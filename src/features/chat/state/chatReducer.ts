/**
 * Chat state.
 *
 * Pure and exhaustive, so the rules that are easy to get wrong — what a failed swipe
 * leaves behind, what regenerate destroys — are testable without React anywhere near
 * them.
 *
 * The streaming text is deliberately NOT in here. It lives in streamStore and reaches
 * one leaf component through useSyncExternalStore, so a reply that arrives over sixty
 * seconds produces three or four actions rather than eighteen hundred.
 */

import {
  appendAlternates,
  appendSwipe,
  assistantPlaceholder,
  currentInfo,
  currentText,
  fromChatMessage,
  greetingMessage,
  type MessageState,
  removeSwipe,
  selectSwipe,
  setText,
  timestamp,
  toChatMessage,
  userMessage,
} from '@shared/chat/message.ts';
import { markMemoriesStale } from '@shared/memory/memories.ts';
import type { ContextOverflow } from '@shared/prompt/assemble.ts';
import type { ChatCompletionBody } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  ApiMessage,
  Chat,
  ChatMessage,
  ChatMetadata,
  MacroWarning,
  MessageExtra,
} from '@shared/types/chat.ts';
import type { GenerationType } from '@shared/types/preset.ts';

export type GenMode = 'send' | 'regenerate' | 'swipe' | 'continue';
export type ChatStatus = 'idle' | 'connecting' | 'streaming';

/** A record of one generation, for the "what was actually sent" inspector. */
export interface PromptInspection {
  at: number;
  generationType: GenerationType;
  messages: ApiMessage[];
  tokenCounts: Record<string, number>;
  totalTokens: number;
  droppedMessages: number;
  macroWarnings: MacroWarning[];
  /** The exact object POSTed to /api/generate, or null when preflight rejected it. */
  body: ChatCompletionBody | null;
  overflow?: ContextOverflow;
  response?: {
    model?: string;
    finishReason: string | null;
    promptTokens?: number;
    completionTokens?: number;
    error?: string;
  };
}

const MAX_INSPECTIONS = 10;

/**
 * One spare completion from a multi-choice request, on its way to becoming a swipe.
 *
 * Only ever produced for a generation that asked for `n > 1`, and only with text in it —
 * a blank alternate would be an empty swipe the reader has to skip past.
 */
export interface GeneratedAlternate {
  text: string;
  extra?: MessageExtra;
}

export interface ChatState {
  chatId: string | null;
  characterId: string | null;
  title: string;
  metadata: ChatMetadata;
  messages: MessageState[];
  status: ChatStatus;
  /** The message being generated into. An id, because indices shift. */
  streamingId: string | null;
  mode: GenMode | null;
  /** Regenerate's displaced message, restored if the generation produces nothing. */
  discarded: { message: MessageState; index: number } | null;
  error: string | null;
  inspections: PromptInspection[];
  /** Monotonic revision for this chat, matching the server after a successful save. */
  revision: number;
  /** The greatest revision the server has acknowledged for the open chat. */
  persistedRevision: number;
}

export const initialChatState: ChatState = {
  chatId: null,
  characterId: null,
  title: '',
  metadata: {},
  messages: [],
  status: 'idle',
  streamingId: null,
  mode: null,
  discarded: null,
  error: null,
  inspections: [],
  revision: 0,
  persistedRevision: 0,
};

export type ChatAction =
  | { type: 'chat/loaded'; chat: Chat; personaId?: string | null }
  | { type: 'chat/closed' }
  | { type: 'chat/saved'; chatId: string; revision: number }
  | { type: 'chat/renamed'; title: string }
  | { type: 'chat/metadata'; patch: Partial<ChatMetadata> }
  | { type: 'chat/greeting'; id: string; card: CardDataV2 }
  | {
      type: 'message/appendUser';
      id: string;
      name: string;
      /** The persona speaking — recorded on the message so history keeps its faces. */
      personaId: string | null;
      text: string;
    }
  | { type: 'message/edited'; id: string; text: string }
  | { type: 'message/reasoningEdited'; id: string; reasoning: string }
  | { type: 'message/deleted'; id: string }
  | { type: 'message/toggleHidden'; id: string }
  | {
      type: 'message/setHidden';
      ids: string[];
      hidden: boolean;
      /**
       * The memory acting, when a memory is acting. Hiding stamps it; unhiding with it
       * set touches only messages that memory stamped, so deleting a memory cannot
       * reveal a range somebody hid by hand. Absent means a person is acting, and a
       * person may unhide anything.
       */
      memoryId?: string;
    }
  | { type: 'swipe/select'; id: string; index: number }
  | { type: 'gen/started'; mode: GenMode; newId: string; name: string }
  | { type: 'gen/inspected'; inspection: PromptInspection }
  | { type: 'gen/streaming' }
  | { type: 'gen/finished'; text: string; extra?: MessageExtra; alternates?: GeneratedAlternate[] }
  | { type: 'gen/aborted'; text: string; reasoning?: string }
  | { type: 'gen/failed'; message: string; text?: string; reasoning?: string }
  | { type: 'error/cleared' };

function replaceMessage(
  messages: MessageState[],
  id: string,
  update: (message: MessageState) => MessageState,
): MessageState[] {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

/** The last non-user message, which is the only one that can be swiped or continued. */
function lastAssistantIndex(messages: MessageState[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]!.is_user) return i;
  }
  return -1;
}

/**
 * Settle a finished, aborted or failed generation back into a consistent state.
 *
 * `alternates` only ever arrive on a clean finish. An abort or a failure mid-stream leaves
 * the spare completions half-written, and half a reply is worth keeping where the reader
 * watched it arrive — not as swipes they never saw being made.
 */
function settle(
  state: ChatState,
  text: string,
  extra?: MessageExtra,
  alternates: GeneratedAlternate[] = [],
): ChatState {
  const id = state.streamingId;
  const mode = state.mode;
  if (!id || !mode) return { ...state, status: 'idle', streamingId: null, mode: null };

  const index = state.messages.findIndex((message) => message.id === id);
  const settled: Partial<ChatState> = {
    status: 'idle',
    streamingId: null,
    mode: null,
    discarded: null,
    revision: state.revision + 1,
  };

  if (index === -1) return { ...state, ...settled };

  // Anything the model actually produced is kept, even from an abort or an error.
  // Thinking models can legitimately finish (or hit their length limit) before emitting
  // ordinary content; their reasoning is still a visible result and must not disappear.
  if (text || extra?.reasoning) {
    const finished = timestamp();
    return {
      ...state,
      ...settled,
      messages: replaceMessage(state.messages, id, (message) => {
        // The alternates were produced by the same request as the reply above them, so
        // they share its start time rather than claiming to have begun when it ended.
        const started = currentInfo(message).gen_started;
        const written = setText(message, text, { gen_finished: finished, extra });

        return appendAlternates(
          written,
          alternates.map((alternate) => ({
            text: alternate.text,
            info: {
              send_date: finished,
              ...(started ? { gen_started: started } : {}),
              gen_finished: finished,
              ...(alternate.extra ? { extra: alternate.extra } : {}),
            },
          })),
        );
      }),
    };
  }

  // Nothing came back. Each mode has to undo exactly what gen/started did, or the
  // failure leaves debris behind — most visibly a blank swipe on every failed overswipe.
  switch (mode) {
    case 'send':
      return {
        ...state,
        ...settled,
        messages: state.messages.filter((message) => message.id !== id),
      };

    case 'swipe':
      return {
        ...state,
        ...settled,
        messages: replaceMessage(state.messages, id, (message) =>
          removeSwipe(message, message.swipe_id),
        ),
      };

    case 'regenerate': {
      // A deliberate divergence from SillyTavern, which destroys the swipe array before
      // generating and so loses every alternate to a 429 or a stray Stop click.
      if (!state.discarded) return { ...state, ...settled };
      const messages = [...state.messages];
      messages.splice(index, 1, state.discarded.message);
      return { ...state, ...settled, messages };
    }

    // Continue never added anything, so there is nothing to undo.
    default:
      return { ...state, ...settled };
  }
}

/**
 * Flag memories covering a message that is about to change or disappear.
 *
 * Returns the existing metadata object unchanged when nothing matched, so the identity
 * check downstream still sees an untouched metadata and a message edit in a chat with no
 * memories costs exactly what it did before.
 */
function withStaleMemories(
  state: ChatState,
  messageId: string,
  reason: 'edited' | 'deleted',
): ChatMetadata {
  const memories = state.metadata.memories;
  if (!memories?.length) return state.metadata;
  const next = markMemoriesStale(memories, state.messages, messageId, reason);
  return next ? { ...state.metadata, memories: next } : state.metadata;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    // A missing persona key only exists on chats created before snapshots. Snapshot the
    // current persona immediately and mark that one migration revision dirty.
    case 'chat/loaded': {
      const missingPersona = !Object.hasOwn(action.chat.metadata, 'persona');
      const metadata = missingPersona
        ? { ...action.chat.metadata, persona: action.personaId ?? null }
        : action.chat.metadata;

      // User messages from before speakers were recorded have no persona_id. They were
      // sent as whoever the chat's persona is, so stamp that in now: a later persona
      // switch must not re-face the transcript, and this one migration revision is the
      // price of freezing the history while it can still be reconstructed.
      let stamped = false;
      const messages = action.chat.messages.map((raw) => {
        const message = fromChatMessage(raw);
        if (!message.is_user || message.persona_id !== undefined) return message;
        stamped = true;
        return { ...message, persona_id: metadata.persona ?? null };
      });

      return {
        ...initialChatState,
        chatId: action.chat.id,
        characterId: action.chat.characterId,
        title: action.chat.title,
        metadata,
        messages,
        inspections: state.inspections,
        revision: action.chat.revision + (missingPersona || stamped ? 1 : 0),
        persistedRevision: action.chat.revision,
      };
    }

    case 'chat/closed':
      return { ...initialChatState, inspections: state.inspections };

    case 'chat/saved':
      if (state.chatId !== action.chatId || action.revision <= state.persistedRevision)
        return state;
      return { ...state, persistedRevision: Math.min(action.revision, state.revision) };

    case 'chat/renamed':
      return { ...state, title: action.title, revision: state.revision + 1 };

    case 'chat/metadata':
      // No chat, nothing to attach metadata to — and writing it into the initial state
      // would leak it into whichever chat opens next.
      if (!state.chatId) return state;
      return {
        ...state,
        metadata: { ...state.metadata, ...action.patch },
        revision: state.revision + 1,
      };

    case 'chat/greeting': {
      // Only ever seeds an empty chat, so an existing transcript can't be overwritten.
      if (state.messages.length > 0) return state;
      const greeting = greetingMessage(action.id, action.card);
      if (!currentText(greeting)) return state;
      return { ...state, messages: [greeting], revision: state.revision + 1 };
    }

    case 'message/appendUser':
      return {
        ...state,
        messages: [
          ...state.messages,
          userMessage(action.id, action.name, action.text, action.personaId),
        ],
        error: null,
        revision: state.revision + 1,
      };

    case 'message/edited':
      return {
        ...state,
        messages: replaceMessage(state.messages, action.id, (message) =>
          setText(message, action.text),
        ),
        metadata: withStaleMemories(state, action.id, 'edited'),
        revision: state.revision + 1,
      };

    case 'message/reasoningEdited':
      // The reply text is untouched — reasoning rides in the active swipe's extra. An
      // empty string clears it (`undefined` drops the key on serialisation), which is
      // what makes a cleared reasoning box unmount rather than render blank.
      return {
        ...state,
        messages: replaceMessage(state.messages, action.id, (message) =>
          setText(message, currentText(message), {
            extra: { reasoning: action.reasoning || undefined },
          }),
        ),
        revision: state.revision + 1,
      };

    case 'message/deleted':
      return {
        ...state,
        // Marked from the transcript that still contains the message: containment is
        // resolved by position, so after the filter there would be nothing left to resolve.
        metadata: withStaleMemories(state, action.id, 'deleted'),
        messages: state.messages.filter((message) => message.id !== action.id),
        revision: state.revision + 1,
      };

    case 'message/toggleHidden':
      // A person toggling by hand takes ownership either way: revealing clears the stamp,
      // and hiding again makes it a manual hide that no memory may later undo.
      return {
        ...state,
        messages: replaceMessage(state.messages, action.id, (message) => {
          const next = { ...message, is_system: !message.is_system };
          delete next.hiddenBy;
          return next;
        }),
        revision: state.revision + 1,
      };

    case 'message/setHidden': {
      // One revision for the whole range, so a `/hide 0-150` is a single save. Skip
      // messages already in the requested state — idempotent, so re-hiding an already
      // hidden range does not dirty the chat for nothing.
      const target = new Set(action.ids);
      let changed = false;
      const messages = state.messages.map((message) => {
        if (!target.has(message.id)) return message;

        // Ownership, enforced here rather than at the call site: a memory may only reveal
        // what it hid. Without this rule, deleting a memory whose range overlapped a
        // manual `/hide` would silently undo the manual one too.
        if (!action.hidden && action.memoryId && message.hiddenBy !== action.memoryId) {
          return message;
        }
        if (message.is_system === action.hidden && message.hiddenBy === action.memoryId) {
          return message;
        }

        changed = true;
        const next = { ...message, is_system: action.hidden };
        if (action.hidden && action.memoryId) next.hiddenBy = action.memoryId;
        else delete next.hiddenBy;
        return next;
      });
      if (!changed) return state;
      return { ...state, messages, revision: state.revision + 1 };
    }

    case 'swipe/select':
      // Never while generating. A generation writes into whichever swipe is selected
      // when it settles, so moving the selection mid-flight would land the reply in the
      // wrong slot and strand an empty one. The UI disables the controls too, but the
      // rule belongs here, where it cannot be bypassed by a stale read.
      if (state.status !== 'idle') return state;

      return {
        ...state,
        messages: replaceMessage(state.messages, action.id, (message) =>
          selectSwipe(message, action.index),
        ),
        revision: state.revision + 1,
      };

    case 'gen/started': {
      if (state.status !== 'idle') return state;

      const base = { ...state, status: 'connecting' as const, mode: action.mode, error: null };
      const last = state.messages[state.messages.length - 1];
      const awaitingReply = Boolean(last?.is_user);

      // Retry. The transcript ends on the user's turn — because the last attempt failed,
      // or because they deleted the reply — so there is nothing to replace and this is
      // just a fresh generation. SillyTavern behaves the same way (script.js:11567).
      if (action.mode === 'send' || (action.mode === 'regenerate' && awaitingReply)) {
        const placeholder = assistantPlaceholder(action.newId, action.name);
        return {
          ...base,
          mode: 'send',
          messages: [...state.messages, placeholder],
          streamingId: action.newId,
        };
      }

      // Swiping and continuing act on the reply at the end of the transcript. With a
      // user turn sitting after it there is nothing to extend.
      if (awaitingReply) return state;

      const index = lastAssistantIndex(state.messages);
      if (index === -1) return state;
      const target = state.messages[index]!;
      const messages = [...state.messages];

      if (action.mode === 'swipe') {
        // A new, empty swipe. Empty matters: assemble skips blank content, so the
        // message excludes itself from its own prompt without any splicing.
        messages[index] = appendSwipe(target, '', {
          send_date: timestamp(),
          gen_started: timestamp(),
        });
        return { ...base, messages, streamingId: target.id };
      }

      if (action.mode === 'regenerate') {
        messages[index] = assistantPlaceholder(action.newId, target.name);
        return {
          ...base,
          messages,
          streamingId: action.newId,
          // Kept so a failure can put the original back, alternates and all.
          discarded: { message: target, index },
        };
      }

      // Continue extends the existing text; the stream store is seeded with it.
      return { ...base, messages, streamingId: target.id };
    }

    case 'gen/inspected':
      return {
        ...state,
        inspections: [action.inspection, ...state.inspections].slice(0, MAX_INSPECTIONS),
      };

    case 'gen/streaming':
      // A late frame from a generation that already settled must not revive it.
      return state.status === 'connecting' ? { ...state, status: 'streaming' } : state;

    case 'gen/finished':
      if (state.status === 'idle') return state;
      return settle(state, action.text, action.extra, action.alternates);

    case 'gen/aborted':
      if (state.status === 'idle') return state;
      return settle(
        state,
        action.text,
        action.text || action.reasoning
          ? { truncated: true, ...(action.reasoning ? { reasoning: action.reasoning } : {}) }
          : undefined,
      );

    case 'gen/failed': {
      if (state.status === 'idle') return state;
      const text = action.text ?? '';
      return {
        ...settle(
          state,
          text,
          text || action.reasoning
            ? { truncated: true, ...(action.reasoning ? { reasoning: action.reasoning } : {}) }
            : undefined,
        ),
        error: action.message,
      };
    }

    case 'error/cleared':
      return { ...state, error: null };

    default:
      return state;
  }
}

/** The transcript in storage/wire form. Also what assemblePrompt consumes. */
export function toChatMessages(state: ChatState): ChatMessage[] {
  return state.messages.map(toChatMessage);
}

/**
 * The durable transcript represented by `state.revision`.
 *
 * Starting a generation deliberately does not increment the revision: a blank
 * placeholder, a tentative swipe, or regenerate's temporary replacement is UI state
 * until the request settles. A save that was prompted by the preceding user edit must
 * therefore project the pre-generation transcript rather than accidentally make that
 * transient state durable under the earlier revision.
 */
export function toPersistedChatMessages(state: ChatState): ChatMessage[] {
  let messages = state.messages;

  if (state.status !== 'idle' && state.streamingId) {
    switch (state.mode) {
      case 'send':
        messages = messages.filter((message) => message.id !== state.streamingId);
        break;

      case 'swipe':
        messages = messages.map((message) =>
          message.id === state.streamingId ? removeSwipe(message, message.swipe_id) : message,
        );
        break;

      case 'regenerate': {
        const index = messages.findIndex((message) => message.id === state.streamingId);
        if (index !== -1 && state.discarded) {
          messages = [...messages];
          messages[index] = state.discarded.message;
        }
        break;
      }

      // Continue has not altered the transcript: the original assistant message is
      // already the durable content for this revision.
      default:
        break;
    }
  }

  return messages.map(toChatMessage);
}
