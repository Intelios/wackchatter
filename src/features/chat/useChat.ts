/**
 * Chat orchestration: assembly, streaming, and persistence.
 *
 * The ordering inside a generation is load-bearing and documented at `generate` below.
 * Everything that mutates the transcript goes through the reducer; the streaming text
 * goes through the store and never touches React state.
 */

import { currentText, type MessageState } from '@shared/chat/message.ts';
import {
  buildExtractionMessages,
  memoryBacklog,
  memoryMessages,
  parseMemoryResponse,
} from '@shared/memory/extract.ts';
import {
  autoExtractDue,
  coveredMessageIds,
  draftsToMemories,
  hideableMessageIds,
} from '@shared/memory/memories.ts';
import type { MemoryRecall } from '@shared/memory/source.ts';
import { assemblePrompt, DEFAULT_USER_NAME, sanitizeName } from '@shared/prompt/assemble.ts';
import { createDisplayRegexMacros, resolveGreetingMacros } from '@shared/prompt/greeting.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { RegexMacros } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  ApiMessage,
  Chat,
  ChatMessage,
  ChatMetadata,
  ChatSaveSnapshot,
  ChatSummary,
  MacroVariableMap,
  Memory,
  Persona,
} from '@shared/types/chat.ts';
import {
  CHARACTER_NAMES_BEHAVIOR,
  type GenerationType,
  type Preset,
} from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type {
  GuidanceSettings,
  MemoryMode,
  MemorySettings,
  SummarySettings,
} from '@shared/types/settings.ts';
import { DEFAULT_MEMORY } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { chatApi, streamGenerate } from '../../lib/api.ts';
import { memoryRecallForChat, worldInfoForChat } from '../lore/worldInfoForChat.ts';
import {
  packClassicSummaryChunk,
  resolveSummaryPrompt,
  summaryBacklog,
  summaryBaseControl,
  summaryMessages,
  yieldToMain,
} from '../summary/summary.ts';
import { adoptedPersona, KeyedSerialQueue, resolveInitialChat } from './chatInit.ts';
import { ChatSaveQueue } from './chatPersistence.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  type GenMode,
  initialChatState,
  type PromptInspection,
  toChatMessages,
  toPersistedChatMessages,
} from './state/chatReducer.ts';
import { createStreamStore, type StreamStore } from './state/streamStore.ts';

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
  /** The preset's id, recorded onto each generation. The Preset itself does not carry one. */
  presetId: string | null;
  /** Every persona. Which one applies is resolved in here — see `persona` below. */
  personas: Persona[];
  /** The app-wide current persona. New chats start with it; loading a chat adopts its own. */
  personaId: string | null;
  /**
   * A loaded chat's recorded persona becomes the current one. Called when that happens,
   * so the settings snapshot can follow the chat instead of the other way around.
   */
  onPersonaSwitch?: (personaId: string | null) => void;
  /** The selected saved connection, including its stable id for generation routing. */
  connection: Connection | null;
  countTokens: TokenCounter;
  streamingFps: number;
  /** Lorebooks that apply to this chat, already loaded. */
  worldInfoSources?: WorldInfoSource[];
  /** Resolve sources after this hook has selected the chat-scoped persona. */
  resolveWorldInfoSources?: (personaLorebookId?: string) => WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  /** Template, depth and role for guided generations and persistent guides. */
  guidanceSettings?: GuidanceSettings;
  /** Resolved summary connection and its model-specific counter. */
  summaryConnection?: Connection | null;
  summarySettings?: SummarySettings;
  summaryCountTokens?: TokenCounter;
  /** Which story-memory feature reaches the model on every generation. */
  memoryMode?: MemoryMode;
  memorySettings?: MemorySettings;
  /** Resolved memory connection and preset. See `MemorySettings` for why a preset. */
  memoryConnection?: Connection | null;
  memoryPreset?: Preset | null;
  globalVariables: MacroVariableMap;
  /** Persist global macro effects and refresh the app settings snapshot. */
  onGlobalVariablesChange: (variables: MacroVariableMap) => Promise<void>;
  /**
   * User regex scripts. Passed to every assembly this hook performs, including the
   * summary one — a summary built from text that was never sent is worse than none.
   */
  regexScripts?: readonly RegexScript[];
}

export interface UseChat {
  state: ChatState;
  /** The transcript in wire form. Feeds both the UI and assemblePrompt. */
  messages: ChatMessage[];
  stream: StreamStore;
  inspection: PromptInspection | null;
  /** A transcript reply is being generated. Structural chat actions remain blocked. */
  busy: boolean;
  /** Any provider generation is active, including a blocking summary request. */
  generationBlocked: boolean;
  saving: boolean;
  /** A persistence failure blocks chat-changing navigation until it is retried. */
  saveError: string | null;
  /** A chat list/get/create failure. It never means that the character has no chats. */
  loadError: string | null;

  send(text: string): Promise<void>;
  regenerate(): Promise<void>;
  /** -1 shows a cached swipe; +1 past the end generates a new one. */
  swipe(direction: -1 | 1): Promise<void>;
  /**
   * Jump straight to a cached swipe by index — the scenario list's pick. Same
   * cached-alternative branch as `swipe` with the destination chosen for it; never
   * generates, and never moves the selection off the greeting it names.
   */
  swipeTo(id: string, index: number): void;
  continueLast(): Promise<void>;
  /**
   * Reply, steered by `guidance`, without writing it into the transcript.
   *
   * Not `send` with extra text: the point is a reply shaped by an instruction nobody has
   * to read back later.
   */
  guidedRespond(guidance: string): Promise<void>;
  /** A new alternate on the last reply, steered the same way. Never a cached swipe. */
  guidedSwipe(guidance: string): Promise<void>;
  abort(): void;

  summaryStatus: SummaryRunStatus;
  summaryPending: number;
  summarize(settingsOverride?: SummarySettings): Promise<void>;
  cancelSummary(): void;
  editSummary(text: string): void;

