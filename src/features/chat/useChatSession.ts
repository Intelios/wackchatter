/**
 * One chat's state and its life on disk: the reducer, the save queue, opening the most recent
 * chat for a character, the chat list, the persona the chat speaks as, and the transcript
 * edits that are plain dispatches.
 *
 * Generation, the summary and chat management build on what this returns (`useChat` composes
 * them). The refs it exposes are deliberate: a generation reads state after dispatching into
 * it, so a closure's copy is always stale, and `stateRef` is the simplest correct answer.
 */

import type { ChatSaveRecord } from '@shared/chat/save.ts';
import { createDisplayRegexMacros, resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { RegexMacros } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSummary,
  MacroVariableMap,
  Persona,
} from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { chatApi } from '../../lib/api.ts';
import { adoptedPersona, KeyedSerialQueue, resolveInitialChat } from './chatInit.ts';
import { ChatSaveQueue } from './chatPersistence.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  initialChatState,
  toChatMessages,
  toPersistedMessageStates,
} from './state/chatReducer.ts';

/** Debounce for saves that are not worth a round trip each. */
const SAVE_DELAY_MS = 400;

export interface ChatSessionOptions {
  characterId: string | null;
  character: CardDataV2 | null;
  preset: Preset | null;
  personas: Persona[];
  personaId: string | null;
  onPersonaSwitch?: (personaId: string | null) => void;
  globalVariables: MacroVariableMap;
}

export interface ChatSession {
  state: ChatState;
  dispatch: Dispatch<ChatAction>;
  /** Always the latest state, including actions dispatched but not yet rendered. */
  stateRef: RefObject<ChatState>;
  messages: ChatMessage[];
  persona: Persona | null;
  setPersona: (personaId: string | null) => void;
  resolvePersona: (id: string | null) => Persona | null;
  updateMetadata: (patch: Partial<ChatMetadata>) => void;

  chats: ChatSummary[];
  setChats: Dispatch<SetStateAction<ChatSummary[]>>;
  refreshChats: () => Promise<void>;
  loadError: string | null;
  retryLoad: () => void;
  /** Adopt a chat from the server, and its recorded persona with it. */
  loadChat: (chat: Chat) => void;
  /** The app-wide persona, for a chat about to be created. */
  personaIdRef: RefObject<string | null>;
  /**
   * Bumped synchronously by every user chat-management action, before any await. The
   * auto-open stands down if it moved — a state read would be racy, since a dispatch only
   * becomes visible at render.
   */
  userChatAction: RefObject<number>;
  /** A chat to open instead of the most recent, once this character's card arrives. */
  pendingChatRef: RefObject<string | null>;

  saving: boolean;
  saveError: string | null;
  flushSaves: () => Promise<void>;
  retrySave: () => Promise<void>;
  captureSnapshot: (source: ChatState) => ChatSaveRecord | null;
  persistence: ChatSaveQueue;

  editMessage: (id: string, text: string) => void;
  editReasoning: (id: string, reasoning: string) => void;
  deleteMessage: (id: string) => void;
  toggleHidden: (id: string) => void;
  setHidden: (ids: string[], hidden: boolean) => void;

  renderGreeting: (text: string) => string;
  regexMacros: RegexMacros | null;
}

