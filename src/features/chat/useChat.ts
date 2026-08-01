/**
 * Chat orchestration: assembly, streaming, and persistence.
 *
 * The ordering inside a generation is load-bearing and documented at `generate` below.
 * Everything that mutates the transcript goes through the reducer; the streaming text
 * goes through the store and never touches React state.
 */

import { type MessageState, currentText } from '@shared/chat/message.ts';
import { DEFAULT_USER_NAME, assemblePrompt } from '@shared/prompt/assemble.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ConnectionSettings } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, ChatSummary, Persona } from '@shared/types/chat.ts';
import type { GenerationType, Preset } from '@shared/types/preset.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { chatApi, streamGenerate } from '../../lib/api.ts';
import {
  type ChatAction,
  type ChatState,
  type GenMode,
  type PromptInspection,
  chatReducer,
  initialChatState,
  toChatMessages,
} from './state/chatReducer.ts';
import { type StreamStore, createStreamStore } from './state/streamStore.ts';

/** Debounce for saves that are not worth a round trip each. */
const SAVE_DELAY_MS = 400;

const MODE_TO_GENERATION_TYPE: Record<GenMode, GenerationType> = {
  send: 'normal',
  regenerate: 'regenerate',
  swipe: 'swipe',
  continue: 'continue',
};

export interface UseChatOptions {
  characterId: string | null;
  character: CardDataV2 | null;
  preset: Preset | null;
  persona: Persona | null;
  connection: ConnectionSettings | null;
  countTokens: TokenCounter;
  streamingFps: number;
}

export interface UseChat {
  state: ChatState;
  /** The transcript in wire form. Feeds both the UI and assemblePrompt. */
  messages: ChatMessage[];
  stream: StreamStore;
  inspection: PromptInspection | null;
  busy: boolean;
  saving: boolean;

  send(text: string): Promise<void>;
  regenerate(): Promise<void>;
  /** -1 shows a cached swipe; +1 past the end generates a new one. */
  swipe(direction: -1 | 1): Promise<void>;
  continueLast(): Promise<void>;
  abort(): void;

  editMessage(id: string, text: string): void;
  deleteMessage(id: string): void;
  toggleHidden(id: string): void;

  chats: ChatSummary[];
  openChat(chatId: string): Promise<void>;
  newChat(): Promise<void>;
  renameChat(title: string): void;
  deleteChat(chatId: string): Promise<void>;
  branchFrom(messageId: string): Promise<void>;
}