  memoryStatus: SummaryRunStatus;
  /** Transcript turns no memory covers yet. */
  memoryPending: number;
  /**
   * Write memories for everything past the watermark.
   *
   * Takes only the fields a panel can hold unsaved; every other setting, and in
   * particular `autoHide`, is read live so it cannot be overridden by a stale render.
   */
  extractMemories(draft?: Partial<UnsavedMemoryDraft>): Promise<void>;
  cancelMemoryRun(): void;
  /** Replace the whole list. Edits, reorders and pins all land through here. */
  setMemories(memories: Memory[]): void;
  /** Remove one memory and give back whatever it was hiding. */
  deleteMemory(id: string): void;
  /** Hide or reveal exactly the messages one memory covers, honouring the verbatim tail. */
  setMemoryHidden(id: string, hidden: boolean): void;
  /** How many of a memory's messages are currently hidden by it. */
  memoryHiddenCount(id: string): number;
  /** What memory recall did on the last generation, for the inspector. */
  memoryRecall: MemoryRecall | null;

  editMessage(id: string, text: string): void;
  /** Rewrite or clear the thinking block of the selected swipe, leaving the reply alone. */
  editReasoning(id: string, reasoning: string): void;
  deleteMessage(id: string): void;
  toggleHidden(id: string): void;
  /** Set a whole range to hidden/unhidden in one revision. Idempotent. */
  setHidden(ids: string[], hidden: boolean): void;

  chats: ChatSummary[];
  /** Re-fetch the chat list — structural changes such as restore or import call this. */
  refreshChats(): Promise<void>;
  openChat(chatId: string): Promise<void>;
  /** Re-fetch the open chat from the server, after flushing local edits. */
  reloadChat(): Promise<void>;
  /** Bumped after each successful reload, so the view can reset its transcript window. */
  reloadCount: number;
  /** Set before selecting a character to open a specific chat instead of the most recent. */
  pendingChatRef: RefObject<string | null>;
  newChat(): Promise<void>;
  renameChat(title: string): void;
  deleteChat(chatId: string): Promise<void>;
  branchFrom(messageId: string): Promise<void>;
  /** Persist the open transcript before another owner replaces or deletes it. */
  flushSaves(): Promise<void>;
  retrySave(): Promise<void>;
  retryLoad(): void;

  /** The persona this chat actually uses. Resolved here, not passed in. */
  persona: Persona | null;
  setPersona(personaId: string | null): void;
  /** Resolve a persona by id, for messages that recorded who spoke them. */
  resolvePersona(personaId: string | null): Persona | null;
  updateMetadata(patch: Partial<ChatMetadata>): void;
  /** Resolve a stored greeting for display without committing variable macro effects. */
  renderGreeting(text: string): string;
  /** Macro hooks for the transcript regex pass. Null until a character and preset load. */
  regexMacros: RegexMacros | null;
  /** What World Info did on the last generation, for the inspector. */
  worldInfo: ActivationResult | null;
}

/**
 * The parts of `MemorySettings` a panel may still be holding uncommitted.
 *
 * Deliberately just the free-text prompt: it commits on blur, so pressing Extract
 * straight after typing should use what is on screen. Nothing that changes what the run
 * does to the transcript belongs here.
 */
export interface UnsavedMemoryDraft {
  extractPrompt: string;
}

export interface SummaryRunStatus {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
}

