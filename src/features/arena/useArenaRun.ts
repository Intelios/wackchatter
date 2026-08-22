/**
 * The parallel generation engine.
 *
 * One scene, assembled exactly once, sent to every column. That single assembly is the
 * fairness invariant the whole sub-app rests on: identical history packing, identical World
 * Info draws, identical `{{random}}` and `{{pick}}` rolls. Assembling per contender would
 * hand one of them a different set of facts and call the difference a model comparison.
 *
 * The assembled messages are cached per run, so re-rolling one column answers the *same*
 * prompt the other column answered rather than a freshly re-rolled one.
 *
 * Ownership discipline is `useCocreator.generate`'s, widened from one request to several:
 * a live `AbortController` is the token, membership of `controllers` is what makes a late
 * callback inert, and the reducer's per-entry `attempt` counter is the second gate — the
 * one that stops an abandoned re-roll overwriting the reply the user asked for.
 */

import { assemblePrompt } from '@shared/prompt/assemble.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { Contender } from '@shared/types/arena.ts';
import { ARENA_MAX_COLUMNS } from '@shared/types/arena.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ApiMessage, MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { streamGenerate } from '../../lib/api.ts';
import type { StreamStore } from '../chat/state/streamStore.ts';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';
import { contenderLabel } from './contenders.ts';
import { buildScene, sceneSeedId } from './scene.ts';
import { type ArenaState, arenaReducer, initialArenaState, isBusy } from './state/arenaReducer.ts';

/** The reply budget when the chosen preset does not name one. */
const DEFAULT_MAX_TOKENS = 400;

export interface RunColumnRequest {
  contender: Contender;
  /** Already resolved — the connection with this contender's model applied. */
  connection: Connection;
}

export interface StartRunRequest {
  runId: string;
  characterId: string;
  card: CardDataV2;
  probe: string;
  columns: readonly RunColumnRequest[];
  /** Lore for this card, resolved by the caller — see `useLorebooks().pending`. */
  worldInfoSources: WorldInfoSource[];
  /** Drop the earlier log first. The blind round sets this; the Arena stacks instead. */
  replace?: boolean;
}

/**
 * Everything a run needs after it has started: the prompt every column answered, and the
 * endpoint each one answered it on. Held together so a re-roll needs nothing from the
 * caller, and so pruning a run cannot leave half of it behind.
 */
interface RunContext {
  messages: ApiMessage[];
  columns: RunColumnRequest[];
}

export interface UseArenaRunOptions {
  preset: Preset | null;
  persona: Persona | null;
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  countTokens: TokenCounter;
  streamingFps: number;
  /**
   * Ask the provider to stream.
   *
   * A held blind round still streams: holding is a rendering decision, and streaming keeps
   * partial text recoverable when a round is stopped half-way.
   */
  streaming: boolean;
}

export interface UseArenaRun {
  state: ArenaState;
  /** One store per column index, reused across runs. Only a live run writes to them. */
  streams: StreamStore[];
  busy: boolean;
  error: string | null;
  clearError: () => void;
  start: (request: StartRunRequest) => Promise<void>;
  /** Re-roll one column against the run's cached prompt. */
  rerollColumn: (runId: string, contenderId: string) => Promise<void>;
  abort: () => void;
  removeRun: (runId: string) => void;
  clear: () => void;
}

