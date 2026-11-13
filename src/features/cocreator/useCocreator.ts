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
import {
  activeCheckpoint,
  makeCompactionPlan,
  shouldCompact,
} from '@shared/cocreator/compaction.ts';
import { cocreatorBudget } from '@shared/cocreator/generation.ts';
import { captureSideSnapshot, resolveSideSettings } from '@shared/cocreator/sideChat.ts';
import type { ModelSlots } from '@shared/models/slots.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Connection, ResolvedModel } from '@shared/providers/types.ts';
import type { MessageExtra } from '@shared/types/chat.ts';
import type { CocreatorSaveSnapshot, CocreatorSession } from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { cocreatorApi, presetApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { runGeneration } from '../../lib/generation.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import type { StreamStore } from '../chat/state/streamStore.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { resolveModelContext } from '../models/modelContext.ts';
import { useModelContext } from '../models/useModelContext.ts';
import { measureCharacterContext } from './characterContext.ts';
import { CocreatorSaveQueue } from './cocreatorPersistence.ts';
import { runCompaction } from './compactionRun.ts';
import { type CocreatorContext, contextView } from './context.ts';
import type { LoadedExamples } from './examples.ts';
import { buildDesignGeneration } from './generation.ts';
import { renderDraftBlock } from './seed.ts';
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
import { useExampleCards } from './useExampleCards.ts';

const SAVE_DELAY_MS = 400;

export interface UseCocreatorOptions {
  session: CocreatorSession;
  defaults: CoCreatorSettings;
  connections: readonly Connection[];
  /** The app's model slots: the session falls back to `cocreator`, its side chat to `sideChat`. */
  models: ModelSlots;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  streamingFps: number;
}

export interface UseCocreator {
  compact: (target?: ConversationTarget) => Promise<void>;
  setAutoCompaction: (target: ConversationTarget, automatic: boolean) => void;
  mainContext: CocreatorContext;
  sideCompactionContext: CocreatorContext;
  compacting: ConversationTarget | null;
  loadedExamples: LoadedExamples;
  state: CocreatorState;
  dispatch: (action: CocreatorAction) => void;
  stream: StreamStore;
  /** A provider call is in flight. */
  busy: boolean;
  saving: boolean;
  saveError: string | null;
  /** Why generation is unavailable, for a `disabledReason`. Null when it is available. */
  blockedReason: string | null;
  send: (text: string, extra?: MessageExtra) => boolean;
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
  connection: ResolvedModel | null;
  presetId: string | null;
  preset: Preset | null;
  systemPrompt: string;
  analysisPrompt: string;
  countTokens: TokenCounter;
  sideCountTokens: TokenCounter;
  sideConnection: ResolvedModel | null;
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
    models,
    presets,
    activePresetId,
    activePreset,
    tokenizerEncoding,
    streamingFps,
  } = options;

  const [state, dispatch] = useReducer(cocreatorReducer, initialCocreatorState);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState<ConversationTarget | null>(null);
  const compactionDone = useRef<Promise<void> | null>(null);
  const manualCompactionDone = useRef<Promise<void> | null>(null);

  const resolved = useMemo(
    () =>
      resolveCocreatorSettings({
        session: state.settings,
        defaults,
        connections,
        models,
        presets,
        activePresetId,
      }),
    [state.settings, defaults, connections, models, presets, activePresetId],
  );
  const connection = resolved.connection;
  const systemPrompt = resolved.systemPrompt;
  const streaming = resolved.streaming;
  const countTokens = useTokenizer(connection?.model ?? '', tokenizerEncoding);
  const loadedExamples = useExampleCards(state.examples, countTokens);
  const exampleBlockRef = useRef(loadedExamples.text);
  exampleBlockRef.current = loadedExamples.text;
  const examplesReady = state.sessionId === session.id && !loadedExamples.loading;
  const examplesReadyRef = useRef(examplesReady);
  examplesReadyRef.current = examplesReady;
  const sideSettings = useMemo(
    () =>
      resolveSideSettings(defaults.sideChat, state.sideChat?.settings ?? {}, models, connections),
    [defaults.sideChat, state.sideChat?.settings, models, connections],
  );
  const sideConnection = sideSettings.model.ok ? sideSettings.model.model : null;
  const sideCountTokens = useTokenizer(sideConnection?.model ?? '', tokenizerEncoding);
  const mainModelContext = useModelContext(connection);
  const sideModelContextInfo = useModelContext(sideConnection);
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

  // The initial card and portrait are already durable. Adopt once, never re-seed on reload
  // or on an acknowledgement of an older save while the user is editing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the session id only
  useEffect(() => {
    if (stateRef.current.sessionId === session.id) return;
    dispatch({ type: 'session/loaded', session });
  }, [session.id]);

  useEffect(() => {
    dispatch({ type: 'target/updated', avatar: session.targetAvatar });
  }, [session.targetAvatar]);

  const captureSnapshot = useCallback((current: CocreatorState): CocreatorSaveSnapshot | null => {
    if (!current.sessionId) return null;
    return {
      sessionId: current.sessionId,
      revision: current.revision,
      title: current.title,
      stash: current.stash,
      examples: current.examples,
      settings: current.settings,
      compaction: current.compaction,
      finishedAvatar: current.finishedAvatar,
      baseline: current.baseline,
      publication: current.publication,
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
    () => ({
      flush: async () => {
        if (manualCompactionDone.current || compactionDone.current) {
          abortRef.current?.abort();
          await (manualCompactionDone.current ?? compactionDone.current);
        }
        await flushSaves();
      },
      retry: retrySave,
    }),
    [flushSaves, retrySave],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const blockedReason = useMemo(() => {
    if (!resolved.model.ok) return resolved.model.reason;
    if (!preset) return 'No preset is loaded';
    if (!examplesReady) return 'Wait for the selected examples to load.';
    return null;
  }, [resolved.model, preset, examplesReady]);

  const sideModelContext = sideModelContextInfo.tokens;

  const sideContext = useMemo(() => {
    if (!state.sideChat || !preset || !sideConnection || !sideModelContext) return null;
    try {
      const budget = cocreatorBudget({
        preset,
        outputTokens: sideSettings.outputTokens,
        contextTokens: sideModelContext,
        connection: sideConnection,
        stream: streaming,
      });
      const prompt = buildSidePrompt({
        compaction: state.sideChat.compaction,
        snapshot: state.sideChat.snapshot,
        messages: state.sideChat.messages,
        countTokens: sideCountTokens,
        maxPromptTokens: budget.promptTokens,
      });
      return {
        ...prompt,
        error: prompt.fixedOverflow
          ? "The frozen instructions, card and examples don't fit the side chat's model. Choose a larger model or start it fresh with less context."
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
  }, [
    state.sideChat,
    preset,
    sideSettings,
    sideConnection,
    sideModelContext,
    sideCountTokens,
    streaming,
  ]);
  const sideBlockedReason = !sideSettings.model.ok
    ? sideSettings.model.reason
    : !preset
      ? 'No sampler preset is loaded'
      : (sideContext?.error ?? null);

  const prepareSideChat = useCallback(
    (reset = false): CocreatorState | null => {
      const current = stateRef.current;
      if (current.sideChat && !reset) return current;
      if (
        !examplesReadyRef.current ||
        !current.sessionId ||
        (reset && (current.status !== 'idle' || abortRef.current))
      )
        return null;
      const snapshot = captureSideSnapshot({
        systemPrompt,
        exampleBlock: exampleBlockRef.current,
        draftBlock: renderDraftBlock(current.stash, current.baseline?.card ?? null),
        messages: toPersistedMessages(current).map(fromChatMessage),
      });
      const action: CocreatorAction = { type: reset ? 'side/reset' : 'side/opened', snapshot };
      const next = cocreatorReducer(current, action);
      dispatch(action);
      return next;
    },
    [systemPrompt],
  );

  const measure = useCallback(
    (
      current: CocreatorState,
      target: ConversationTarget,
      contextTokens: number,
      examples = exampleBlockRef.current,
    ) => {
      const model = target === 'side' ? sideConnection : connection;
      if (!model || !preset) return null;
      return measureCharacterContext({
        messages: target === 'side' ? (current.sideChat?.messages ?? []) : current.messages,
        snapshot: target === 'side' ? current.sideChat?.snapshot : undefined,
        compaction: target === 'side' ? current.sideChat?.compaction : current.compaction,
        model,
        preset,
        contextTokens,
        settings:
          target === 'side' ? { outputTokens: sideSettings.outputTokens } : current.settings,
        systemPrompt,
        exampleBlock: examples,
        draftBlock: renderDraftBlock(current.stash, current.baseline?.card ?? null),
        countTokens: target === 'side' ? sideCountTokens : countTokens,
      });
    },
    [connection, sideConnection, preset, sideSettings, systemPrompt, countTokens, sideCountTokens],
  );

  const performCompaction = useCallback(
    async (
      base: CocreatorState,
      target: ConversationTarget,
      controller: AbortController,
      contextTokens: number,
    ): Promise<CocreatorState> => {
      const measured = measure(base, target, contextTokens);
      const model = target === 'side' ? sideConnection : connection;
      const counter = target === 'side' ? sideCountTokens : countTokens;
      const compaction = target === 'side' ? base.sideChat?.compaction : base.compaction;
      if (!measured || !model || !preset || !base.sessionId) return base;
      const plan = makeCompactionPlan({
        messages: measured.sources,
        state: compaction,
        maxPromptTokens: measured.budget.promptTokens,
        countText: counter.countText,
        kind: target === 'side' ? 'side' : 'character',
      });
      if (!plan || measured.fixed > measured.budget.promptTokens) return base;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      compactionDone.current = done;
      setCompacting(target);
      try {
        let record = {
          ...(await runCompaction({
            plan,
            model,
            preset,
            signal: controller.signal,
            sessionId: base.sessionId,
            feature: target === 'side' ? 'cocreatorSideChat' : 'cocreator',
            countText: counter.countText,
            streaming,
          })),
          beforeTokens: measured.used,
        };
        if (abortRef.current !== controller || stateRef.current.sessionId !== base.sessionId)
          return base;
        const latest = stateRef.current.streamingId === base.streamingId ? stateRef.current : base;
        let action: CocreatorAction = { type: 'compaction/recorded', target, record };
        let next = cocreatorReducer(latest, action);
        const after = measure(next, target, contextTokens);
        if (record.status === 'complete') {
          if (
            !after ||
            after.used >= measured.used ||
            !activeCheckpoint(
              target === 'side' ? next.sideChat?.compaction : next.compaction,
              after.sources,
            )
          ) {
            record = {
              ...record,
              status: 'failed',
              checkpoint: undefined,
              error:
                'The summary did not reduce the current context. The previous context is still in use.',
            };
          } else record = { ...record, beforeTokens: measured.used, afterTokens: after.used };
          action = { type: 'compaction/recorded', target, record };
          next = cocreatorReducer(latest, action);
        }
        dispatch(action);
        await flushSaves(next);
        if (record.status !== 'complete') {
          if (record.status === 'aborted')
            throw new DOMException('Compaction stopped.', 'AbortError');
          throw new Error(record.error ?? 'Compaction failed.');
        }
        return next;
      } finally {
        if (compactionDone.current === done) compactionDone.current = null;
        setCompacting(null);
        finish();
      }
    },
    [
      measure,
      sideConnection,
      connection,
      sideCountTokens,
      countTokens,
      preset,
      streaming,
      flushSaves,
    ],
  );

  const compact = useCallback(
    async (target: ConversationTarget = 'main') => {
      const base = stateRef.current;
      const model = target === 'side' ? sideConnection : connection;
      if (
        abortRef.current ||
        base.status !== 'idle' ||
        !model ||
        !preset ||
        (target === 'side' && !base.sideChat) ||
        (target === 'main' && !examplesReadyRef.current)
      )
        return;
      const controller = new AbortController();
      abortRef.current = controller;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      manualCompactionDone.current = done;
      setCompacting(target);
      try {
        const contextTokens = await resolveModelContext(model, controller.signal);
        controller.signal.throwIfAborted();
        await performCompaction(base, target, controller, contextTokens);
      } catch (error) {
        if (!controller.signal.aborted && stateRef.current.sessionId === base.sessionId)
          dispatch({ type: 'error/set', target, message: (error as Error).message });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (manualCompactionDone.current === done) manualCompactionDone.current = null;
        setCompacting(null);
        finish();
      }
    },
    [sideConnection, connection, preset, performCompaction],
  );

  const makeContext = useCallback(
    (target: ConversationTarget): CocreatorContext => {
      const model = target === 'side' ? sideConnection : connection;
      const info = target === 'side' ? sideModelContextInfo : mainModelContext;
      let measured: ReturnType<typeof measure> = null;
      let failure: string | null = null;
      try {
        measured = measure(state, target, info.tokens, loadedExamples.text);
      } catch (error) {
        failure = (error as Error).message;
      }
      return contextView({
        label: target === 'side' ? 'Character side chat' : 'Character Co-Creator',
        model: model?.model ?? null,
        total: info.tokens,
        assumed: info.assumed,
        used: measured?.used ?? 0,
        fixed: measured?.fixed ?? 0,
        summary: measured?.summary ?? 0,
        reserved: measured?.budget.reservedTokens ?? 0,
        promptBudget: measured?.budget.promptTokens ?? 0,
        messages: measured?.sources ?? [],
        state: target === 'side' ? state.sideChat?.compaction : state.compaction,
        busy: state.status !== 'idle' || compacting !== null,
        compacting: compacting === target,
        countText: (target === 'side' ? sideCountTokens : countTokens).countText,
        kind: target === 'side' ? 'side' : 'character',
        blocked: failure ?? (target === 'side' ? sideBlockedReason : blockedReason),
      });
    },
    [
      state,
      sideConnection,
      connection,
      sideModelContextInfo,
      mainModelContext,
      loadedExamples.text,
      measure,
      compacting,
      countTokens,
      sideCountTokens,
      blockedReason,
      sideBlockedReason,
    ],
  );
  const mainContext = useMemo(() => makeContext('main'), [makeContext]);
  const sideCompactionContext = useMemo(() => makeContext('side'), [makeContext]);

  const generate = useCallback(
    async (
      mode: 'send' | 'swipe' | 'continue',
      base?: CocreatorState,
      target: ConversationTarget = 'main',
    ) => {
      const current = base ?? stateRef.current;
      if (
        current.status !== 'idle' ||
        abortRef.current ||
        (target === 'main' && !examplesReadyRef.current)
      )
        return;
      const selectedConnection = target === 'side' ? sideConnection : connection;
      const counter = target === 'side' ? sideCountTokens : countTokens;
      if (!selectedConnection || !preset || (target === 'side' && !current.sideChat)) return;

      // Settings can change mid-generation. Keep the request body, the reply's recorded
      // metadata and the server-side connection lookup on one snapshot for the whole call.
      const requestConnection: ResolvedModel = { ...selectedConnection };
      const draftBlock = renderDraftBlock(current.stash, current.baseline?.card ?? null);
      const exampleBlock = exampleBlockRef.current;
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
      let started = cocreatorReducer(current, startAction);
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
        // Sized from the model's own context, never a setting: a request that would not fit
        // is the model's limit, not something to tune by hand.
        const contextTokens = await resolveModelContext(requestConnection, controller.signal);
        if (!ensureActive()) return;
        const measured = measure(mode === 'continue' ? current : started, target, contextTokens);
        const compaction = target === 'side' ? started.sideChat?.compaction : started.compaction;
        if (measured && shouldCompact(compaction, measured.used, measured.budget.promptTokens)) {
          started = await performCompaction(started, target, controller, contextTokens);
          if (!ensureActive()) return;
          const after = measure(started, target, contextTokens);
          if (after && after.used > after.budget.promptTokens) {
            throw new Error(
              'The context still exceeds this model’s limit. Compact more conversation, reduce the fixed card or examples, or choose a larger model.',
            );
          }
        }
        const { body } = buildDesignGeneration({
          compaction: target === 'side' ? started.sideChat?.compaction : started.compaction,
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
              ? { outputTokens: sideSettings.outputTokens, contextTokens }
              : { ...current.settings, contextTokens },
          systemPrompt,
          exampleBlock,
          draftBlock,
          countTokens: counter,
          streaming,
          ...(target === 'side' ? { sideSnapshot: current.sideChat!.snapshot } : {}),
        });

        if (!ensureActive()) return;

        stream.begin(prefix, streaming);
        streamStarted = true;

        const final = await runGeneration({
          model: requestConnection,
          body,
          signal: controller.signal,
          usage: {
            feature: target === 'side' ? 'cocreatorSideChat' : 'cocreator',
            generationId,
            ...(started.sessionId ? { sessionId: started.sessionId } : {}),
            countText: counter.countText,
          },
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
        });

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
      measure,
      performCompaction,
      countTokens,
      sideSettings,
      sideConnection,
      sideCountTokens,
      stream,
      streaming,
    ],
  );

  const send = useCallback(
    (text: string, extra?: MessageExtra) => {
      const trimmed = text.trim();
      if (
        !trimmed ||
        blockedReason ||
        !examplesReadyRef.current ||
        abortRef.current ||
        stateRef.current.status !== 'idle'
      )
        return false;

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
      void generate('send', next);
      return true;
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
    busy: state.status !== 'idle' || compacting !== null,
    compact,
    compacting,
    mainContext,
    sideCompactionContext,
    loadedExamples,
    setAutoCompaction: (target, automatic) =>
      dispatch({ type: 'compaction/automatic', target, automatic }),
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
    sideConnection,
    sideBlockedReason,
    sideContext,
    openSideChat: (reset = false) => prepareSideChat(reset) !== null,
    sendSide,
    rerollSide: () => generate('swipe', undefined, 'side'),
    retrySide: () => generate('send', undefined, 'side'),
    continueSide: () => generate('continue', undefined, 'side'),
  };
}