export function useChat(options: UseChatOptions): UseChat {
  const {
    characterId,
    character,
    preset,
    presetId,
    personas,
    personaId,
    onPersonaSwitch,
    connection,
    countTokens,
    streamingFps,
    worldInfoSources,
    resolveWorldInfoSources,
    worldInfoSettings,
    guidanceSettings,
    summaryConnection,
    summarySettings,
    summaryCountTokens,
    memoryMode = 'classic',
    memorySettings,
    memoryConnection,
    memoryPreset,
    globalVariables,
    regexScripts,
    onGlobalVariablesChange,
  } = options;

  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [worldInfo, setWorldInfo] = useState<ActivationResult | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [summaryStatus, setSummaryStatus] = useState<SummaryRunStatus>({
    running: false,
    processed: 0,
    total: 0,
    error: null,
  });

  const [memoryStatus, setMemoryStatus] = useState<SummaryRunStatus>({
    running: false,
    processed: 0,
    total: 0,
    error: null,
  });
  const [memoryRecall, setMemoryRecall] = useState<MemoryRecall | null>(null);

  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);
  const abortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryChatIdRef = useRef<string | null>(null);
  const memoryAbortRef = useRef<AbortController | null>(null);
  const memoryChatIdRef = useRef<string | null>(null);
  // The chat whose reply just settled, arming the auto-extraction check. Set at gen/finished
  // and consumed by the effect below — a ref rather than a direct call because extractMemories
  // reads stateRef, which only catches up with the dispatch at the next render.
  const autoExtractArmRef = useRef<string | null>(null);

  // The generation body reads state after dispatching into it, so the closure's copy is
  // always stale. A ref is the simplest correct answer.
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
  const onPersonaSwitchRef = useRef(onPersonaSwitch);
  onPersonaSwitchRef.current = onPersonaSwitch;

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

  // Bumped synchronously by every user chat-management action. The init effect captures the
  // value when a pass starts and stands down if it moves. A state read would be racy: a
  // dispatch only becomes visible at render, so the user's open can be queued but not yet
  // reflected in `stateRef` when the init settles. The counter moves before any await.
  const userChatAction = useRef(0);

  const pendingChatRef = useRef<string | null>(null);

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
    // Loading a chat adopts its recorded persona as the app-wide current one — the
    // chat wins, and the settings snapshot follows it. A legacy chat without a key is
    // stamped with the current persona instead, which changes nothing to adopt.
    const adopted = adoptedPersona(chat, personaIdRef.current, personasRef.current);
    if (adopted.changed) onPersonaSwitchRef.current?.(adopted.effective);
    dispatch({ type: 'chat/loaded', chat, personaId: adopted.effective });
  }, []);

  // --- Persona ---------------------------------------------------------------

  /**
   * The chat wins over the app-wide current persona.
   *
   * `AppSettings.personaId` is the persona you are using right now; `ChatMetadata.persona`
   * is the one this chat is using. A chat is a transcript in which "you" said things, so
   * loading it adopts its recorded persona — the settings follow the chat, never the other
   * way around.
   *
   * Resolved here rather than in App: computing it up there from `chat.state.metadata` and
   * feeding it back in as a prop would be a cycle.
   */
  const persona = useMemo(() => {
    const stored = state.metadata.persona;
    if (stored === null) return null;
    if (typeof stored === 'string') return personas.find((item) => item.id === stored) ?? null;
    // A loaded chat is migrated before it reaches this point. No-chat state has no
    // persona, rather than borrowing the app-wide current one.
    return null;
  }, [state.metadata.persona, personas]);

  const setPersona = useCallback((personaId: string | null) => {
    dispatch({ type: 'chat/metadata', patch: { persona: personaId } });
  }, []);

  /**
   * Resolve any persona id — not just the chat's own. Each user message records the
   * persona it was sent as, and the transcript needs that one, not whoever is speaking
   * now. A deleted persona resolves as none, the same orphan rule the panel applies.
   */
  const resolvePersona = useCallback(
    (id: string | null): Persona | null =>
      id ? (personas.find((item) => item.id === id) ?? null) : null,
    [personas],
  );

  const updateMetadata = useCallback((patch: Partial<ChatMetadata>) => {
    dispatch({ type: 'chat/metadata', patch });
  }, []);

  const summaryPending = useMemo(
    () => summaryBacklog(summaryMessages(messages), state.metadata.summary).length,
    [messages, state.metadata.summary],
  );

  const editSummary = useCallback((text: string) => {
    const current = stateRef.current;
    if (!current.chatId) return;
    const existing = current.metadata.summary;
    const trimmed = text.trim();
    const checkpointMessageId = trimmed
      ? (existing?.checkpointMessageId ?? summaryMessages(toChatMessages(current)).at(-1)?.id)
      : undefined;
    dispatch({
      type: 'chat/metadata',
      patch: {
        summary: {
          text,
          ...(checkpointMessageId ? { checkpointMessageId } : {}),
        },
      },
    });
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
    // since this pass began: opening, creating, branching or deleting is an explicit
    // choice that must not be undone by the most-recent-chat auto-open settling late.
    const passAction = userChatAction.current;

    const run = async () => {
      try {
        const targetChatId = pendingChatRef.current;
        if (targetChatId) {
          pendingChatRef.current = null;
          const [summaries, chat] = await Promise.all([
            chatApi.list(characterId),
            chatApi.get(targetChatId),
          ]);
          if (cancelled) return;
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
    // issuing a second list/create. Only the live pass applies its result — the cleanup
    // flag below gates that — but the server mutation cannot be cancelled.
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
   * Everything after `gen/started` runs inside one try/finally, and the abort controller
   * is armed before any of it. Both are for the same reason: from the moment the reducer
   * says "busy" the UI shows Stop, and a throw on the way to the provider — assembly, a
   * tokenizer, a failed settings write — must not leave the chat busy forever with a
   * Stop button wired to a controller that does not exist yet. SillyTavern arms its
   * controller at the top of Generate() for the same reason (script.js:4243).
   *
   * @param base The state to build on, when the caller has already folded an action
   *   into it (as `send` does with the user's message).
   */
  const generate = useCallback(
    async (mode: GenMode, base?: ChatState, guidance?: string) => {
      const current = base ?? stateRef.current;
      if (current.status !== 'idle' || summaryAbortRef.current || memoryAbortRef.current) return;
      if (!character || !preset || !connection) return;

      // Settings can change while the prompt is being assembled or global variables are
      // persisted. Keep the request body, reply metadata, and server-side connection lookup
      // on the same connection snapshot for the entire generation.
      const requestConnection: Connection = { ...connection };

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

      const controller = new AbortController();
      abortRef.current = controller;

      // A navigation can leave this request alive while the hook is already rendering a
      // different chat. The controller ref is also the generation's ownership token: a
      // newer generation replaces it, so late callbacks from this one must become inert.
      const ownsGeneration = () =>
        abortRef.current === controller && stateRef.current.chatId === started.chatId;
      const ensureGenerationActive = () => {
        if (!ownsGeneration()) return false;
        if (controller.signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return true;
      };
      let streamStarted = false;
      const endStream = () => {
        if (!streamStarted) return;
        stream.end();
        streamStarted = false;
      };

      // Empty until the stream starts, so a failure on the way to the provider settles as
      // "nothing came back" and the reducer removes the placeholder it added.
      let text = '';
      let reasoning = '';

      try {
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

        // Recall runs over the same post-fold transcript, so a memory keyed on a word in
        // the message just typed fires for the reply it triggered rather than the next one.
        const recall =
          memoryMode === 'memories'
            ? memoryRecallForChat({
                memories: started.metadata.memories,
                messages: chatMessages,
                settings: worldInfoSettings ?? DEFAULT_WI_SETTINGS,
                budget: memoryConfigRef.current.budgetTokens,
                preset,
                chatId: started.chatId,
                countTokens,
              })
            : null;
        setMemoryRecall(recall);

        const assembled = assemblePrompt({
          preset,
          character,
          persona,
          messages: chatMessages,
          generationType,
          worldInfoBefore: lore?.before,
          worldInfoAfter: lore?.after,
          worldInfoDepth: lore?.depth,
          memoryMode,
          memoryText: recall?.text,
          memorySettings: memoryConfigRef.current,
          scenarioOverride:
            typeof started.metadata.scenario === 'string' ? started.metadata.scenario : undefined,
          authorNote: started.metadata.authorNote,
          summary: started.metadata.summary,
          summarySettings,
          guides: started.metadata.guides,
          // One-shot: it exists only as an argument on this call, so unlike an ephemeral
          // injection parked in metadata there is nothing that could leak into the next
          // generation, or survive a failure that skipped its own cleanup.
          guidance,
          guidanceSettings,
          localVariables: started.metadata.variables ?? {},
          globalVariables,
          countTokens,
          seed: started.chatId ?? '',
          regexScripts,
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

        // Extra completions become extra swipes, so they only make sense for the modes
        // that own a swipe array. `continue` writes back into one existing swipe — it has
        // nowhere to put a second take of the same half-finished sentence.
        const completions = mode === 'continue' ? 1 : Math.max(1, Math.trunc(preset.n ?? 1));

        const streamed = preset.stream_openai !== false;

        const body = buildRequestBody({
          messages: assembled.messages,
          preset,
          connection: requestConnection,
          stream: streamed,
          completions,
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
          await onGlobalVariablesChange(assembled.variableUpdates.global);
        }

        // The global-variable write above can yield to navigation. Do not start a stream
        // after its owner has moved on or its Stop/transition abort has already fired.
        if (!ensureGenerationActive()) return;

        stream.begin(seed, streamed);
        streamStarted = true;
        text = seed;

        const final = await streamGenerate(
          body,
          controller.signal,
          {
            onFirstToken: () => {
              if (ownsGeneration() && !controller.signal.aborted) {
                dispatch({ type: 'gen/streaming' });
              }
            },
            onTick: (streamState) => {
              if (!ownsGeneration() || controller.signal.aborted) return;
              text = streamState.content;
              reasoning = streamState.reasoning;
              stream.set(streamState.content, streamState.reasoning);
            },
          },
          seed,
          requestConnection.id,
        );

        // A non-streaming response can resolve in the same turn as an abort, so check
        // ownership after the await as well as in the streaming callbacks.
        if (!ensureGenerationActive()) return;
        endStream();

        // Blank ones are dropped: a provider may honour `n` with fewer completions than
        // asked for, and an empty swipe is just something to skip past. Only trusted when
        // this request actually asked for alternates.
        const alternates =
          completions > 1
            ? (final.alternates ?? [])
                .filter((choice) => choice.content.trim())
                .map((choice) => ({
                  text: choice.content,
                  extra: {
                    api: requestConnection.provider,
                    model: final.model ?? requestConnection.model,
                    connection_id: requestConnection.id,
                    ...(presetId ? { preset_id: presetId } : {}),
                    ...(choice.reasoning ? { reasoning: choice.reasoning } : {}),
                    token_count: countTokens.countText(choice.content),
                  },
                }))
            : [];

        dispatch({
          type: 'gen/finished',
          text: final.content,
          extra: {
            api: requestConnection.provider,
            model: final.model ?? requestConnection.model,
            connection_id: requestConnection.id,
            ...(presetId ? { preset_id: presetId } : {}),
            // Only ever the provider's own number. An estimate here would be missing
            // whatever world info and injections the request actually carried, and a
            // wrong prompt count is worse than none.
            ...(typeof final.usage?.prompt_tokens === 'number'
              ? { prompt_tokens: final.usage.prompt_tokens }
              : {}),
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            // A real count from the provider beats our estimate when we get one — but
            // reported usage covers every completion in the request, so once there are
            // alternates it is no longer this swipe's count and the estimate is closer.
            token_count: alternates.length
              ? countTokens.countText(final.content)
              : (final.usage?.completion_tokens ?? countTokens.countText(final.content)),
          },
          alternates,
        });
        // Arm, don't fire: the dispatch has not reached stateRef yet, so an extraction
        // started here would still see this generation as streaming and bail. The effect
        // below consumes the arm on the settle render.
        autoExtractArmRef.current = started.chatId;
      } catch (error) {
        if (ownsGeneration()) endStream();
        // Whatever arrived before the failure is kept, as SillyTavern does.
        if (ownsGeneration() && controller.signal.aborted)
          dispatch({ type: 'gen/aborted', text, reasoning });
        else if (ownsGeneration())
          dispatch({
            type: 'gen/failed',
            message: (error as Error).message,
            text,
            reasoning,
          });
      } finally {
        // An old request may settle after a newer generation has replaced the ref. It must
        // not clear that controller, stop its stream, or refresh the newer chat's list.
        if (abortRef.current === controller) {
          endStream();
          abortRef.current = null;
          if (stateRef.current.chatId === started.chatId) void refreshChats();
        }
      }
    },
    [
      character,
      preset,
      presetId,
      persona,
      connection,
      countTokens,
      stream,
      refreshChats,
      worldInfoSources,
      resolveWorldInfoSources,
      worldInfoSettings,
      guidanceSettings,
      summarySettings,
      memoryMode,
      globalVariables,
      regexScripts,
      onGlobalVariablesChange,
    ],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (
        !trimmed ||
        stateRef.current.status !== 'idle' ||
        summaryAbortRef.current ||
        memoryAbortRef.current
      ) {
        return;
      }

      const userAction: ChatAction = {
        // The name becomes message.name, which names_behavior can put into the prompt
        // text — so it has to be the same name {{user}} expands to, not a friendlier
        // label. See DEFAULT_USER_NAME. The persona id is recorded the same way: the
        // message keeps the face it was spoken with.
        type: 'message/appendUser',
        id: crypto.randomUUID(),
        name: persona?.name ?? DEFAULT_USER_NAME,
        personaId: persona?.id ?? null,
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

  /*
   * The scenario list's pick: a jump rather than a step, and only ever into swipes that
   * already exist — generating is the chevrons' job, not the popover's.
   *
   * Same-index is refused here rather than left to the reducer, which bumps the revision
   * unconditionally: a no-op pick would schedule a save for a chat that did not change.
   */
  const swipeTo = useCallback((id: string, index: number) => {
    const current = stateRef.current;
    if (current.status !== 'idle') return;

    const target = current.messages.find((m) => m.id === id);
    if (!target || index < 0 || index >= target.swipes.length || index === target.swipe_id) {
      return;
    }

    dispatch({ type: 'swipe/select', id, index });
  }, []);

  /*
   * The two guided entry points.
   *
   * `guidedRespond` runs mode `send` without appending a user message, which is what makes
   * the steering invisible: `gen/started` adds only the assistant placeholder, so the reply
   * answers the transcript as it stands. `guidedSwipe` goes straight to `generate` rather
   * than through `swipe`, which would show a cached alternate instead of making a new one.
   *
   * Neither needs a reducer change. A failure settles through the same undo table as any
   * other generation — mode `send` drops the placeholder, mode `swipe` drops the blank
   * alternate — so a guided attempt that goes nowhere leaves nothing behind.
   */
  const guidedRespond = useCallback(
    async (guidance: string) => {
      if (!guidance.trim() || stateRef.current.status !== 'idle') return;
      await generate('send', undefined, guidance);
    },
    [generate],
  );

  const guidedSwipe = useCallback(
    async (guidance: string) => {
      if (!guidance.trim() || stateRef.current.status !== 'idle') return;
      await generate('swipe', undefined, guidance);
    },
    [generate],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    // Stop the shared display immediately. A pending throttled frame must not remain visible
    // while the next chat is being loaded; a later generation's begin() will own the store
    // again before it publishes new content.
    stream.end();
  }, [stream]);

  const cancelSummary = useCallback(() => {
    summaryAbortRef.current?.abort();
  }, []);

  const cancelMemoryRun = useCallback(() => {
    memoryAbortRef.current?.abort();
  }, []);

  const summarize = useCallback(
    async (settingsOverride?: SummarySettings) => {
      if (summaryAbortRef.current || memoryAbortRef.current) return;
      const current = stateRef.current;
      if (
        !current.chatId ||
        current.status !== 'idle' ||
        !character ||
        !preset ||
        !summaryConnection ||
        !summarySettings ||
        !summaryCountTokens
      ) {
        return;
      }
      if (!summaryConnection.baseUrl || !summaryConnection.model) {
        setSummaryStatus({
          running: false,
          processed: 0,
          total: 0,
          error: 'The selected summary connection needs an endpoint and model.',
        });
        return;
      }

      const rawMessages = toChatMessages(current);
      if (rawMessages[0] && !rawMessages[0].is_user) {
        rawMessages[0] = {
          ...rawMessages[0],
          mes: resolveGreetingMacros(rawMessages[0].mes, {
            character,
            preset,
            persona,
            messages: rawMessages,
            metadata: current.metadata,
            globalVariables,
            seed: current.chatId,
          }),
        };
      }

      const backlog = summaryBacklog(summaryMessages(rawMessages), current.metadata.summary);
      if (!backlog.length) {
        setSummaryStatus({
          running: false,
          processed: 0,
          total: 0,
          error: 'No new chat messages need summarizing.',
        });
        return;
      }

      const effectiveSummarySettings = settingsOverride ?? summarySettings;
      const systemPrompt = resolveSummaryPrompt(
        effectiveSummarySettings.prompt,
        effectiveSummarySettings.targetWords,
      );
      if (!systemPrompt.trim()) {
        setSummaryStatus({
          running: false,
          processed: 0,
          total: backlog.length,
          error: 'The summary prompt is empty.',
        });
        return;
      }

      const controller = new AbortController();
      summaryAbortRef.current = controller;
      summaryChatIdRef.current = current.chatId;
      let processed = 0;
      let remaining = backlog;
      let rollingSummary = current.metadata.summary?.text ?? '';
      let runLocalVariables = { ...(current.metadata.variables ?? {}) };
      let runGlobalVariables = { ...globalVariables };
      const maxTokens = Math.ceil(effectiveSummarySettings.targetWords * 2);
      const capturedSources =
        resolveWorldInfoSources?.(persona?.lorebookId ?? undefined) ?? worldInfoSources ?? [];

      const assembleClassic = (candidate: ChatMessage[], baseSummary: string) => {
        const lore = worldInfoForChat({
          sources: capturedSources,
          messages: candidate,
          settings: worldInfoSettings ?? DEFAULT_WI_SETTINGS,
          preset,
          chatId: current.chatId!,
          countTokens: summaryCountTokens,
        });
        const baseControl = summaryBaseControl(baseSummary);
        return assemblePrompt({
          preset,
          character,
          persona,
          messages: candidate,
          worldInfoBefore: lore?.before,
          worldInfoAfter: lore?.after,
          worldInfoDepth: lore?.depth,
          scenarioOverride:
            typeof current.metadata.scenario === 'string' ? current.metadata.scenario : undefined,
          authorNote: current.metadata.authorNote,
          guides: current.metadata.guides,
          guidanceSettings,
          localVariables: runLocalVariables,
          globalVariables: runGlobalVariables,
          countTokens: summaryCountTokens,
          finalControls: [
            ...(baseControl
              ? [{ identifier: 'summaryBase', role: 'system' as const, content: baseControl }]
              : []),
            { identifier: 'summaryRequest', role: 'system', content: systemPrompt },
          ],
          reservedCompletionTokens: maxTokens,
          requireChatHistory: true,
          seed: `${current.chatId}:summary:${candidate.at(-1)?.id ?? 'fixed'}`,
          // The summary has to describe the transcript the model was actually shown.
          regexScripts,
        });
      };

      setSummaryStatus({ running: true, processed: 0, total: backlog.length, error: null });
      // Let the progress UI paint before the synchronous pack work begins.
      await yieldToMain();

      try {
        const maxPromptTokens = (preset.openai_max_context ?? 4095) - maxTokens;
        const namesBehavior = preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT;
        // Mirror assembly's per-message pricing exactly: role from `is_user`, the
        // names_behavior content prefix or sanitized name, and the marginal chat cost
        // (whole-chat count minus the reply priming). Raw trimmed text, no macro or
        // regex expansion — the verify/shrink step absorbs any optimistic estimate.
        const messageCost = (message: ChatMessage): number => {
          const apiMessage: ApiMessage = {
            role: message.is_user ? 'user' : 'assistant',
            content:
              namesBehavior === CHARACTER_NAMES_BEHAVIOR.CONTENT
                ? `${message.name}: ${message.mes}`
                : message.mes,
          };
          if (namesBehavior === CHARACTER_NAMES_BEHAVIOR.COMPLETION) {
            apiMessage.name = sanitizeName(message.name);
          }
          return summaryCountTokens.countChat([apiMessage]) - summaryCountTokens.countChat([]);
        };

        while (remaining.length > 0) {
          const fixed = assembleClassic([], '');
          if (!fixed.ok) {
            throw new Error(
              `The fixed Classic prompt and summary instruction need ${fixed.error.requiredPromptTokens} tokens, but only ${fixed.error.maxContext - fixed.error.reservedCompletionTokens} are available. Increase the preset context limit or shorten enabled prompt content.`,
            );
          }
          let fixedTokens = fixed.totalTokens;
          if (rollingSummary.trim()) {
            const withBase = assembleClassic([], rollingSummary);
            if (!withBase.ok) {
              throw new Error(
                `The existing rolling summary does not fit alongside the Classic prompt. Increase the preset context limit, reduce the target length, or shorten the current summary.`,
              );
            }
            fixedTokens = withBase.totalTokens;
          }

          const chunk = await packClassicSummaryChunk({
            messages: remaining,
            maxPromptTokens,
            fixedTokens,
            messageCost,
            assemble: (candidate) => assembleClassic(candidate, rollingSummary),
          });
          if (!chunk) {
            throw new Error(
              'The next individual chat turn cannot fit alongside the Classic prompt and rolling summary. Increase the preset context limit, reduce the target length, shorten the current summary, or shorten that turn.',
            );
          }

          const assembled = chunk.assembled;
          if (assembled.variableUpdates.localChanged) {
            runLocalVariables = assembled.variableUpdates.local;
            const action: ChatAction = {
              type: 'chat/metadata',
              patch: { variables: runLocalVariables },
            };
            const nextState = chatReducer(stateRef.current, action);
            stateRef.current = nextState;
            dispatch(action);
          }
          if (assembled.variableUpdates.globalChanged) {
            runGlobalVariables = assembled.variableUpdates.global;
            await onGlobalVariablesChange(runGlobalVariables);
          }
          if (controller.signal.aborted || stateRef.current.chatId !== current.chatId) return;

          const body = buildRequestBody({
            messages: assembled.messages,
            preset,
            connection: summaryConnection,
            stream: false,
            maxTokens,
          });
          const result = await streamGenerate(
            body,
            controller.signal,
            { onTick: () => {} },
            '',
            summaryConnection.id,
          );
          const nextSummary = result.content.trim();
          if (!nextSummary) throw new Error('The summary connection returned an empty response.');
          if (controller.signal.aborted || stateRef.current.chatId !== current.chatId) return;

          const checkpointMessageId = chunk.messages.at(-1)!.id;
          rollingSummary = nextSummary;
          processed += chunk.messages.length;
          remaining = remaining.slice(chunk.messages.length);
          const action: ChatAction = {
            type: 'chat/metadata',
            patch: { summary: { text: nextSummary, checkpointMessageId } },
          };
          // A completed chunk is a durable checkpoint before another paid request begins.
          // Fold from the freshest state so chat activity that happened during the request
          // is included in the same snapshot rather than overwritten by the captured input.
          const nextState = chatReducer(stateRef.current, action);
          stateRef.current = nextState;
          dispatch(action);
          const snapshot = captureSnapshot(nextState);
          if (snapshot) {
            persistence.schedule(snapshot);
            await persistence.flush(snapshot.chatId);
          }
          setSummaryStatus({
            running: remaining.length > 0,
            processed,
            total: backlog.length,
            error: null,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSummaryStatus({
            running: false,
            processed,
            total: backlog.length,
            error: (error as Error).message,
          });
        }
      } finally {
        if (summaryAbortRef.current === controller) summaryAbortRef.current = null;
        if (summaryChatIdRef.current === current.chatId) summaryChatIdRef.current = null;
        if (controller.signal.aborted) {
          setSummaryStatus({ running: false, processed, total: backlog.length, error: null });
        }
        void refreshChats();
      }
    },
    [
      character,
      preset,
      persona,
      summaryConnection,
      summarySettings,
      summaryCountTokens,
      globalVariables,
      regexScripts,
      worldInfoSources,
      resolveWorldInfoSources,
      worldInfoSettings,
      guidanceSettings,
      onGlobalVariablesChange,
      captureSnapshot,
      persistence,
      refreshChats,
    ],
  );

  useEffect(() => {
    // `chat/loaded` can arrive from a queued open or the character initialiser after the
    // caller has already moved on. Keep this as a second line of defence for transitions
    // that do not pass through one of the public chat-management callbacks.
    abortRef.current?.abort();
    if (summaryChatIdRef.current && summaryChatIdRef.current !== state.chatId) {
      summaryAbortRef.current?.abort();
    }
    if (memoryChatIdRef.current && memoryChatIdRef.current !== state.chatId) {
      memoryAbortRef.current?.abort();
    }
    setSummaryStatus({ running: false, processed: 0, total: 0, error: null });
    setMemoryStatus({ running: false, processed: 0, total: 0, error: null });
  }, [state.chatId]);

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

  // --- Chat management -------------------------------------------------------

  const openChat = useCallback(
    async (chatId: string) => {
      userChatAction.current += 1;
      abort();
      cancelSummary();
      cancelMemoryRun();
      try {
        await flushSaves();
      } catch {
        return;
      }
      const chat = await chatApi.get(chatId);
      loadChat(chat);
    },
    [abort, cancelMemoryRun, cancelSummary, flushSaves, loadChat],
  );

  // Guards against overlapping `/reload`s — each fetch is pointless once a newer one has
  // replaced the transcript it would have applied over.
  const reloadRef = useRef(false);

  const reloadChat = useCallback(async () => {
    const current = stateRef.current;
    if (!current.chatId || current.status !== 'idle' || reloadRef.current) return;
    reloadRef.current = true;
    try {
      // Flush first so the fetch reflects our edits and none are lost.
      await flushSaves();
      const revisionBefore = stateRef.current.revision;
      const chat = await chatApi.get(current.chatId);
      // Only apply if the transcript is still the one we started from. Anything the user
      // did while the request was in flight is newer than the fetched copy, so applying
      // it would silently discard that work — keep the local state instead.
      if (stateRef.current.chatId !== current.chatId) return;
      if (stateRef.current.revision !== revisionBefore) return;
      loadChat(chat);
      setReloadCount((count) => count + 1);
    } finally {
      reloadRef.current = false;
    }
  }, [flushSaves, loadChat]);

  const newChat = useCallback(async () => {
    if (!characterId || !character) return;
    userChatAction.current += 1;
    abort();
    cancelSummary();
    cancelMemoryRun();
    try {
      await flushSaves();
    } catch {
      return;
    }
    const chat = await chatApi.create({
      characterId,
      title: 'New chat',
      metadata: { persona: personaIdRef.current },
    });
    loadChat(chat);
    dispatch({ type: 'chat/greeting', id: crypto.randomUUID(), card: character });
    await refreshChats();
  }, [
    abort,
    cancelMemoryRun,
    cancelSummary,
    characterId,
    character,
    flushSaves,
    loadChat,
    refreshChats,
  ]);

  const renameChat = useCallback((title: string) => {
    dispatch({ type: 'chat/renamed', title });
    const chatId = stateRef.current.chatId;
    if (chatId) {
      // The list only re-fetches on structural changes, so reflect the rename at once.
      setChats((list) => list.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)));
    }
  }, []);

  const deleteChat = useCallback(
    async (chatId: string) => {
      userChatAction.current += 1;
      if (stateRef.current.chatId === chatId) abort();
      cancelSummary();
      cancelMemoryRun();
      try {
        await flushSaves();
      } catch {
        return;
      }
      await chatApi.remove(chatId);
      if (stateRef.current.chatId === chatId) dispatch({ type: 'chat/closed' });
      await refreshChats();
    },
    [abort, cancelMemoryRun, cancelSummary, flushSaves, refreshChats],
  );

  const branchFrom = useCallback(
    async (messageId: string) => {
      if (!stateRef.current.chatId) return;
      userChatAction.current += 1;
      abort();
      cancelSummary();
      cancelMemoryRun();
      try {
        await flushSaves();
      } catch {
        return;
      }
      const branch = await chatApi.branch(stateRef.current.chatId, messageId);
      loadChat(branch);
      await refreshChats();
    },
    [abort, cancelMemoryRun, cancelSummary, flushSaves, loadChat, refreshChats],
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

  // --- Memory ----------------------------------------------------------------

  /**
   * How many already-written memories are shown to the extractor as context.
   *
   * Enough to keep names and facts flowing forward, few enough that the extractor does not
   * start mining them instead of the transcript it was given.
   */
  const MEMORY_CHAIN_DEPTH = 4;

  const memoryConfig = useMemo<MemorySettings>(
    () => ({ ...DEFAULT_MEMORY, ...memorySettings }),
    [memorySettings],
  );
  const memoryConfigRef = useRef(memoryConfig);
  memoryConfigRef.current = memoryConfig;

  const memoryPending = useMemo(
    () => memoryBacklog(memoryMessages(messages), state.metadata.memoryWatermark).length,
    [messages, state.metadata.memoryWatermark],
  );

  const setMemories = useCallback((memories: Memory[]) => {
    dispatch({ type: 'chat/metadata', patch: { memories } });
  }, []);

  const setMemoryHidden = useCallback((id: string, hidden: boolean) => {
    const current = stateRef.current;
    const memory = current.metadata.memories?.find((entry) => entry.id === id);
    if (!memory) return;
    // Hiding respects the verbatim tail; revealing does not, or a memory that reached into
    // the tail could never give back everything it took.
    const ids = hidden
      ? hideableMessageIds(memory, current.messages, memoryConfigRef.current.verbatimTail)
      : coveredMessageIds(memory, current.messages);
    if (!ids.length) return;
    dispatch({ type: 'message/setHidden', ids, hidden, memoryId: id });
  }, []);

  const memoryHiddenCount = useCallback(
    (id: string) => state.messages.filter((message) => message.hiddenBy === id).length,
    [state.messages],
  );

  const deleteMemory = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const memories = current.metadata.memories ?? [];
      if (!memories.some((memory) => memory.id === id)) return;
      // Reveal first, while the memory still exists to be resolved against.
      setMemoryHidden(id, false);
      dispatch({
        type: 'chat/metadata',
        patch: { memories: memories.filter((memory) => memory.id !== id) },
      });
    },
    [setMemoryHidden],
  );

  /**
   * Write memories for everything past the watermark, one window at a time.
   *
   * Shaped like `summarize` and for the same reasons — one abort controller, a status the
   * panel can render, and a durable checkpoint after every paid request so a run that dies
   * at window seven keeps windows one to six. It differs in the request it builds: no
   * `assemblePrompt`, so no preset prompts, no jailbreak and nothing to write "ignore
   * previous instructions" around.
   */
  const extractMemories = useCallback(
    async (settingsOverride?: Partial<UnsavedMemoryDraft>) => {
      if (memoryAbortRef.current || summaryAbortRef.current) return;
      const current = stateRef.current;
      const extractionPreset = memoryPreset ?? preset;
      if (!current.chatId || current.status !== 'idle' || !character || !extractionPreset) return;
      if (!memoryConnection?.baseUrl || !memoryConnection.model) {
        setMemoryStatus({
          running: false,
          processed: 0,
          total: 0,
          error: 'The selected memory connection needs an endpoint and model.',
        });
        return;
      }

      /*
       * Saved settings win over anything the caller passed.
       *
       * The panel can only legitimately override what is not saved yet — the prompt
       * being typed. Letting it pass a whole settings object made `autoHide`, the one
       * destructive switch in the feature, depend on a snapshot taken when the panel
       * last rendered. Any gap between switching it off and pressing Extract — an
       * in-flight save, a failed one, a second window — and the run would hide messages
       * the user had just told it not to. A destructive default has to be read live.
       */
      const config: MemorySettings = { ...memoryConfigRef.current, ...settingsOverride };
      const rawMessages = toChatMessages(current);
      if (rawMessages[0] && !rawMessages[0].is_user) {
        rawMessages[0] = {
          ...rawMessages[0],
          mes: resolveGreetingMacros(rawMessages[0].mes, {
            character,
            preset: extractionPreset,
            persona,
            messages: rawMessages,
            metadata: current.metadata,
            globalVariables,
            seed: current.chatId,
          }),
        };
      }

      const backlog = memoryBacklog(memoryMessages(rawMessages), current.metadata.memoryWatermark);
      if (!backlog.length) {
        setMemoryStatus({
          running: false,
          processed: 0,
          total: 0,
          error: 'No new chat messages need remembering.',
        });
        return;
      }

      const resolve = (text: string): string =>
        resolveGreetingMacros(text, {
          character,
          preset: extractionPreset,
          persona,
          messages: rawMessages,
          metadata: current.metadata,
          globalVariables,
          seed: current.chatId!,
        });

      const profile = {
        name: character.name,
        description: resolve(character.description),
        personality: resolve(character.personality),
        scenario: resolve(
          typeof current.metadata.scenario === 'string'
            ? current.metadata.scenario
            : character.scenario,
        ),
      };
      const personaProfile = persona
        ? { name: persona.name, description: resolve(persona.description) }
        : null;

      const controller = new AbortController();
      memoryAbortRef.current = controller;
      memoryChatIdRef.current = current.chatId;
      let processed = 0;
      let remaining = backlog;
      setMemoryStatus({ running: true, processed: 0, total: backlog.length, error: null });

      try {
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, config.windowSize);
          const isFinalWindow = remaining.length <= config.windowSize;

          const apiMessages = buildExtractionMessages({
            extractPrompt: config.extractPrompt,
            character: profile,
            persona: personaProfile,
            priorMemories: (stateRef.current.metadata.memories ?? []).slice(-MEMORY_CHAIN_DEPTH),
            window: chunk,
          });

          const body = buildRequestBody({
            messages: apiMessages,
            preset: extractionPreset,
            connection: memoryConnection,
            stream: false,
            maxTokens: config.maxMemoryTokens,
          });
          const result = await streamGenerate(
            body,
            controller.signal,
            { onTick: () => {} },
            '',
            memoryConnection.id,
          );
          if (controller.signal.aborted || stateRef.current.chatId !== current.chatId) return;

          const parsed = parseMemoryResponse(result.content, chunk);
          if (parsed.error) throw new Error(parsed.error);
          const written = draftsToMemories(parsed.memories, { model: memoryConnection.model });

          // Nothing complete in the newest window means the scene is still unfolding. Stop
          // rather than advance, so the run picks it up whole next time.
          if (!written.length && isFinalWindow) break;

          // A window the model read and found nothing complete in still advances, or the
          // run would ask the same question forever.
          const boundary = written.at(-1)?.range?.endId ?? chunk.at(-1)!.id;
          const consumed = remaining.findIndex((message) => message.id === boundary) + 1;
          if (consumed <= 0) break;

          const actions: ChatAction[] = [
            {
              type: 'chat/metadata',
              patch: {
                memories: [...(stateRef.current.metadata.memories ?? []), ...written],
                memoryWatermark: boundary,
              },
            },
          ];
          if (config.autoHide) {
            for (const memory of written) {
              const ids = hideableMessageIds(
                memory,
                stateRef.current.messages,
                config.verbatimTail,
              );
              if (ids.length) {
                actions.push({ type: 'message/setHidden', ids, hidden: true, memoryId: memory.id });
              }
            }
          }

          // Fold from the freshest state, so chat activity during the request survives
          // rather than being overwritten by the copy captured before it.
          let nextState = stateRef.current;
          for (const action of actions) {
            nextState = chatReducer(nextState, action);
            dispatch(action);
          }
          stateRef.current = nextState;

          const snapshot = captureSnapshot(nextState);
          if (snapshot) {
            persistence.schedule(snapshot);
            await persistence.flush(snapshot.chatId);
          }

          processed += consumed;
          remaining = remaining.slice(consumed);
          setMemoryStatus({
            running: remaining.length > 0,
            processed,
            total: backlog.length,
            error: null,
          });
        }
        setMemoryStatus({ running: false, processed, total: backlog.length, error: null });
      } catch (error) {
        if (!controller.signal.aborted) {
          setMemoryStatus({
            running: false,
            processed,
            total: backlog.length,
            error: (error as Error).message,
          });
        }
      } finally {
        if (memoryAbortRef.current === controller) memoryAbortRef.current = null;
        if (memoryChatIdRef.current === current.chatId) memoryChatIdRef.current = null;
        if (controller.signal.aborted) {
          setMemoryStatus({ running: false, processed, total: backlog.length, error: null });
        }
        void refreshChats();
      }
    },
    [
      character,
      preset,
      memoryPreset,
      memoryConnection,
      persona,
      globalVariables,
      captureSnapshot,
      persistence,
      refreshChats,
    ],
  );

  /**
   * Auto-extraction: one check per settled reply, never per state change.
   *
   * The arm is set at `gen/finished` and only for the chat that generated, so opening a chat
   * with a large unextracted backlog never starts a paid run by itself — the backlog catches
   * up after the next reply in that chat. The interval is read from the config ref, so a
   * settings change made mid-generation is honoured at the settle. A run that was cancelled
   * or died leaves the backlog past the threshold; the next settle simply tries again.
   */
  useEffect(() => {
    const armed = autoExtractArmRef.current;
    if (!armed) return;
    // Consume before anything can bail, so one arm means at most one run.
    autoExtractArmRef.current = null;
    if (armed !== state.chatId || state.status !== 'idle') return;
    if (!autoExtractDue(memoryMode, memoryConfigRef.current.autoInterval, memoryPending)) return;
    if (memoryAbortRef.current || summaryAbortRef.current) return;
    void extractMemories();
  }, [state, memoryMode, memoryPending, extractMemories]);

  return {
    state,
    messages,
    stream,
    inspection: state.inspections[0] ?? null,
    busy: state.status !== 'idle',
    generationBlocked: state.status !== 'idle' || summaryStatus.running || memoryStatus.running,
    saving,
    saveError,
    loadError,
    send,
    regenerate,
    swipe,
    swipeTo,
    continueLast,
    guidedRespond,
    guidedSwipe,
    abort,
    summaryStatus,
    summaryPending,
    summarize,
    cancelSummary,
    editSummary,

    memoryStatus,
    memoryPending,
    extractMemories,
    cancelMemoryRun,
    setMemories,
    deleteMemory,
    setMemoryHidden,
    memoryHiddenCount,
    memoryRecall,
    editMessage,
    editReasoning,
    deleteMessage,
    toggleHidden,
    setHidden,
    chats,
    refreshChats,
    openChat,
    reloadChat,
    reloadCount,
    pendingChatRef,
    newChat,
    renameChat,
    deleteChat,
    branchFrom,
    flushSaves,
    retrySave,
    retryLoad,
    persona,
    setPersona,
    resolvePersona,
    updateMetadata,
    renderGreeting,
    regexMacros,
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