export function useArenaRun(options: UseArenaRunOptions): UseArenaRun {
  const {
    preset,
    persona,
    worldInfoSettings,
    globalVariables,
    regexScripts,
    countTokens,
    streamingFps,
    streaming,
  } = options;

  const [state, dispatch] = useReducer(arenaReducer, initialArenaState);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Live requests. A controller stays a member until its own `finally` removes it.
   *
   * Membership is half the ownership token; `disposed` is the other half. Note what Stop
   * must NOT do: revoke ownership. An aborted request has to survive long enough to
   * dispatch `entry/aborted` — revoking first means the catch block returns early, the
   * column sits at `streaming` forever, and the whole Arena is wedged behind a run that
   * can never settle. Ownership is ended by the hook going away, not by stopping a reply.
   */
  const controllers = useRef(new Set<AbortController>());

  /** The hook has unmounted. Every late callback is inert from here on. */
  const disposed = useRef(false);

  /** Per-run prompt and endpoints, by run id. Pruned with the run. */
  const contexts = useRef(new Map<string, RunContext>());

  // Recreated only when the rate changes, so a running stream keeps its store. Every column
  // slot is allocated up front — four idle stores cost nothing, and the alternative is
  // rebuilding them mid-run whenever the column count changes.
  const streams = useMemo(
    () => Array.from({ length: ARENA_MAX_COLUMNS }, () => createStreamStore(streamingFps)),
    [streamingFps],
  );

  const abort = useCallback(() => {
    // Copied first: aborting synchronously reaches the `finally` that mutates the set.
    for (const controller of [...controllers.current]) controller.abort();
  }, []);

  /*
   * Leaving the Arena must not leave requests writing into a log nobody is looking at.
   *
   * The flag is cleared on the way IN as well as set on the way out. React's StrictMode
   * mounts, tears down and remounts in development, so a cleanup that only ever sets it
   * would leave the second mount permanently disposed — every request unowned from birth,
   * every column stuck at `pending`, and the Arena silently dead. A remount has to be a
   * working mount.
   */
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      for (const controller of [...controllers.current]) controller.abort();
      controllers.current.clear();
    };
  }, []);

  /**
   * Run one column to completion.
   *
   * Every dispatch is gated on still owning the request and carries the attempt it belongs
   * to. The two gates cover different failures: `owns` catches a run the user walked away
   * from, `attempt` catches a re-roll whose predecessor is still in flight.
   */
  const runColumn = useCallback(
    async (
      runId: string,
      columnIndex: number,
      column: RunColumnRequest,
      attempt: number,
      messages: ApiMessage[],
      activePreset: Preset,
    ): Promise<void> => {
      const controller = new AbortController();
      controllers.current.add(controller);
      const owns = () => !disposed.current && controllers.current.has(controller);

      const store = streams[columnIndex];
      const startedAt = performance.now();
      const since = () => Math.round(performance.now() - startedAt);
      const contenderId = column.contender.id;

      let streamStarted = false;
      const endStream = () => {
        if (!streamStarted) return;
        store?.end();
        streamStarted = false;
      };

      // Empty until the stream starts, so a failure on the way to the provider settles as
      // "nothing came back" rather than as a truncated reply.
      let text = '';
      let reasoning = '';

      try {
        const body = buildRequestBody({
          messages,
          preset: activePreset,
          connection: column.connection,
          stream: streaming,
          maxTokens: activePreset.openai_max_tokens ?? DEFAULT_MAX_TOKENS,
        });

        if (!owns()) return;
        store?.begin('', streaming);
        streamStarted = true;

        const final = await streamGenerate(
          body,
          controller.signal,
          {
            onFirstToken: () => {
              if (!owns() || controller.signal.aborted) return;
              dispatch({ type: 'entry/streaming', runId, contenderId, attempt, ms: since() });
            },
            onTick: (streamState) => {
              if (!owns() || controller.signal.aborted) return;
              text = streamState.content;
              reasoning = streamState.reasoning;
              store?.set(streamState.content, streamState.reasoning);
            },
          },
          '',
          column.connection.id,
        );

        // A non-streamed response can resolve in the same turn as an abort, so ownership is
        // rechecked after the await as well as inside the callbacks.
        if (!owns()) return;
        endStream();

        dispatch({
          type: 'entry/settled',
          runId,
          contenderId,
          attempt,
          text: final.content,
          reasoning: final.reasoning,
          model: final.model,
          completionTokens: final.usage?.completion_tokens ?? countTokens.countText(final.content),
          ms: since(),
        });
      } catch (err) {
        if (!owns()) return;
        endStream();
        // Whatever arrived before the failure is kept: a truncated reply still says
        // something about the model, and about where it broke.
        dispatch(
          controller.signal.aborted
            ? { type: 'entry/aborted', runId, contenderId, attempt, text, reasoning, ms: since() }
            : {
                type: 'entry/failed',
                runId,
                contenderId,
                attempt,
                message: (err as Error).message,
                text,
                reasoning,
                ms: since(),
              },
        );
      } finally {
        endStream();
        controllers.current.delete(controller);
      }
    },
    [countTokens, streaming, streams],
  );

  const start = useCallback(
    async (request: StartRunRequest) => {
      if (isBusy(stateRef.current)) return;
      if (!preset) {
        setError('No preset is loaded.');
        return;
      }
      if (request.columns.length === 0) {
        setError('Nothing to compare — choose at least two contenders.');
        return;
      }

      setError(null);

      const messages = buildScene({
        card: request.card,
        probe: request.probe,
        personaId: persona?.id ?? null,
      });

      // A stand-in chat id: stable per card, so a re-run draws the same lore and the
      // comparison stays about the models rather than about which facts each run saw.
      const seed = sceneSeedId(request.characterId);

      const lore = worldInfoForChat({
        sources: request.worldInfoSources,
        messages,
        settings: worldInfoSettings,
        preset,
        chatId: seed,
        countTokens,
      });

      /*
       * Assembled ONCE, here, and shared by every column. This is the fairness invariant —
       * read the file header before moving it inside the loop.
       */
      const assembled = assemblePrompt({
        preset,
        character: request.card,
        persona,
        messages,
        worldInfoBefore: lore?.before,
        worldInfoAfter: lore?.after,
        worldInfoDepth: lore?.depth,
        globalVariables,
        countTokens,
        seed,
        // The fourth caller. All of them must pass the same list, or the Prompt Manager's
        // counts and the inspector quietly disagree with what actually shipped.
        regexScripts,
      });

      if (!assembled.ok) {
        setError(
          `Context overflow: mandatory prompt content needs ${assembled.error.requiredPromptTokens} tokens, ` +
            `but only ${assembled.error.maxContext - assembled.error.reservedCompletionTokens} are available.`,
        );
        return;
      }

      const columns = [...request.columns];
      contexts.current.set(request.runId, { messages: assembled.messages, columns });

      dispatch({
        type: 'run/started',
        runId: request.runId,
        characterId: request.characterId,
        probe: request.probe,
        at: Date.now(),
        replace: request.replace,
        entries: columns.map((column) => ({
          contenderId: column.contender.id,
          name: contenderLabel(column.contender, column.connection),
          model: column.connection.model,
          provider: column.connection.provider,
        })),
      });

      if (request.replace) {
        // The blind round keeps one run; a context for a discarded one is dead weight.
        for (const key of [...contexts.current.keys()]) {
          if (key !== request.runId) contexts.current.delete(key);
        }
      }

      // allSettled, not all: one column failing must not cancel the others, and every
      // column already reports its own failure through the reducer.
      await Promise.allSettled(
        columns.map((column, index) =>
          runColumn(request.runId, index, column, 0, assembled.messages, preset),
        ),
      );
    },
    [countTokens, globalVariables, persona, preset, regexScripts, runColumn, worldInfoSettings],
  );

  const rerollColumn = useCallback(
    async (runId: string, contenderId: string) => {
      if (isBusy(stateRef.current) || !preset) return;

      const context = contexts.current.get(runId);
      const run = stateRef.current.runs.find((entry) => entry.id === runId);
      if (!context || !run) return;

      const columnIndex = run.entries.findIndex((entry) => entry.contenderId === contenderId);
      const column = context.columns.find((entry) => entry.contender.id === contenderId);
      if (columnIndex < 0 || !column) return;

      /*
       * Fold the restart through the reducer to learn the new attempt number rather than
       * computing it here: `dispatch` does not update `stateRef` synchronously, so reading
       * it back would give the pre-restart value and this request's own result would arrive
       * carrying a stale attempt — and be discarded as if it were the abandoned one.
       */
      const restart = { type: 'entry/restarted', runId, contenderId } as const;
      const next = arenaReducer(stateRef.current, restart);
      dispatch(restart);

      const attempt = next.runs
        .find((entry) => entry.id === runId)
        ?.entries.find((entry) => entry.contenderId === contenderId)?.attempt;
      if (attempt === undefined) return;

      await runColumn(runId, columnIndex, column, attempt, context.messages, preset);
    },
    [preset, runColumn],
  );

  const removeRun = useCallback((runId: string) => {
    contexts.current.delete(runId);
    dispatch({ type: 'run/removed', runId });
  }, []);

  const clear = useCallback(() => {
    contexts.current.clear();
    dispatch({ type: 'log/cleared' });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    streams,
    busy: isBusy(state),
    error,
    clearError,
    start,
    rerollColumn,
    abort,
    removeRun,
    clear,
  };
}