export function useChatSession(options: ChatSessionOptions): ChatSession {
  const { characterId, character, preset, personas, personaId, globalVariables } = options;

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);

  const stateRef = useRef(state);
  stateRef.current = state;

  const personaIdRef = useRef(personaId);
  personaIdRef.current = personaId;

  // Chat initialization is keyed on the selected character, not on callback or collection
  // identities from App. App passes the persona adoption handler inline, and persona edits
  // replace this array; putting either in loadChat's dependency list makes the init effect
  // reload the open chat from disk on an unrelated render — including gen/started, which
  // resets the generation to idle and causes every arriving stream frame to be ignored.
  const personasRef = useRef(personas);
  personasRef.current = personas;
  const onPersonaSwitchRef = useRef(options.onPersonaSwitch);
  onPersonaSwitchRef.current = options.onPersonaSwitch;

  // The card autosaves without the identity changing, so the chat-init effect must not key
  // on it — it would re-run on every keystroke. `cardLoaded` is the only stable signal; the
  // card itself is read from here at the moment creation actually needs it, so the greeting
  // always seeds from the freshest copy.
  const characterRef = useRef(character);
  characterRef.current = character;
  const cardLoaded = character !== null;

  // One independent tail per character. A -> B -> A must still wait for the original A
  // create request; a single global slot forgets it as soon as B takes the slot.
  const initQueueRef = useRef<KeyedSerialQueue | null>(null);
  if (!initQueueRef.current) initQueueRef.current = new KeyedSerialQueue();
  const initQueue = initQueueRef.current;

  const userChatAction = useRef(0);
  const pendingChatRef = useRef<string | null>(null);

  /*
   * One immutable save record. The states are the reducer's own objects — shared, not
   * cloned — which is what makes both the capture and the queue's diff cheap: identity
   * against the acknowledged base does the work two transcript-sized clones used to.
   * `saveId` is minted here so every redelivery of this record — debounce, flush,
   * keepalive — carries the same idempotency token.
   */
  const captureSnapshot = useCallback((source: ChatState): ChatSaveRecord | null => {
    if (!source.chatId) return null;
    return {
      chatId: source.chatId,
      revision: source.revision,
      saveId: crypto.randomUUID(),
      title: source.title,
      metadata: source.metadata,
      states: toPersistedMessageStates(source),
    };
  }, []);

  const persistenceRef = useRef<ChatSaveQueue | null>(null);
  if (!persistenceRef.current) {
    persistenceRef.current = new ChatSaveQueue(chatApi.save, SAVE_DELAY_MS, {
      onSaved: (snapshot) => {
        dispatch({ type: 'chat/saved', chatId: snapshot.chatId, revision: snapshot.revision });
        if (stateRef.current.chatId === snapshot.chatId) setSaveError(null);
      },
      onFailed: (chatId, error) => {
        if (stateRef.current.chatId === chatId) setSaveError(error.message);
      },
      onPendingChange: setSaving,
    });
  }
  const persistence = persistenceRef.current;

  // Keyed on the transcript alone: status and revision change far more often and would
  // rebuild the projection for no reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the transcript only
  const messages = useMemo(() => toChatMessages(state), [state.messages]);

  const loadChat = useCallback((chat: Chat) => {
    // Loading a chat adopts its recorded persona as the app-wide current one — the chat
    // wins, and the settings snapshot follows it. A chat with no record (an import from an
    // old export) keeps the current persona, which changes nothing to adopt.
    const adopted = adoptedPersona(chat, personaIdRef.current, personasRef.current);
    if (adopted.changed) onPersonaSwitchRef.current?.(adopted.effective);
    dispatch({ type: 'chat/loaded', chat });
  }, []);

  // --- Persona ---------------------------------------------------------------

  /**
   * The chat wins over the app-wide current persona.
   *
   * `AppSettings.personaId` is the persona you are using right now; `ChatMetadata.persona`
   * is the one this chat is using. A chat is a transcript in which "you" said things, so
   * loading it adopts its recorded persona — the settings follow the chat, never the other
   * way around. Resolved here rather than in App: computing it up there from the chat's
   * metadata and feeding it back in as a prop would be a cycle.
   */
  const persona = useMemo(() => {
    const stored = state.metadata.persona;
    if (typeof stored === 'string') return personas.find((item) => item.id === stored) ?? null;
    // None recorded, or no chat open: no persona, rather than borrowing the app-wide one.
    return null;
  }, [state.metadata.persona, personas]);

  const setPersona = useCallback((id: string | null) => {
    dispatch({ type: 'chat/metadata', patch: { persona: id } });
  }, []);

  /**
   * Resolve any persona id — not just the chat's own. Each user message records the persona
   * it was sent as, and the transcript needs that one, not whoever is speaking now. A deleted
   * persona resolves as none, the same orphan rule the panel applies.
   */
  const resolvePersona = useCallback(
    (id: string | null): Persona | null =>
      id ? (personas.find((item) => item.id === id) ?? null) : null,
    [personas],
  );

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
      setLoadError(null);
    } catch (error) {
      // Keep the last good list. An error is not evidence that the library is empty.
      setLoadError((error as Error).message || 'Could not list chats.');
    }
  }, [characterId]);

  // Open the most recent chat for a character, or start one seeded with the greeting.
  //
  // Keyed on the character identity plus whether its card has arrived — deliberately not on
  // the card object itself. A character autosave replaces that object every keystroke, and
  // depending on it would re-list chats and reopen the most recent one on top of whatever
  // the user has open. `cardLoaded` only flips on a real selection change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initAttempt is an explicit retry trigger
  useEffect(() => {
    if (!characterId || !cardLoaded) {
      dispatch({ type: 'chat/closed' });
      setChats([]);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    // Background initialisation yields to anything the user has done with the chat list
    // since this pass began: opening, creating, branching or deleting is an explicit choice
    // that must not be undone by the most-recent-chat auto-open settling late.
    const passAction = userChatAction.current;

    const run = async () => {
      try {
        const targetChatId = pendingChatRef.current;
        if (targetChatId) {
          const [summaries, chat] = await Promise.all([
            chatApi.list(characterId),
            chatApi.get(targetChatId),
          ]);
          if (cancelled) return;
          if (pendingChatRef.current === targetChatId) pendingChatRef.current = null;
          setChats(summaries);
          setLoadError(null);
          loadChat(chat);
          return;
        }

        const resolved = await resolveInitialChat(
          chatApi,
          characterId,
          { persona: personaIdRef.current },
          () => !cancelled && userChatAction.current === passAction,
        );
        if (cancelled) return;
        setChats(resolved.summaries);
        setLoadError(null);

        if (!resolved.chat || userChatAction.current !== passAction) return;
        loadChat(resolved.chat);
        if (resolved.created) {
          const card = characterRef.current;
          if (card) dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card });
        }
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message || 'Could not initialize chats.');
      }
    };

    // A repeat pass for the same character (StrictMode's mount/unmount/mount, or the card
    // arriving while a create is still in flight) chains onto the in-flight pass instead of
    // issuing a second list/create. Only the live pass applies its result — the cleanup flag
    // below gates that — but the server mutation cannot be cancelled.
    void initQueue.run(characterId, run).catch((error) => {
      if (!cancelled) setLoadError((error as Error).message || 'Could not initialize chats.');
    });

    return () => {
      cancelled = true;
    };
  }, [characterId, cardLoaded, initAttempt, initQueue, loadChat]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    if (stateRef.current.chatId) void refreshChats();
    else setInitAttempt((attempt) => attempt + 1);
  }, [refreshChats]);

  // --- Persistence -----------------------------------------------------------

  useEffect(() => {
    if (!state.chatId) return;
    persistence.adopt(
      state.chatId,
      state.persistedRevision,
      state.revision === state.persistedRevision
        ? {
            title: state.title,
            metadata: state.metadata,
            states: toPersistedMessageStates(state),
          }
        : undefined,
    );
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

  // --- Transcript edits ------------------------------------------------------

  const editMessage = useCallback((id: string, text: string) => {
    dispatch({ type: 'message/edited', id, text });
  }, []);

  const editReasoning = useCallback((id: string, reasoning: string) => {
    dispatch({ type: 'message/reasoningEdited', id, reasoning });
  }, []);

  const deleteMessage = useCallback((id: string) => {
    dispatch({ type: 'message/deleted', id });
  }, []);

  const toggleHidden = useCallback((id: string) => {
    dispatch({ type: 'message/toggleHidden', id });
  }, []);

  const setHidden = useCallback((ids: string[], hidden: boolean) => {
    dispatch({ type: 'message/setHidden', ids, hidden });
  }, []);

  // --- Display macros --------------------------------------------------------

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

  /**
   * The macro hooks the transcript's regex pass uses. Built here rather than in the view
   * because this is where the character, preset and chat variables already are — and
   * memoised on the same inputs as `renderGreeting`, since a new identity per render would
   * re-run the whole visible window's regex pass for nothing.
   */
  const regexMacros = useMemo<RegexMacros | null>(
    () =>
      character && preset
        ? createDisplayRegexMacros({
            character,
            preset,
            persona,
            messages: toChatMessages(state),
            metadata: state.metadata,
            globalVariables,
            seed: state.chatId ?? '',
          })
        : null,
    [character, preset, persona, state, globalVariables],
  );

  return {
    state,
    dispatch,
    stateRef,
    messages,
    persona,
    setPersona,
    resolvePersona,
    updateMetadata,
    chats,
    setChats,
    refreshChats,
    loadError,
    retryLoad,
    loadChat,
    personaIdRef,
    userChatAction,
    pendingChatRef,
    saving,
    saveError,
    flushSaves,
    retrySave,
    captureSnapshot,
    persistence,
    editMessage,
    editReasoning,
    deleteMessage,
    toggleHidden,
    setHidden,
    renderGreeting,
    regexMacros,
  };
}
