/**
 * Co-Creator session state.
 *
 * Pure and exhaustive, so the rules that are easy to get wrong — what a failed re-roll
 * leaves behind, what a mid-flight save is allowed to make durable — are testable without
 * React anywhere near them.
 *
 * Not `chatReducer`. That one carries a character, a persona, chat metadata, prompt
 * inspections, a four-value GenMode and regenerate's displaced message; none of those exist
 * here. Widening `ChatState` with six fields that are always null in one of its two users
 * would be worse than a second reducer, and forking it would be worse than either.
 *
 * The streaming text is deliberately NOT in here, same as chat: it lives in `streamStore`
 * and reaches one leaf through `useSyncExternalStore`, so a reply that arrives over sixty
 * seconds produces three or four actions rather than eighteen hundred.
 */

import {
  appendSwipe,
  assistantPlaceholder,
  fromChatMessage,
  type MessageState,
  removeSwipe,
  selectSwipe,
  setText,
  timestamp,
  toChatMessage,
  userMessage,
} from '@shared/chat/message.ts';
import {
  clearAll,
  clearSlot,
  editGreeting,
  editSlot,
  emptyStash,
  removeGreeting,
  removeTag,
  reorderGreetings,
  setSlot,
} from '@shared/cocreator/stash.ts';
import type { ChatMessage, MessageExtra } from '@shared/types/chat.ts';
import {
  type CardSlot,
  type CardStash,
  type CocreatorSession,
  DEFAULT_EXAMPLE_FIELDS,
  type ExampleField,
  type ExampleSelection,
  type SessionModelSettings,
  type SingleCardSlot,
  type StashProvenance,
} from '@shared/types/cocreator.ts';

/**
 * Speaker labels.
 *
 * Constants rather than a stored column: a design session has exactly two speakers, so the
 * name is UI text, not data worth persisting per row.
 */
export const DESIGNER_NAME = 'You';
export const ASSISTANT_NAME = 'Design assistant';

/**
 * Only two modes.
 *
 * There is no `regenerate`: re-rolling a reply appends a swipe, exactly like overswiping in
 * chat. So nothing is ever displaced and there is nothing to restore on failure — which is
 * structurally stronger than chat's fix for the same hazard (chatReducer.ts:237-244, where a
 * failed regenerate has to splice the original back). Do not "restore parity" by adding a
 * destructive regenerate here; that would reintroduce the bug that fix exists to prevent.
 *
 * There is no `continue` either: the design assistant is answering questions, not writing
 * prose that trails off.
 */
export type CoGenMode = 'send' | 'swipe';
export type CoStatus = 'idle' | 'connecting' | 'streaming';

export interface CocreatorState {
  sessionId: string | null;
  title: string;
  messages: MessageState[];
  stash: CardStash;
  examples: ExampleSelection;
  settings: SessionModelSettings;
  /** Filename under data/cocreator/avatars, or null. */
  avatar: string | null;
  finishedAvatar: string | null;
  status: CoStatus;
  /** The message being generated into. An id, because indices shift. */
  streamingId: string | null;
  mode: CoGenMode | null;
  /**
   * The swipe the reader was on when a re-roll started, restored if it produces nothing.
   *
   * Unlike chat — where `›` only generates once you are already on the last take, so the
   * clamp in `removeSwipe` happens to put you back — the co-creator re-rolls from an
   * explicit button that works from any take. Without this, failing a re-roll launched from
   * take 1 of 3 would silently move the reader to take 3.
   */
  resumeSwipeId: number | null;
  error: string | null;
  /** Monotonic revision for this session, matching the server after a successful save. */
  revision: number;
  /** The greatest revision the server has acknowledged for the open session. */
  persistedRevision: number;
}

