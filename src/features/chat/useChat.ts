/**
 * Chat orchestration: assembly, streaming, and persistence.
 *
 * The ordering inside a generation is load-bearing and documented at `generate` below.
 * Everything that mutates the transcript goes through the reducer; the streaming text
 * goes through the store and never touches React state.
 */

import { type MessageState, currentText } from '@shared/chat/message.ts';
import { DEFAULT_USER_NAME, assemblePrompt } from '@shared/prompt/assemble.ts';
import { resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { ConnectionSettings } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSaveSnapshot,
  ChatSummary,
  MacroVariableMap,
  Persona,
} from '@shared/types/chat.ts';
import type { GenerationType, Preset } from '@shared/types/preset.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { chatApi, streamGenerate } from '../../lib/api.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';
import { ChatSaveQueue } from './chatPersistence.ts';
import {
  type ChatAction,
  type ChatState,
  type GenMode,
  type PromptInspection,
  chatReducer,
  initialChatState,
  toChatMessages,
  toPersistedChatMessages,
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
  /** Every persona. Which one applies is resolved in here — see `persona` below. */
  personas: Persona[];
  /** The persona new chats start with. `AppSettings.personaId`. */
  defaultPersonaId: string | null;
  connection: ConnectionSettings | null;
  countTokens: TokenCounter;
  streamingFps: number;
  /** Lorebooks that apply to this chat, already loaded. */
  worldInfoSources?: WorldInfoSource[];
  /** Resolve sources after this hook has selected the chat-scoped persona. */
  resolveWorldInfoSources?: (personaLorebookId?: string) => WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  /** Persist global macro effects and refresh the app settings snapshot. */
  onGlobalVariablesChange: (variables: MacroVariableMap) => Promise<void>;
}

export interface UseChat {
  state: ChatState;
  /** The transcript in wire form. Feeds both the UI and assemblePrompt. */
  messages: ChatMessage[];
  stream: StreamStore;
  inspection: PromptInspection | null;
  busy: boolean;
  saving: boolean;
  /** A persistence failure blocks chat-changing navigation until it is retried. */
  saveError: string | null;

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
  /** Persist the open transcript before another owner replaces or deletes it. */
  flushSaves(): Promise<void>;
  retrySave(): Promise<void>;

  /** The persona this chat actually uses. Resolved here, not passed in. */
  persona: Persona | null;
  setPersona(personaId: string | null): void;
  updateMetadata(patch: Partial<ChatMetadata>): void;
  /** Resolve a stored greeting for display without committing variable macro effects. */
  renderGreeting(text: string): string;
  /** What World Info did on the last generation, for the inspector. */
  worldInfo: ActivationResult | null;
}

