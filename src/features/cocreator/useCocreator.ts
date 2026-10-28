/**
 * The design conversation's controller.
 *
 * Mirrors `useChat.generate`'s ownership discipline exactly, because the hazards are the
 * same: a request can outlive the screen that started it, and a late callback from an
 * abandoned generation must be inert rather than merely harmless.
 *
 * What it deliberately does *not* mirror: world info, personas, macros, regex scripts,
 * author's notes, guidance and `assemblePrompt`. A design session has no story, so none of
 * that has anything to act on.
 */

import { currentText, fromChatMessage } from '@shared/chat/message.ts';
import { cocreatorBudget } from '@shared/cocreator/generation.ts';
import { captureSideSnapshot, resolveSideSettings } from '@shared/cocreator/sideChat.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CharacterDetail } from '@shared/types/card.ts';
import type { MessageExtra } from '@shared/types/chat.ts';
import type { CocreatorSaveSnapshot, CocreatorSession } from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { cocreatorApi, presetApi, streamGenerate } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import type { StreamStore } from '../chat/state/streamStore.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { CocreatorSaveQueue } from './cocreatorPersistence.ts';
import { buildDesignGeneration } from './generation.ts';
import { renderSeedTurn, seedStash } from './seed.ts';
import { resolveCocreatorSettings } from './settings.ts';
import { buildSidePrompt } from './sidePrompt.ts';
import {
  type CocreatorAction,
  type CocreatorState,
  type ConversationTarget,
  cocreatorReducer,
  initialCocreatorState,
  toPersistedMessages,
  toPersistedSideChat,
} from './state/cocreatorReducer.ts';

const SAVE_DELAY_MS = 400;

export interface UseCocreatorOptions {
  session: CocreatorSession;
  defaults: CoCreatorSettings;
  connections: readonly Connection[];
  activeConnectionId: string | null;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  /**
   * The rendered example block, behind a ref rather than a value.
   *
   * The selection lives in this hook's own reducer, and rendering it needs the cards
   * fetched — so the block can only be computed by the caller *after* this hook has run. A
   * ref breaks that cycle, and reading it at generate time is right anyway: it is the same
   * "snapshot everything when the request starts" discipline the connection follows.
   */
  exampleBlockRef: RefObject<string>;
  examplesReadyRef: RefObject<boolean>;
  streamingFps: number;
  /**
   * The card the Studio handed off, when this desk is the arrival side of that handoff.
   *
   * Seeded as part of adopting the session — never re-applied afterwards, so a user who
   * deletes the seed turn and empties the stash has genuinely un-seeded the session. The
   * desk is keyed on `session.id`, so a new seed can only ever mean a new desk.
   */
  seed?: CharacterDetail | null;
}

export interface UseCocreator {
  state: CocreatorState;
  dispatch: (action: CocreatorAction) => void;
  stream: StreamStore;
  /** A provider call is in flight. */
  busy: boolean;
  saving: boolean;
  saveError: string | null;
  /** Why generation is unavailable, for a `disabledReason`. Null when it is available. */
  blockedReason: string | null;
  send: (text: string, extra?: MessageExtra) => Promise<void>;
  /** Generate another take on the last reply — an overswipe, never destructive. */
  reroll: () => Promise<void>;
  /**
   * Generate the reply owed to the user turn at the end of the transcript — one whose
   * generation failed, was aborted empty, or was deleted afterwards.
   */
  retry: () => Promise<void>;
  continueReply: () => Promise<void>;
  abort: () => void;
  /** `base` flushes a state the reducer has produced but React has not yet committed. */
  flushSaves: (base?: CocreatorState) => Promise<void>;
  persistence: PersistenceControls;
  connection: Connection | null;
  presetId: string | null;
  preset: Preset | null;
  systemPrompt: string;
  analysisPrompt: string;
  countTokens: TokenCounter;
  sideCountTokens: TokenCounter;
  sideConnection: Connection | null;
  sideBlockedReason: string | null;
  sideContext: {
    totalTokens: number;
    droppedMainMessages: number;
    droppedSideMessages: number;
    error: string | null;
  } | null;
  openSideChat: (reset?: boolean) => boolean;
  sendSide: (text: string) => boolean;
  rerollSide: () => Promise<void>;
  retrySide: () => Promise<void>;
  continueSide: () => Promise<void>;
}