export function useChat(options: UseChatOptions): UseChat {
  const { characterId, character, preset, persona, connection, countTokens, streamingFps } =
    options;

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [saving, setSaving] = useState(false);

  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);
  const abortRef = useRef<AbortController | null>(null);

  // The generation body reads state after dispatching into it, so the closure's copy is
  // always stale. A ref is the simplest correct answer.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Keyed on the transcript alone: status and revision change far more often and would
  // rebuild the projection for no reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the transcript only
  const messages = useMemo(() => toChatMessages(state), [state.messages]);

  // --- Chat list -------------------------------------------------------------

  const refreshChats = useCallback(async () => {
    if (!characterId) {
      setChats([]);
      return;
    }
    try {
      setChats(await chatApi.list(characterId));
    } catch {
      setChats([]);
    }
  }, [characterId]);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  // Open the most recent chat for a character, or start one seeded with the greeting.
  useEffect(() => {
    if (!characterId || !character) {
      dispatch({ type: 'chat/closed' });
      return;
    }

    let cancelled = false;

    (async () => {
      const existing = await chatApi.list(characterId).catch(() => []);
      if (cancelled) return;

      if (existing[0]) {
        const chat = await chatApi.get(existing[0].id).catch(() => null);
        if (!cancelled && chat) dispatch({ type: 'chat/loaded', chat });
        return;
      }

      const chat = await chatApi.create({ characterId, title: 'New chat' }).catch(() => null);
      if (cancelled || !chat) return;
      dispatch({ type: 'chat/loaded', chat });
      dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    })();

    return () => {
      cancelled = true;
    };
  }, [characterId, character]);

  // --- Persistence -----------------------------------------------------------

  // Saves are serialised so a slow write cannot be overtaken by a fast one and land
  // stale content on top of newer.
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const lastSaved = useRef(0);

  useEffect(() => {
    if (!state.chatId || state.revision === 0 || state.revision === lastSaved.current) return;

    const revision = state.revision;
    const chatId = state.chatId;
    const timer = setTimeout(() => {
      lastSaved.current = revision;
      setSaving(true);

      saveChain.current = saveChain.current
        .then(() =>
          chatApi.save(chatId, {
            title: stateRef.current.title,
            metadata: stateRef.current.metadata,
            messages: toChatMessages(stateRef.current),
          }),
        )
        .catch(() => {
          // A failed save leaves the transcript in memory; the next change retries.
        })
        .finally(() => setSaving(false));
    }, SAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [state.revision, state.chatId]);

  // --- Generation ------------------------------------------------------------

  /**
   * Run one generation.
   *
   * Two things about the ordering are load-bearing:
   *
   *  1. The placeholder must exist BEFORE assembly, because its empty text is what
   *     excludes the message being generated from its own prompt.
   *  2. Its state has to be obtained by folding the action through the reducer, not by
   *     reading it back after `dispatch`. React batches, so the ref still holds the
   *     pre-dispatch state at this point — reading it back would see `status: 'idle'`
   *     and abandon the generation before it started. The reducer is pure, so applying
   *     it here and dispatching the same action is consistent by construction.
   *
   * @param base The state to build on, when the caller has already folded an action
   *   into it (as `send` does with the user's message).
   */
  const generate = useCallback(
    async (mode: GenMode, base?: ChatState) => {
      const current = base ?? stateRef.current;
      if (current.status !== 'idle') return;
      if (!character || !preset || !connection) return;

      const startAction: ChatAction = {
        type: 'gen/started',
        mode,
        newId: crypto.randomUUID(),
        name: character.name,
      };

      const started = chatReducer(current, startAction);
      dispatch(startAction);

      // The reducer refuses some starts outright — swiping with no reply to swipe.
      if (started.status === 'idle' || !started.streamingId) return;

      const target = started.messages.find((m) => m.id === started.streamingId);
      // Continue extends the existing text rather than replacing it. The postfix has to
      // match the one assembly puts in the prefill, or the two halves join differently
      // from how the model saw them.
      const seed =
        mode === 'continue' && target
          ? `${currentText(target)}${preset.continue_postfix ?? ' '}`
          : '';

      const generationType = MODE_TO_GENERATION_TYPE[mode];
      const assembled = assemblePrompt({
        preset,
        character,
        persona,
        messages: toChatMessages(started),
        generationType,
        countTokens,
        seed: started.chatId ?? '',
      });

      const body = buildRequestBody({
        messages: assembled.messages,
        preset,
        connection,
        stream: preset.stream_openai !== false,
      });

      const inspection: PromptInspection = {
        at: Date.now(),
        generationType,
        messages: assembled.messages,
        tokenCounts: assembled.tokenCounts,
        totalTokens: assembled.totalTokens,
        droppedMessages: assembled.droppedMessages,
        body,
      };
      dispatch({ type: 'gen/inspected', inspection });

      const controller = new AbortController();
      abortRef.current = controller;
      stream.begin(seed);

      let text = seed;

      try {
        const final = await streamGenerate(
          body,
          controller.signal,
          {
            onFirstToken: () => dispatch({ type: 'gen/streaming' }),
            onTick: (streamState) => {
              text = streamState.content;
              stream.set(streamState.content, streamState.reasoning);
            },
          },
          seed,
        );

        stream.end();
        dispatch({
          type: 'gen/finished',
          text: final.content,
          extra: {
            api: connection.provider,
            model: final.model ?? connection.model,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            // A real count from the provider beats our estimate when we get one.
            token_count: final.usage?.completion_tokens ?? countTokens(final.content),
          },
        });
      } catch (error) {
        stream.end();
        // Whatever arrived before the failure is kept, as SillyTavern does.
        if (controller.signal.aborted) dispatch({ type: 'gen/aborted', text });
        else dispatch({ type: 'gen/failed', message: (error as Error).message, text });
      } finally {
        abortRef.current = null;
        void refreshChats();
      }
    },
    [character, preset, persona, connection, countTokens, stream, refreshChats],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || stateRef.current.status !== 'idle') return;

      const userAction: ChatAction = {
        // The name becomes message.name, which names_behavior can put into the prompt
        // text — so it has to be the same name {{user}} expands to, not a friendlier
        // label. See DEFAULT_USER_NAME.
        type: 'message/appendUser',
        id: crypto.randomUUID(),
        name: persona?.name ?? DEFAULT_USER_NAME,
        text: trimmed,
      };

      dispatch(userAction);
      // Hand the folded state forward: the user's message must be in the history the
      // reply is assembled from, and dispatch has not re-rendered yet.
      await generate('send', chatReducer(stateRef.current, userAction));
    },
    [generate, persona],
  );

  const regenerate = useCallback(() => generate('regenerate'), [generate]);
  const continueLast = useCallback(() => generate('continue'), [generate]);

  const swipe = useCallback(
    async (direction: -1 | 1) => {
      const current = stateRef.current;
      if (current.status !== 'idle') return;

      const target = [...current.messages].reverse().find((m) => !m.is_user);
      if (!target) return;

      const next = target.swipe_id + direction;

      // Swiping into the existing array is instant and generates nothing.
      if (next >= 0 && next < target.swipes.length) {
        dispatch({ type: 'swipe/select', id: target.id, index: next });
        return;
      }

      // Left at the first swipe does nothing — no wraparound, matching SillyTavern.
      if (direction === -1) return;

      await generate('swipe');
    },
    [generate],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // --- Transcript edits ------------------------------------------------------

  const editMessage = useCallback((id: string, text: string) => {
    dispatch({ type: 'message/edited', id, text });
  }, []);

  const deleteMessage = useCallback((id: string) => {
    dispatch({ type: 'message/deleted', id });
  }, []);

  const toggleHidden = useCallback((id: string) => {
    dispatch({ type: 'message/toggleHidden', id });
  }, []);

  // --- Chat management -------------------------------------------------------

  const openChat = useCallback(async (chatId: string) => {
    const chat = await chatApi.get(chatId);
    dispatch({ type: 'chat/loaded', chat });
  }, []);

  const newChat = useCallback(async () => {
    if (!characterId || !character) return;
    const chat = await chatApi.create({ characterId, title: 'New chat' });
    dispatch({ type: 'chat/loaded', chat });
    dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    await refreshChats();
  }, [characterId, character, refreshChats]);

  const renameChat = useCallback((title: string) => {
    dispatch({ type: 'chat/renamed', title });
  }, []);

  const deleteChat = useCallback(
    async (chatId: string) => {
      await chatApi.remove(chatId);
      if (stateRef.current.chatId === chatId) dispatch({ type: 'chat/closed' });
      await refreshChats();
    },
    [refreshChats],
  );

  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!stateRef.current.chatId) return;
      const branch = await chatApi.branch(stateRef.current.chatId, messageId);
      dispatch({ type: 'chat/loaded', chat: branch });
      await refreshChats();
    },
    [refreshChats],
  );

  return {
    state,
    messages,
    stream,
    inspection: state.inspections[0] ?? null,
    busy: state.status !== 'idle',
    saving,
    send,
    regenerate,
    swipe,
    continueLast,
    abort,
    editMessage,
    deleteMessage,
    toggleHidden,
    chats,
    openChat,
    newChat,
    renameChat,
    deleteChat,
    branchFrom,
  };
}

/** The last assistant message, which is the only swipeable/continuable one. */
export function lastAssistant(messages: MessageState[]): MessageState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]!.is_user) return messages[i]!;
  }
  return null;
}