export function useChat(options: UseChatOptions): UseChat {
  const {
    characterId,
    character,
    preset,
    personas,
    defaultPersonaId,
    connection,
    countTokens,
    streamingFps,
    worldInfoSources,
    resolveWorldInfoSources,
    worldInfoSettings,
    globalVariables,
    onGlobalVariablesChange,
  } = options;

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [worldInfo, setWorldInfo] = useState<ActivationResult | null>(null);

  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);
  const abortRef = useRef<AbortController | null>(null);

  // The generation body reads state after dispatching into it, so the closure's copy is
  // always stale. A ref is the simplest correct answer.
  const stateRef = useRef(state);
  stateRef.current = state;

  const defaultPersonaRef = useRef(defaultPersonaId);
  defaultPersonaRef.current = defaultPersonaId;

  const captureSnapshot = useCallback((source: ChatState): ChatSaveSnapshot | null => {
    if (!source.chatId) return null;
    return structuredClone({
      chatId: source.chatId,
      revision: source.revision,
      title: source.title,
      metadata: source.metadata,
      messages: toPersistedChatMessages(source),
    });
  }, []);

  const persistenceRef = useRef<ChatSaveQueue | null>(null);
  if (!persistenceRef.current) {
    persistenceRef.current = new ChatSaveQueue(
      (snapshot, requestOptions) => chatApi.save(snapshot, requestOptions),
      SAVE_DELAY_MS,
      {
        onSaved: (snapshot) => {
          dispatch({ type: 'chat/saved', chatId: snapshot.chatId, revision: snapshot.revision });
          if (stateRef.current.chatId === snapshot.chatId) setSaveError(null);
        },
        onFailed: (chatId, error) => {
          if (stateRef.current.chatId === chatId) setSaveError(error.message);
        },
        onPendingChange: setSaving,
      },
    );
  }
  const persistence = persistenceRef.current;

  // Keyed on the transcript alone: status and revision change far more often and would
  // rebuild the projection for no reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the transcript only
  const messages = useMemo(() => toChatMessages(state), [state.messages]);

  const loadChat = useCallback((chat: Chat) => {
    dispatch({ type: 'chat/loaded', chat, defaultPersonaId: defaultPersonaRef.current });
  }, []);

  // --- Persona ---------------------------------------------------------------

  /**
   * The chat wins over the app default.
   *
   * `AppSettings.personaId` is the persona NEW chats start with; `ChatMetadata.persona` is
   * the one this chat is using. A chat is a transcript in which "you" said things, so
   * letting the app default retroactively apply would relabel every past message the
   * moment the default changed.
   *
   * Resolved here rather than in App: computing it up there from `chat.state.metadata` and
   * feeding it back in as a prop would be a cycle.
   */
  const persona = useMemo(() => {
    const stored = state.metadata.persona;
    if (stored === null) return null;
    if (typeof stored === 'string') return personas.find((item) => item.id === stored) ?? null;
    // A loaded chat is migrated before it reaches this point. No-chat state has no
    // persona, rather than borrowing the global new-chat default.
    return null;
  }, [state.metadata.persona, personas]);

  const setPersona = useCallback((personaId: string | null) => {
    dispatch({ type: 'chat/metadata', patch: { persona: personaId } });
  }, []);

  const updateMetadata = useCallback((patch: Partial<ChatMetadata>) => {
    dispatch({ type: 'chat/metadata', patch });
  }, []);

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
        if (!cancelled && chat) loadChat(chat);
        return;
      }

      const chat = await chatApi
        .create({
          characterId,
          title: 'New chat',
          metadata: { persona: defaultPersonaRef.current },
        })
        .catch(() => null);
      if (cancelled || !chat) return;
      loadChat(chat);
      dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    })();

    return () => {
      cancelled = true;
    };
  }, [characterId, character, loadChat]);

  // --- Persistence -----------------------------------------------------------

  useEffect(() => {
    if (!state.chatId) return;
    persistence.adopt(state.chatId, state.persistedRevision);
    if (state.revision <= state.persistedRevision) return;
    const snapshot = captureSnapshot(state);
    if (snapshot) persistence.schedule(snapshot);
  }, [captureSnapshot, persistence, state]);

  const flushSaves = useCallback(async () => {
    const current = stateRef.current;
    const snapshot = captureSnapshot(current);
    if (!snapshot || snapshot.revision <= current.persistedRevision) return;

    persistence.schedule(snapshot);
    try {
      await persistence.flush(snapshot.chatId);
      setSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(message);
      throw error;
    }
  }, [captureSnapshot, persistence]);

  const retrySave = useCallback(async () => {
    await flushSaves();
  }, [flushSaves]);

  useEffect(() => {
    const onPageHide = () => {
      const snapshot = captureSnapshot(stateRef.current);
      if (snapshot && snapshot.revision > stateRef.current.persistedRevision) {
        persistence.schedule(snapshot);
      }
      persistence.flushForPagehide();
    };

    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [captureSnapshot, persistence]);

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
      const chatMessages = toChatMessages(started);

      // Activation runs over the state that already contains the folded user message,
      // so the message just typed is in the scan buffer for the reply it triggers.
      const lore = worldInfoForChat({
        sources:
          resolveWorldInfoSources?.(persona?.lorebookId ?? undefined) ?? worldInfoSources ?? [],
        messages: chatMessages,
        settings: worldInfoSettings ?? DEFAULT_WI_SETTINGS,
        preset,
        chatId: started.chatId,
        // The same memoised counter assembly gets, or every entry is tokenised twice.
        countTokens,
      });
      setWorldInfo(lore);

      const assembled = assemblePrompt({
        preset,
        character,
        persona,
        messages: chatMessages,
        generationType,
        worldInfoBefore: lore?.before,
        worldInfoAfter: lore?.after,
        worldInfoDepth: lore?.depth,
        scenarioOverride:
          typeof started.metadata.scenario === 'string' ? started.metadata.scenario : undefined,
        authorNote: started.metadata.authorNote,
        localVariables: started.metadata.variables ?? {},
        globalVariables,
        countTokens,
        seed: started.chatId ?? '',
      });

      if (!assembled.ok) {
        dispatch({
          type: 'gen/inspected',
          inspection: {
            at: Date.now(),
            generationType,
            messages: assembled.messages,
            tokenCounts: assembled.tokenCounts,
            totalTokens: assembled.totalTokens,
            droppedMessages: assembled.droppedMessages,
            macroWarnings: assembled.macroWarnings,
            body: null,
            overflow: assembled.error,
          },
        });
        dispatch({
          type: 'gen/failed',
          message: `Context overflow: mandatory prompt content needs ${assembled.error.requiredPromptTokens} tokens, but only ${assembled.error.maxContext - assembled.error.reservedCompletionTokens} are available.`,
        });
        return;
      }

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
        macroWarnings: assembled.macroWarnings,
        body,
      };
      dispatch({ type: 'gen/inspected', inspection });

      // Macro effects are committed once, after the complete request exists and
      // immediately before the provider is contacted. Preview assembly receives the
      // same inputs and discards this result, so opening Prompt Manager cannot mutate
      // either scope. A later provider failure deliberately does not roll these back.
      if (assembled.variableUpdates.localChanged) {
        dispatch({
          type: 'chat/metadata',
          patch: { variables: assembled.variableUpdates.local },
        });
      }
      if (assembled.variableUpdates.globalChanged) {
        try {
          await onGlobalVariablesChange(assembled.variableUpdates.global);
        } catch (error) {
          dispatch({ type: 'gen/failed', message: (error as Error).message });
          return;
        }
      }

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
            token_count: final.usage?.completion_tokens ?? countTokens.countText(final.content),
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
    [
      character,
      preset,
      persona,
      connection,
      countTokens,
      stream,
      refreshChats,
      worldInfoSources,
      resolveWorldInfoSources,
      worldInfoSettings,
      globalVariables,
      onGlobalVariablesChange,
    ],
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

  const openChat = useCallback(
    async (chatId: string) => {
      try {
        await flushSaves();
      } catch {
        return;
      }
      const chat = await chatApi.get(chatId);
      loadChat(chat);
    },
    [flushSaves, loadChat],
  );

  const newChat = useCallback(async () => {
    if (!characterId || !character) return;
    try {
      await flushSaves();
    } catch {
      return;
    }
    const chat = await chatApi.create({
      characterId,
      title: 'New chat',
      metadata: { persona: defaultPersonaRef.current },
    });
    loadChat(chat);
    dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    await refreshChats();
  }, [characterId, character, flushSaves, loadChat, refreshChats]);

  const renameChat = useCallback((title: string) => {
    dispatch({ type: 'chat/renamed', title });
  }, []);

  const deleteChat = useCallback(
    async (chatId: string) => {
      try {
        await flushSaves();
      } catch {
        return;
      }
      await chatApi.remove(chatId);
      if (stateRef.current.chatId === chatId) dispatch({ type: 'chat/closed' });
      await refreshChats();
    },
    [flushSaves, refreshChats],
  );

  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!stateRef.current.chatId) return;
      try {
        await flushSaves();
      } catch {
        return;
      }
      const branch = await chatApi.branch(stateRef.current.chatId, messageId);
      loadChat(branch);
      await refreshChats();
    },
    [flushSaves, loadChat, refreshChats],
  );

  const renderGreeting = useCallback(
    (text: string) => {
      if (!character || !preset) return text;
      return resolveGreetingMacros(text, {
        character,
        preset,
        persona,
        messages: toChatMessages(state),
        metadata: state.metadata,
        globalVariables,
        seed: state.chatId ?? '',
      });
    },
    [character, preset, persona, state, globalVariables],
  );

  return {
    state,
    messages,
    stream,
    inspection: state.inspections[0] ?? null,
    busy: state.status !== 'idle',
    saving,
    saveError,
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
    flushSaves,
    retrySave,
    persona,
    setPersona,
    updateMetadata,
    renderGreeting,
    worldInfo,
  };
}

/** The last assistant message, which is the only swipeable/continuable one. */
export function lastAssistant(messages: MessageState[]): MessageState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]!.is_user) return messages[i]!;
  }
  return null;
}