export function useCocreator(options: UseCocreatorOptions): UseCocreator {
  const {
    session,
    defaults,
    connections,
    activeConnectionId,
    presets,
    activePresetId,
    activePreset,
    tokenizerEncoding,
    exampleBlockRef,
    examplesReadyRef,
    streamingFps,
    seed,
  } = options;

  const [state, dispatch] = useReducer(cocreatorReducer, initialCocreatorState);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const resolved = useMemo(
    () =>
      resolveCocreatorSettings({
        session: state.settings,
        defaults,
        connections,
        activeConnectionId,
        presets,
        activePresetId,
      }),
    [state.settings, defaults, connections, activeConnectionId, presets, activePresetId],
  );
  const connection = resolved.connection;
  const systemPrompt = resolved.systemPrompt;
  const streaming = resolved.streaming;
  const countTokens = useTokenizer(connection?.model ?? '', tokenizerEncoding);
  const sideSettings = useMemo(
    () => resolveSideSettings(defaults.sideChat, state.sideChat?.settings ?? {}, connections),
    [defaults.sideChat, state.sideChat?.settings, connections],
  );
  const sideCountTokens = useTokenizer(sideSettings.connection?.model ?? '', tokenizerEncoding);
  const [loadedPreset, setLoadedPreset] = useState<{ id: string; value: Preset } | null>(null);

  useEffect(() => {
    const id = resolved.presetId;
    if (!id || id === activePresetId) return;
    let cancelled = false;
    void presetApi
      .get(id)
      .then((value) => {
        if (!cancelled) setLoadedPreset({ id, value });
      })
      .catch(() => {
        if (!cancelled) setLoadedPreset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resolved.presetId, activePresetId]);

  const preset =
    resolved.presetId === activePresetId
      ? activePreset
      : loadedPreset?.id === resolved.presetId
        ? loadedPreset.value
        : null;

  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);
  const settleForNavigationRef = useRef<(() => CocreatorState) | null>(null);

  // Recreated only when the rate changes, so a running stream keeps its store.
  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);

  const persistenceRef = useRef<CocreatorSaveQueue | null>(null);
  if (!persistenceRef.current) {
    persistenceRef.current = new CocreatorSaveQueue(
      (snapshot, requestOptions) => cocreatorApi.save(snapshot, requestOptions),
      SAVE_DELAY_MS,
      {
        onSaved: (snapshot) => {
          dispatch({
            type: 'session/saved',
            sessionId: snapshot.sessionId,
            revision: snapshot.revision,
          });
          if (stateRef.current.sessionId === snapshot.sessionId) setSaveError(null);
        },
        onFailed: (sessionId, error) => {
          if (stateRef.current.sessionId === sessionId) setSaveError(error.message);
        },
        onPendingChange: setSaving,
      },
    );
  }
  const persistence = persistenceRef.current;

  // Adopting the loaded session is keyed on its id: re-running on every field change would
  // reset the transcript out from under an edit typed while a save was in flight. The seed
  // rides the same key for the same reason, and its dispatch right after the load is what
  // makes it survive StrictMode's double-invoked effects: load → seed → load (resets to the
  // still-empty server doc) → seed again, which the reducer's guard collapses to one turn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the session id only
  useEffect(() => {
    dispatch({ type: 'session/loaded', session });
    if (seed) {
      const id = crypto.randomUUID();
      dispatch({
        type: 'session/seeded',
        id,
        text: renderSeedTurn(seed),
        stash: seedStash(seed, id),
      });
    }
  }, [session.id]);

  // The override is endpoint-bound. If an inherited default moves the session to another
  // connection, remove the stale choice instead of merely ignoring it and letting it spring
  // back if the old connection is selected again later.
  useEffect(() => {
    const override = state.settings.modelOverride;
    if (override && override.connectionId !== connection?.id) {
      dispatch({ type: 'settings/patch', patch: { modelOverride: undefined } });
    }
  }, [state.settings.modelOverride, connection?.id]);

  useEffect(() => {
    const override = state.sideChat?.settings.modelOverride;
    if (
      override &&
      sideSettings.connection &&
      override.connectionId !== sideSettings.connection.id &&
      state.status === 'idle'
    ) {
      dispatch({ type: 'side/settings', patch: { modelOverride: undefined } });
    }
  }, [state.sideChat?.settings.modelOverride, sideSettings.connection, state.status]);

  const captureSnapshot = useCallback((current: CocreatorState): CocreatorSaveSnapshot | null => {
    if (!current.sessionId) return null;
    return {
      sessionId: current.sessionId,
      revision: current.revision,
      title: current.title,
      stash: current.stash,
      examples: current.examples,
      settings: current.settings,
      finishedAvatar: current.finishedAvatar,
      // The pre-generation projection: a blank placeholder or a tentative swipe is UI state
      // until the request settles, and must not become durable under the earlier revision.
      messages: toPersistedMessages(current),
      sideChat: toPersistedSideChat(current),
    };
  }, []);

  useEffect(() => {
    if (!state.sessionId) return;
    persistence.adopt(state.sessionId, state.persistedRevision);
    if (state.revision <= state.persistedRevision) return;
    const snapshot = captureSnapshot(state);
    if (snapshot) persistence.schedule(snapshot);
  }, [captureSnapshot, persistence, state]);

  /**
   * Drain this session's queue.
   *
   * `base` exists for the one caller that flushes in the same turn it dispatched: React has
   * not re-rendered yet, so `stateRef` still holds the pre-dispatch state and the flush would
   * find nothing dirty. Passing the state the reducer produced makes the write cover the
   * action that prompted it.
   */
  const flushSaves = useCallback(
    async (base?: CocreatorState) => {
      const current = base ?? settleForNavigationRef.current?.() ?? stateRef.current;
      const snapshot = captureSnapshot(current);
      if (!snapshot || snapshot.revision <= current.persistedRevision) return;

      persistence.schedule(snapshot);
      try {
        await persistence.flush(snapshot.sessionId);
        setSaveError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSaveError(message);
        throw error;
      }
    },
    [captureSnapshot, persistence],
  );

  const retrySave = useCallback(async () => {
    await flushSaves();
  }, [flushSaves]);

  const persistenceControls = useMemo<PersistenceControls>(
    () => ({ flush: flushSaves, retry: retrySave }),
    [flushSaves, retrySave],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const blockedReason = useMemo(() => {
    if (!connection?.baseUrl || !connection.model) return 'No connection and model are configured';
    if (!preset) return 'No preset is loaded';
    return null;
  }, [connection, preset]);

  const sideContext = useMemo(() => {
    if (!state.sideChat || !preset || !sideSettings.connection) return null;
    try {
      const budget = cocreatorBudget({
        preset,
        ...sideSettings,
        connection: sideSettings.connection,
        stream: streaming,
      });
      const prompt = buildSidePrompt({
        snapshot: state.sideChat.snapshot,
        messages: state.sideChat.messages,
        countTokens: sideCountTokens,
        maxPromptTokens: budget.promptTokens,
      });
      return {
        ...prompt,
        error: prompt.fixedOverflow
          ? 'The frozen instructions and examples exceed the side context budget. Raise it or start fresh with fewer examples.'
          : null,
      };
    } catch (error) {
      return {
        totalTokens: 0,
        droppedMainMessages: 0,
        droppedSideMessages: 0,
        error: (error as Error).message,
      };
    }
  }, [state.sideChat, preset, sideSettings, sideCountTokens, streaming]);
  const sideBlockedReason =
    !sideSettings.connection?.baseUrl || !sideSettings.connection.model
      ? 'Choose a side-chat connection and model in Side chat settings'
      : !preset
        ? 'No sampler preset is loaded'
        : (sideContext?.error ?? null);

  const prepareSideChat = useCallback(
    (reset = false): CocreatorState | null => {
      const current = stateRef.current;
      if (current.sideChat && !reset) return current;
      if (!examplesReadyRef.current || !current.sessionId || (reset && current.status !== 'idle'))
        return null;
      const snapshot = captureSideSnapshot({
        systemPrompt,
        exampleBlock: exampleBlockRef.current,
        messages: toPersistedMessages(current).map(fromChatMessage),
      });
      const action: CocreatorAction = { type: reset ? 'side/reset' : 'side/opened', snapshot };
      const next = cocreatorReducer(current, action);
      dispatch(action);
      return next;
    },
    [systemPrompt, exampleBlockRef, examplesReadyRef],
  );

  const generate = useCallback(
    async (
      mode: 'send' | 'swipe' | 'continue',
      base?: CocreatorState,
      target: ConversationTarget = 'main',
    ) => {
      const current = base ?? stateRef.current;
      if (current.status !== 'idle' || abortRef.current) return;
      const selectedConnection = target === 'side' ? sideSettings.connection : connection;
      const counter = target === 'side' ? sideCountTokens : countTokens;
      if (!selectedConnection || !preset || (target === 'side' && !current.sideChat)) return;

      // Settings can change mid-generation. Keep the request body, the reply's recorded
      // metadata and the server-side connection lookup on one snapshot for the whole call.
      const requestConnection: Connection = { ...selectedConnection };
      const requestExtra: MessageExtra = {
        api: requestConnection.provider,
        model: requestConnection.model,
      };

      const conversationMessages =
        target === 'side' ? current.sideChat!.messages : current.messages;
      const previousReply = conversationMessages.at(-1);
      if (mode === 'continue' && (!previousReply || previousReply.is_user)) return;
      const prefix = mode === 'continue' && previousReply ? currentText(previousReply) : '';
      const combine = (content: string) => (content ? prefix + content : '');

      const startAction: CocreatorAction = {
        type: 'gen/started',
        target,
        mode: mode === 'continue' ? 'swipe' : mode,
        newId: crypto.randomUUID(),
      };
      const started = cocreatorReducer(current, startAction);
      dispatch(startAction);

      // The reducer refuses some starts outright — re-rolling with nothing to re-roll.
      if (started.status === 'idle' || !started.streamingId) return;

      const controller = new AbortController();
      abortRef.current = controller;
      // One identity for this attempt, settled before the request so every path out of
      // it — settled, stopped, failed — records the same one. A re-roll is a new
      // generation and gets a new id.
      const generationId = crypto.randomUUID();

      // The controller ref is also the generation's ownership token: a newer generation
      // replaces it, so late callbacks from this one become inert rather than writing into
      // a session the reader has already left.
      const ownsGeneration = () =>
        abortRef.current === controller && stateRef.current.sessionId === started.sessionId;
      const ensureActive = () => {
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
      // "nothing came back" and the reducer undoes exactly what starting it did.
      let text = '';
      let reasoning = '';

      // Navigation owns a synchronous final projection, so its flush includes partial text
      // before React commits the settlement. Late network callbacks lose ownership.
      const settleForNavigation = () => {
        const action: CocreatorAction = {
          type: 'gen/aborted',
          target,
          text,
          reasoning,
          generationId,
          extra: requestExtra,
        };
        controller.abort();
        endStream();
        abortRef.current = null;
        settleForNavigationRef.current = null;
        const next = cocreatorReducer(stateRef.current, action);
        dispatch(action);
        return next;
      };
      settleForNavigationRef.current = settleForNavigation;

      try {
        const { body } = buildDesignGeneration({
          mode,
          messages:
            mode === 'continue'
              ? conversationMessages
              : target === 'side'
                ? started.sideChat!.messages
                : started.messages,
          preset,
          connection: requestConnection,
          settings:
            target === 'side'
              ? {
                  outputTokens: sideSettings.outputTokens,
                  contextTokens: sideSettings.contextTokens,
                }
              : current.settings,
          systemPrompt,
          exampleBlock: exampleBlockRef.current,
          countTokens: counter,
          streaming,
          ...(target === 'side' ? { sideSnapshot: current.sideChat!.snapshot } : {}),
        });

        if (!ensureActive()) return;

        stream.begin(prefix, streaming);
        streamStarted = true;

        const final = await streamGenerate(
          body,
          controller.signal,
          {
            onFirstToken: () => {
              if (ownsGeneration() && !controller.signal.aborted) {
                dispatch({ type: 'gen/streaming', target });
              }
            },
            onTick: (streamState) => {
              if (!ownsGeneration() || controller.signal.aborted) return;
              text = combine(streamState.content);
              reasoning = streamState.reasoning;
              stream.set(prefix + streamState.content, streamState.reasoning);
            },
          },
          '',
          requestConnection.id,
          {
            feature: target === 'side' ? 'cocreatorSideChat' : 'cocreator',
            generationId,
            ...(started.sessionId ? { sessionId: started.sessionId } : {}),
            countText: counter.countText,
          },
        );

        // A non-streaming response can resolve in the same turn as an abort, so ownership is
        // checked after the await as well as inside the callbacks.
        if (!ensureActive()) return;
        endStream();

        dispatch({
          type: 'gen/finished',
          target,
          text: combine(final.content),
          // 'length' becomes the truncated badge in the reducer; a Stop click or a
          // failure marks its own.
          finishReason: final.finishReason,
          extra: {
            api: requestConnection.provider,
            // Recorded per swipe, so a card assembled across three model swaps can still
            // say which one wrote each line.
            model: final.model ?? requestConnection.model,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            token_count: final.usage?.completion_tokens ?? counter.countText(final.content),
            generation_id: generationId,
            ...(typeof final.usage?.completion_tokens === 'number' ? { usage_reported: true } : {}),
          },
        });
      } catch (error) {
        if (ownsGeneration()) endStream();
        // Whatever arrived before the failure is kept.
        if (ownsGeneration() && controller.signal.aborted) {
          dispatch({
            type: 'gen/aborted',
            target,
            text,
            reasoning,
            generationId,
            extra: requestExtra,
          });
        } else if (ownsGeneration()) {
          dispatch({
            type: 'gen/failed',
            target,
            message: (error as Error).message,
            text,
            reasoning,
            generationId,
            extra: requestExtra,
          });
        }
      } finally {
        // An old request may settle after a newer generation replaced the ref. It must not
        // clear that controller or stop its stream.
        if (abortRef.current === controller) {
          endStream();
          abortRef.current = null;
        }
        if (settleForNavigationRef.current === settleForNavigation)
          settleForNavigationRef.current = null;
      }
    },
    [
      connection,
      preset,
      systemPrompt,
      exampleBlockRef,
      countTokens,
      sideSettings,
      sideCountTokens,
      stream,
      streaming,
    ],
  );

  const send = useCallback(
    async (text: string, extra?: MessageExtra) => {
      const trimmed = text.trim();
      if (!trimmed || blockedReason || abortRef.current || stateRef.current.status !== 'idle')
        return;

      const action: CocreatorAction = {
        type: 'message/appendUser',
        id: crypto.randomUUID(),
        text: trimmed,
        extra,
      };
      // Fold the user's turn in first and generate from that state, so the reply is built
      // against a transcript that already contains what it is replying to.
      const next = cocreatorReducer(stateRef.current, action);
      dispatch(action);
      await generate('send', next);
    },
    [generate, blockedReason],
  );

  const reroll = useCallback(async () => {
    await generate('swipe');
  }, [generate]);

  const sendSide = useCallback(
    (text: string) => {
      if (
        !text.trim() ||
        sideBlockedReason ||
        abortRef.current ||
        stateRef.current.status !== 'idle'
      )
        return false;
      const base = prepareSideChat();
      if (!base) return false;
      const action: CocreatorAction = {
        type: 'message/appendUser',
        target: 'side',
        id: crypto.randomUUID(),
        text: text.trim(),
      };
      const next = cocreatorReducer(base, action);
      dispatch(action);
      void generate('send', next, 'side');
      return true;
    },
    [sideBlockedReason, prepareSideChat, generate],
  );

  /*
   * A retry is `send` without appending a turn: the reducer's send arm already generates
   * from the whole transcript, so a trailing user message is simply what gets answered.
   * A failed or empty-aborted send removes the placeholder and leaves the user message
   * last again — which is exactly when the UI offers this.
   */
  const retry = useCallback(async () => {
    await generate('send');
  }, [generate]);

  const continueReply = useCallback(async () => {
    await generate('continue');
  }, [generate]);

  // A design session is worth more than a chat turn, so an unload attempts the save too.
  useEffect(() => {
    const onPagehide = () => {
      const snapshot = captureSnapshot(settleForNavigationRef.current?.() ?? stateRef.current);
      if (snapshot && snapshot.revision > stateRef.current.persistedRevision) {
        persistence.schedule(snapshot);
      }
      persistence.flushForPagehide();
    };
    window.addEventListener('pagehide', onPagehide);
    return () => window.removeEventListener('pagehide', onPagehide);
  }, [captureSnapshot, persistence]);

  // Leaving the desk must not leave a request writing into a session nobody is looking at.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return {
    state,
    dispatch,
    stream,
    busy: state.status !== 'idle',
    saving,
    saveError,
    blockedReason,
    send,
    reroll,
    retry,
    continueReply,
    abort,
    flushSaves,
    persistence: persistenceControls,
    connection,
    presetId: resolved.presetId,
    preset,
    systemPrompt,
    analysisPrompt: resolved.analysisPrompt,
    countTokens,
    sideCountTokens,
    sideConnection: sideSettings.connection,
    sideBlockedReason,
    sideContext,
    openSideChat: (reset = false) => prepareSideChat(reset) !== null,
    sendSide,
    rerollSide: () => generate('swipe', undefined, 'side'),
    retrySide: () => generate('send', undefined, 'side'),
    continueSide: () => generate('continue', undefined, 'side'),
  };
}
