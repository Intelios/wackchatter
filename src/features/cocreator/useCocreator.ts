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

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { MessageExtra } from '@shared/types/chat.ts';
import type { CocreatorSaveSnapshot, CocreatorSession } from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { cocreatorApi, presetApi, streamGenerate } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { useTokenizer } from '../../lib/useTokenizer.ts';
import type { StreamStore } from '../chat/state/streamStore.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { CocreatorSaveQueue } from './cocreatorPersistence.ts';
import { buildDesignPrompt } from './prompt.ts';
import { resolveCocreatorSettings } from './settings.ts';
import {
  type CocreatorAction,
  type CocreatorState,
  cocreatorReducer,
  initialCocreatorState,
  toPersistedMessages,
} from './state/cocreatorReducer.ts';

const SAVE_DELAY_MS = 400;

/**
 * The reply budget when the chosen preset does not name one.
 *
 * Passed explicitly rather than left to `buildRequestBody`'s own `?? 300` fallback: 300
 * tokens truncates a description mid-sentence, and a later change to that default must not
 * silently start cutting design replies in half.
 */
const DEFAULT_MAX_TOKENS = 1024;

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
  streamingFps: number;
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
    streamingFps,
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
  const countTokens = useTokenizer(connection?.model ?? '', tokenizerEncoding);
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
  // reset the transcript out from under an edit typed while a save was in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the session id only
  useEffect(() => {
    dispatch({ type: 'session/loaded', session });
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

  const captureSnapshot = useCallback((current: CocreatorState): CocreatorSaveSnapshot | null => {
    if (!current.sessionId) return null;
    return {
      sessionId: current.sessionId,
      revision: current.revision,
      title: current.title,
      stash: current.stash,
      examples: current.examples,
      settings: current.settings,
      // The pre-generation projection: a blank placeholder or a tentative swipe is UI state
      // until the request settles, and must not become durable under the earlier revision.
      messages: toPersistedMessages(current),
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
      const current = base ?? stateRef.current;
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

  const generate = useCallback(
    async (mode: 'send' | 'swipe', base?: CocreatorState) => {
      const current = base ?? stateRef.current;
      if (current.status !== 'idle') return;
      if (!connection || !preset) return;

      // Settings can change mid-generation. Keep the request body, the reply's recorded
      // metadata and the server-side connection lookup on one snapshot for the whole call.
      const requestConnection: Connection = { ...connection };

      const startAction: CocreatorAction = {
        type: 'gen/started',
        mode,
        newId: crypto.randomUUID(),
      };
      const started = cocreatorReducer(current, startAction);
      dispatch(startAction);

      // The reducer refuses some starts outright — re-rolling with nothing to re-roll.
      if (started.status === 'idle' || !started.streamingId) return;

      const controller = new AbortController();
      abortRef.current = controller;

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

      try {
        const maxTokens = preset.openai_max_tokens ?? DEFAULT_MAX_TOKENS;
        const prompt = buildDesignPrompt({
          systemPrompt,
          exampleBlock: exampleBlockRef.current,
          messages: started.messages,
          countTokens,
          maxPromptTokens: (preset.openai_max_context ?? 4095) - maxTokens,
        });

        if (prompt.fixedOverflow) {
          dispatch({
            type: 'gen/failed',
            message:
              'The system prompt and attached examples alone exceed the context budget. ' +
              'Detach an example, turn off some example fields, or raise the context size.',
          });
          return;
        }

        const streamed = preset.stream_openai !== false;
        const body = buildRequestBody({
          messages: prompt.messages,
          preset,
          connection: requestConnection,
          stream: streamed,
          maxTokens,
        });

        if (!ensureActive()) return;

        stream.begin('', streamed);
        streamStarted = true;

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
          '',
          requestConnection.id,
        );

        // A non-streaming response can resolve in the same turn as an abort, so ownership is
        // checked after the await as well as inside the callbacks.
        if (!ensureActive()) return;
        endStream();

        dispatch({
          type: 'gen/finished',
          text: final.content,
          extra: {
            api: requestConnection.provider,
            // Recorded per swipe, so a card assembled across three model swaps can still
            // say which one wrote each line.
            model: final.model ?? requestConnection.model,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            token_count: final.usage?.completion_tokens ?? countTokens.countText(final.content),
          },
        });
      } catch (error) {
        if (ownsGeneration()) endStream();
        // Whatever arrived before the failure is kept.
        if (ownsGeneration() && controller.signal.aborted) {
          dispatch({ type: 'gen/aborted', text, reasoning });
        } else if (ownsGeneration()) {
          dispatch({ type: 'gen/failed', message: (error as Error).message, text, reasoning });
        }
      } finally {
        // An old request may settle after a newer generation replaced the ref. It must not
        // clear that controller or stop its stream.
        if (abortRef.current === controller) {
          endStream();
          abortRef.current = null;
        }
      }
    },
    [connection, preset, systemPrompt, exampleBlockRef, countTokens, stream],
  );

  const send = useCallback(
    async (text: string, extra?: MessageExtra) => {
      const trimmed = text.trim();
      if (!trimmed || stateRef.current.status !== 'idle') return;

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
    [generate],
  );

  const reroll = useCallback(async () => {
    await generate('swipe');
  }, [generate]);

  // A design session is worth more than a chat turn, so an unload attempts the save too.
  useEffect(() => {
    const onPagehide = () => {
      const snapshot = captureSnapshot(stateRef.current);
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
    abort,
    flushSaves,
    persistence: persistenceControls,
    connection,
    presetId: resolved.presetId,
    preset,
    systemPrompt,
    analysisPrompt: resolved.analysisPrompt,
    countTokens,
  };
}