export const initialCocreatorState: CocreatorState = {
  sessionId: null,
  title: '',
  messages: [],
  stash: emptyStash(),
  examples: { cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
  settings: {},
  avatar: null,
  finishedAvatar: null,
  status: 'idle',
  streamingId: null,
  mode: null,
  resumeSwipeId: null,
  error: null,
  revision: 0,
  persistedRevision: 0,
};

export type CocreatorAction =
  | { type: 'session/loaded'; session: CocreatorSession }
  | { type: 'session/closed' }
  | { type: 'session/saved'; sessionId: string; revision: number }
  | { type: 'session/renamed'; title: string }
  | { type: 'message/appendUser'; id: string; text: string }
  | { type: 'message/edited'; id: string; text: string }
  | { type: 'message/deleted'; id: string }
  | { type: 'swipe/select'; id: string; index: number }
  | { type: 'gen/started'; mode: CoGenMode; newId: string }
  | { type: 'gen/streaming' }
  | { type: 'gen/finished'; text: string; extra?: MessageExtra }
  | { type: 'gen/aborted'; text: string; reasoning?: string }
  | { type: 'gen/failed'; message: string; text?: string; reasoning?: string }
  | { type: 'stash/set'; slot: CardSlot; text: string; provenance: StashProvenance }
  | { type: 'stash/editSlot'; slot: SingleCardSlot; text: string }
  | { type: 'stash/editGreeting'; index: number; text: string }
  | { type: 'stash/reorderGreetings'; from: number; to: number }
  | { type: 'stash/removeGreeting'; index: number }
  | { type: 'stash/removeTag'; index: number }
  | { type: 'stash/clear'; slot: CardSlot }
  | { type: 'stash/clearAll' }
  | { type: 'examples/add'; avatar: string }
  | { type: 'examples/remove'; avatar: string }
  | { type: 'examples/reorder'; from: number; to: number }
  | { type: 'examples/setField'; field: ExampleField; on: boolean }
  | { type: 'settings/patch'; patch: SessionModelSettings }
  | { type: 'avatar/set'; filename: string }
  | { type: 'avatar/cleared' }
  | { type: 'finished/recorded'; avatar: string }
  | { type: 'error/cleared' };

function replaceMessage(
  messages: MessageState[],
  id: string,
  update: (message: MessageState) => MessageState,
): MessageState[] {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

/** A stash edit that changed nothing must not cost a revision. */
function withStash(state: CocreatorState, stash: CardStash): CocreatorState {
  if (stash === state.stash) return state;
  return { ...state, stash, revision: state.revision + 1 };
}

/** Undo a re-roll: drop the blank alternate and put the reader back where they were. */
function undoOverswipe(message: MessageState, resumeSwipeId: number | null): MessageState {
  const without = removeSwipe(message, message.swipe_id);
  return resumeSwipeId === null ? without : selectSwipe(without, resumeSwipeId);
}

/**
 * Settle a finished, aborted or failed generation back into a consistent state.
 *
 * Two arms, not chat's three, because re-rolling is an overswipe: `send` added a placeholder
 * and `swipe` added a blank alternate, and each has to undo exactly that much. Without the
 * `swipe` arm every network hiccup leaves a blank alternate behind for the user to swipe
 * past — the regression `chatReducer.test.ts` names as a gate.
 */
function settle(state: CocreatorState, text: string, extra?: MessageExtra): CocreatorState {
  const id = state.streamingId;
  const mode = state.mode;
  if (!id || !mode) {
    return { ...state, status: 'idle', streamingId: null, mode: null, resumeSwipeId: null };
  }

  const settled = {
    status: 'idle' as const,
    streamingId: null,
    mode: null,
    resumeSwipeId: null,
    revision: state.revision + 1,
  };
  if (!state.messages.some((message) => message.id === id)) return { ...state, ...settled };

  // Anything the model actually produced is kept, even from an abort or an error. Thinking
  // models can legitimately finish before emitting ordinary content; their reasoning is
  // still a visible result and must not disappear.
  if (text || extra?.reasoning) {
    const finished = timestamp();
    return {
      ...state,
      ...settled,
      messages: replaceMessage(state.messages, id, (message) =>
        setText(message, text, { gen_finished: finished, extra }),
      ),
    };
  }

  switch (mode) {
    case 'send':
      return { ...state, ...settled, messages: state.messages.filter((m) => m.id !== id) };

    case 'swipe':
      return {
        ...state,
        ...settled,
        messages: replaceMessage(state.messages, id, (message) =>
          undoOverswipe(message, state.resumeSwipeId),
        ),
      };
  }
}

export function cocreatorReducer(state: CocreatorState, action: CocreatorAction): CocreatorState {
  switch (action.type) {
    case 'session/loaded':
      return {
        ...initialCocreatorState,
        sessionId: action.session.id,
        title: action.session.title,
        messages: action.session.messages.map(fromChatMessage),
        stash: action.session.stash,
        examples: action.session.examples,
        settings: action.session.settings,
        avatar: action.session.avatar,
        finishedAvatar: action.session.finishedAvatar,
        revision: action.session.revision,
        persistedRevision: action.session.revision,
      };

    case 'session/closed':
      return initialCocreatorState;

    case 'session/saved':
      if (action.sessionId !== state.sessionId) return state;
      return {
        ...state,
        persistedRevision: Math.max(state.persistedRevision, action.revision),
      };

    case 'session/renamed':
      if (action.title === state.title) return state;
      return { ...state, title: action.title, revision: state.revision + 1 };

    case 'message/appendUser':
      return {
        ...state,
        messages: [
          ...state.messages,
          // No persona: a design session has no story and nobody to be in it.
          userMessage(action.id, DESIGNER_NAME, action.text, null),
        ],
        revision: state.revision + 1,
        error: null,
      };

    case 'message/edited':
      return {
        ...state,
        messages: replaceMessage(state.messages, action.id, (message) =>
          setText(message, action.text),
        ),
        revision: state.revision + 1,
      };

    case 'message/deleted':
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== action.id),
        revision: state.revision + 1,
      };

    case 'swipe/select':
      // A generation writes into whichever swipe is selected when it settles, so moving the
      // selection mid-flight would land the reply in the wrong slot. The rule lives here
      // rather than only on the disabled buttons.
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

      if (action.mode === 'send') {
        return {
          ...base,
          messages: [...state.messages, assistantPlaceholder(action.newId, ASSISTANT_NAME)],
          streamingId: action.newId,
        };
      }

      // Re-rolling acts on the reply at the end of the transcript. With a user turn sitting
      // after it there is nothing to re-roll — that is a plain send, which the caller asks
      // for by name.
      const index = state.messages.length - 1;
      const target = state.messages[index];
      if (!target || target.is_user) return state;

      const messages = [...state.messages];
      // A new, empty swipe. Empty matters: the prompt builder skips blank content, so the
      // message excludes itself from its own prompt without any splicing.
      messages[index] = appendSwipe(target, '', {
        send_date: timestamp(),
        gen_started: timestamp(),
      });
      return { ...base, messages, streamingId: target.id, resumeSwipeId: target.swipe_id };
    }

    case 'gen/streaming':
      // A late frame from a generation that already settled must not revive it.
      return state.status === 'connecting' ? { ...state, status: 'streaming' } : state;

    case 'gen/finished':
      if (state.status === 'idle') return state;
      return settle(state, action.text, action.extra);

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

    case 'stash/set':
      return withStash(state, setSlot(state.stash, action.slot, action.text, action.provenance));

    case 'stash/editSlot':
      return withStash(state, editSlot(state.stash, action.slot, action.text));

    case 'stash/editGreeting':
      return withStash(state, editGreeting(state.stash, action.index, action.text));

    case 'stash/reorderGreetings':
      return withStash(state, reorderGreetings(state.stash, action.from, action.to));

    case 'stash/removeGreeting':
      return withStash(state, removeGreeting(state.stash, action.index));

    case 'stash/removeTag':
      return withStash(state, removeTag(state.stash, action.index));

    case 'stash/clear':
      return withStash(state, clearSlot(state.stash, action.slot));

    case 'stash/clearAll':
      return withStash(state, clearAll());

    case 'examples/add': {
      if (state.examples.cards.includes(action.avatar)) return state;
      return {
        ...state,
        examples: { ...state.examples, cards: [...state.examples.cards, action.avatar] },
        revision: state.revision + 1,
      };
    }

    case 'examples/remove': {
      if (!state.examples.cards.includes(action.avatar)) return state;
      return {
        ...state,
        examples: {
          ...state.examples,
          cards: state.examples.cards.filter((avatar) => avatar !== action.avatar),
        },
        revision: state.revision + 1,
      };
    }

    case 'examples/reorder': {
      const { from, to } = action;
      const cards = state.examples.cards;
      if (from === to || from < 0 || from >= cards.length || to < 0 || to >= cards.length) {
        return state;
      }
      const next = [...cards];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return {
        ...state,
        examples: { ...state.examples, cards: next },
        revision: state.revision + 1,
      };
    }

    case 'examples/setField': {
      if (state.examples.fields[action.field] === action.on) return state;
      return {
        ...state,
        examples: {
          ...state.examples,
          fields: { ...state.examples.fields, [action.field]: action.on },
        },
        revision: state.revision + 1,
      };
    }

    case 'settings/patch':
      return {
        ...state,
        settings: { ...state.settings, ...action.patch },
        revision: state.revision + 1,
      };

    case 'avatar/set':
      return { ...state, avatar: action.filename, revision: state.revision + 1 };

    case 'avatar/cleared':
      if (state.avatar === null) return state;
      return { ...state, avatar: null, revision: state.revision + 1 };

    case 'finished/recorded':
      return { ...state, finishedAvatar: action.avatar, revision: state.revision + 1 };

    case 'error/cleared':
      return state.error === null ? state : { ...state, error: null };

    default:
      return state;
  }
}

/** The transcript in storage/wire form. */
export function toChatMessages(state: CocreatorState): ChatMessage[] {
  return state.messages.map(toChatMessage);
}

/**
 * The durable transcript represented by `state.revision`.
 *
 * Starting a generation deliberately does not increment the revision: a blank placeholder or
 * a tentative swipe is UI state until the request settles. A save prompted by the preceding
 * user message — which *did* bump the revision — must therefore project the pre-generation
 * transcript rather than accidentally make that transient state durable under it.
 */
export function toPersistedMessages(state: CocreatorState): ChatMessage[] {
  let messages = state.messages;

  if (state.status !== 'idle' && state.streamingId) {
    const streamingId = state.streamingId;
    switch (state.mode) {
      case 'send':
        messages = messages.filter((message) => message.id !== streamingId);
        break;
      case 'swipe':
        messages = messages.map((message) =>
          message.id === streamingId ? undoOverswipe(message, state.resumeSwipeId) : message,
        );
        break;
      default:
        break;
    }
  }

  return messages.map(toChatMessage);
}

/** Whether there is unsaved work — what a flush has to drain before a transition. */
export function hasUnsavedWork(state: CocreatorState): boolean {
  return state.sessionId !== null && state.revision > state.persistedRevision;
}
