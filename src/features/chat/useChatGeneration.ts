/**
 * Everything that asks the chat model for text: replies, swipes, continues, guided replies,
 * impersonation and the recap — one generation at a time, through one `GenerationSlot`, so
 * they share a Stop.
 *
 * What to send and what to record are pure (`chatRequest.ts`); this owns the order things
 * happen in, which is load-bearing and documented at `generate`.
 */

import { buildRecapRequest } from '@shared/chat/recap.ts';
import type { NexusSettings } from '@shared/nexus/types.ts';
import { DEFAULT_USER_NAME } from '@shared/prompt/assemble.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { resolveOutgoingMacros } from '@shared/prompt/outgoing.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { buildRequestBody } from '@shared/providers/request.ts';
import { responseReserve } from '@shared/providers/responseLength.ts';
import { isLengthCutoff } from '@shared/providers/sse.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { MacroVariableMap } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { GuidanceSettings, MemoryMode, SummarySettings } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { useCallback, useState } from 'react';
import { type GenerationSlot, runGeneration } from '../../lib/generation.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';
import type { NexusController } from '../nexus/useNexus.ts';
import { continueSeed, prepareChatRequest, recordReply } from './chatRequest.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  type GenMode,
  toChatMessages,
} from './state/chatReducer.ts';
import type { StreamStore } from './state/streamStore.ts';
import { markStream, settleTrace, type TraceMarks } from './trace.ts';
import type { ChatSession } from './useChatSession.ts';

/**
 * Where a "Previously on…" recap's text goes.
 *
 * The recap has no transcript home, so — like `impersonate`'s `onText` — the result is
 * handed back through callbacks instead of a reducer dispatch. `onDone` fires once for the
 * run that was started, after the reducer has settled, so the overlay can leave its
 * streaming state on every outcome including a stop that produced nothing.
 */
export interface RecapHandlers {
  /** The settled text, or the partial text of a stopped or failed attempt. */
  onText?: (text: string) => void;
  /** How much of a long chat had to be dropped to fit the declared context. */
  onMeta?: (meta: { dropped: number; total: number }) => void;
  /** The run produced nothing. The reason, for the overlay. */
  onError?: (message: string) => void;
  /** The run is over, whatever the outcome. */
  onDone?: () => void;
}

export interface ChatGenerationOptions {
  session: ChatSession;
  /** Shared by replies, impersonation and the recap: one Stop for all of them. */
  slot: GenerationSlot;
  /** A summary run in flight blocks generating, and the other way round. */
  summaryBusy: () => boolean;
  stream: StreamStore;
  nexus: Pick<NexusController, 'preview' | 'setRecall' | 'consume' | 'stageForSend'>;
  characterId: string | null;
  character: CardDataV2 | null;
  preset: Preset | null;
  presetId?: string | null;
  connection: ResolvedModel | null;
  countTokens: TokenCounter;
  worldInfoSources?: WorldInfoSource[];
  resolveWorldInfoSources?: (personaLorebookId?: string) => WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  guidanceSettings?: GuidanceSettings;
  summarySettings?: SummarySettings;
  memoryMode: MemoryMode;
  nexusSettings: NexusSettings;
  globalVariables: MacroVariableMap;
  regexScripts?: readonly RegexScript[];
  onGlobalVariablesChange: (variables: MacroVariableMap) => Promise<void>;
}

export function useChatGeneration(options: ChatGenerationOptions) {
  const {
    session,
    slot,
    summaryBusy,
    stream,
    nexus,
    characterId,
    character,
    preset,
    presetId,
    connection,
    countTokens,
    worldInfoSources,
    resolveWorldInfoSources,
    worldInfoSettings,
    guidanceSettings,
    summarySettings,
    memoryMode,
    nexusSettings,
    globalVariables,
    regexScripts,
    onGlobalVariablesChange,
  } = options;
  const { dispatch, stateRef, persona, refreshChats } = session;
  const { preview: prepareNexus, setRecall: setNexusRecall, consume: consumeNexus } = nexus;
  const { stageForSend } = nexus;

  /** The last generation's lore, with the chat it belongs to, so another chat never shows it. */
  const [worldInfo, setWorldInfo] = useState<{
    chatId: string | null;
    result: ActivationResult;
  } | null>(null);

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
   * Everything after `gen/started` runs inside one try/finally, and the slot is claimed
   * before any of it. Both are for the same reason: from the moment the reducer says "busy"
   * the UI shows Stop, and a throw on the way to the provider — assembly, a tokenizer, a
   * failed settings write — must not leave the chat busy forever with a Stop button wired
   * to nothing. SillyTavern arms its controller at the top of Generate() for the same reason.
   *
   * @param base The state to build on, when the caller has already folded an action into it
   *   (as `send` does with the user's message).
   * @param onText Impersonate only: handed the text the model wrote, before the terminal
   *   dispatch so the composer commits it in the same render that clears the busy state. A
   *   stopped or failed attempt passes whatever arrived first; nothing arrived means it is
   *   not called, and the draft the user already had is left untouched.
   */
  const generate = useCallback(
    async (mode: GenMode, base?: ChatState, guidance?: string, onText?: (text: string) => void) => {
      const current = base ?? stateRef.current;
      if (current.status !== 'idle' || summaryBusy()) return;
      if (!character || !preset || !connection) return;
      const isImpersonation = mode === 'impersonate';

      // Settings can change while the prompt is being assembled or global variables are
      // persisted. Keep the request body, reply metadata, and server-side connection lookup
      // on the same snapshot for the entire generation.
      const model: ResolvedModel = { ...connection };

      const startAction: ChatAction = {
        type: 'gen/started',
        mode,
        newId: crypto.randomUUID(),
        name: character.name,
      };
      const started = chatReducer(current, startAction);
      dispatch(startAction);
      // The reply's timeline starts here: everything up to the request is building it.
      const marks: TraceMarks = { start: performance.now() };

      // The reducer refuses some starts outright — swiping with no reply to swipe. An
      // impersonation owns no message, so it is the one start with no `streamingId`.
      if (started.status === 'idle' || (!started.streamingId && !isImpersonation)) return;

      // The claim is also the ownership token: navigating to another chat, or a newer
      // generation replacing this one, makes every late callback from it inert.
      const claim = slot.claim(() => stateRef.current.chatId === started.chatId);
      // One identity for this attempt, settled before the request so every path out of it
      // — settled, stopped, failed — records the same one.
      const generationId = crypto.randomUUID();
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
        const seed = continueSeed(mode, target, preset);
        const chatMessages = toChatMessages(started);

        // Activation runs over the state that already contains the folded user message, so
        // the message just typed is in the scan buffer for the reply it triggers.
        const loreStart = performance.now();
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
        setWorldInfo(lore ? { chatId: started.chatId ?? null, result: lore } : null);
        if (lore) {
          marks.lore = { ms: performance.now() - loreStart, fired: lore.activated.length };
        }

        // Recall runs over the same post-fold transcript, so a record keyed on a word in the
        // message just typed fires for the reply it triggered rather than the next one.
        const recallStart = performance.now();
        const recall =
          memoryMode === 'nexus'
            ? await prepareNexus(
                chatMessages,
                nexusSettings.budgetTokens,
                countTokens,
                'Request',
                claim.signal,
              )
            : undefined;
        if (memoryMode === 'nexus') {
          marks.memory = {
            ms: performance.now() - recallStart,
            recalled: recall?.hits.length ?? 0,
          };
        }

        const request = prepareChatRequest({
          mode,
          started,
          model,
          preset,
          character,
          persona,
          lore,
          nexusRecall: recall,
          memoryMode,
          nexusSettings,
          summarySettings,
          guidance,
          guidanceSettings,
          globalVariables,
          countTokens,
          regexScripts,
          generationId,
        });
        dispatch({ type: 'gen/inspected', inspection: request.inspection });
        if (!request.ok) {
          dispatch({
            type: 'gen/traced',
            generationId,
            trace: settleTrace(marks, performance.now(), 'failed'),
            failure: request.message,
          });
          dispatch({ type: 'gen/failed', message: request.message });
          return;
        }
        const { assembled, body, completions, streamed, nexusRecall } = request;

        // Macro effects are committed once, after the complete request exists and immediately
        // before the provider is contacted. Preview assembly receives the same inputs and
        // discards this result, so opening Prompt Manager cannot mutate either scope. A later
        // provider failure deliberately does not roll these back.
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
        if (!claim.ensureActive()) return;

        if (nexusRecall) {
          setNexusRecall(nexusRecall);
          consumeNexus();
        }
        stream.begin(seed, streamed);
        streamStarted = true;
        text = seed;

        marks.sent = performance.now();
        const final = await runGeneration({
          model,
          body,
          signal: claim.signal,
          seed,
          usage: {
            // Tagged apart in the usage log: an impersonation is still a paid chat
            // generation, but it produced no swipe and should not be counted as a reply.
            feature: isImpersonation ? 'impersonate' : 'chat',
            generationId,
            ...(started.chatId ? { sessionId: started.chatId } : {}),
            ...(characterId ? { character: characterId } : {}),
            countText: countTokens.countText,
          },
          onFirstToken: () => {
            if (claim.live()) dispatch({ type: 'gen/streaming' });
          },
          onTick: (streamState) => {
            if (!claim.live()) return;
            markStream(marks, performance.now(), streamState, seed);
            text = streamState.content;
            reasoning = streamState.reasoning;
            stream.set(streamState.content, streamState.reasoning);
          },
        });

        // A non-streaming response can resolve in the same turn as an abort, so check
        // ownership after the await as well as in the streaming callbacks.
        if (!claim.ensureActive()) return;
        endStream();

        const trace = settleTrace(
          marks,
          performance.now(),
          isLengthCutoff(final.finishReason) ? 'length' : 'finished',
          final.usage,
        );
        dispatch({ type: 'gen/traced', generationId, trace });
        const recorded = recordReply({
          final,
          model,
          presetId,
          nexusRecall,
          generationId,
          completions,
          countText: countTokens.countText,
        });
        // The spare completions came from the same request, so they share its timeline.
        const extra = { ...recorded.extra, trace };
        const alternates = recorded.alternates.map((alternate) => ({
          ...alternate,
          extra: { ...alternate.extra, trace },
        }));

        // Hand the composer its text before the dispatch, so both land in one render: the
        // busy state clears and the draft already holds what the model wrote. An empty
        // completion is not a message — the user's existing draft stays untouched.
        if (isImpersonation && final.content.trim()) onText?.(final.content);

        dispatch({
          type: 'gen/finished',
          text: final.content,
          // The provider's own verdict on how the reply ended. 'length' becomes the truncated
          // badge in the reducer; a Stop click or a failure marks its own.
          finishReason: final.finishReason,
          extra,
          alternates,
        });
      } catch (error) {
        if (claim.owns()) endStream();
        // Whatever arrived before a stop or a failure is the user's message so far —
        // SillyTavern leaves it in the box too, so a stopped impersonation is editable rather
        // than lost. Nothing arrived means nothing is delivered.
        if (isImpersonation && claim.owns() && text.trim()) onText?.(text);
        // Whatever arrived before the failure is kept, as SillyTavern does.
        if (claim.owns()) {
          const stopped = claim.signal.aborted;
          const message = (error as Error).message;
          const trace = settleTrace(marks, performance.now(), stopped ? 'stopped' : 'failed');
          dispatch({
            type: 'gen/traced',
            generationId,
            trace,
            ...(stopped ? {} : { failure: message }),
          });
          if (stopped) dispatch({ type: 'gen/aborted', text, reasoning, generationId, trace });
          else dispatch({ type: 'gen/failed', generationId, message, text, reasoning, trace });
        }
      } finally {
        // An old request may settle after a newer generation has replaced it. It must not
        // free that one's slot, stop its stream, or refresh the newer chat's list.
        if (claim.release()) {
          endStream();
          if (stateRef.current.chatId === started.chatId) void refreshChats();
        }
      }
    },
    [
      character,
      characterId,
      preset,
      presetId,
      persona,
      connection,
      countTokens,
      stream,
      slot,
      summaryBusy,
      dispatch,
      stateRef,
      refreshChats,
      worldInfoSources,
      resolveWorldInfoSources,
      worldInfoSettings,
      guidanceSettings,
      summarySettings,
      memoryMode,
      nexusSettings,
      prepareNexus,
      setNexusRecall,
      consumeNexus,
      globalVariables,
      regexScripts,
      onGlobalVariablesChange,
    ],
  );

  /**
   * Resolve macros in something the user just typed, and commit what they did.
   *
   * The composer's one macro chokepoint: a draft passes through here on its way to becoming
   * a message or a guidance instruction, and never again. Assembly re-substitutes stored
   * text on every request, so a `{{roll:1d20}}` left in the transcript is a fresh number in
   * every swipe with nothing on screen to say which one shipped. Resolving once makes it a
   * fact about the turn. This is SillyTavern's `sendMessageAsUser`.
   *
   * Returns the resolved text and the state to assemble from — folded rather than read back
   * from `stateRef`, because a variable write dispatched here has not re-rendered yet and
   * assembly would otherwise read the values from before the turn.
   */
  const resolveDraft = useCallback(
    async (text: string): Promise<{ text: string; state: ChatState }> => {
      const current = stateRef.current;
      // Half-resolved is worse than raw: without a character there is no {{char}} to expand.
      if (!character || !preset) return { text, state: current };

      const resolved = resolveOutgoingMacros(text, {
        character,
        preset,
        persona,
        messages: toChatMessages(current),
        metadata: current.metadata,
        globalVariables,
        seed: current.chatId ?? '',
      });

      let next = current;
      if (resolved.localChanged) {
        const action: ChatAction = {
          type: 'chat/metadata',
          patch: { variables: resolved.local },
        };
        dispatch(action);
        next = chatReducer(next, action);
      }
      if (resolved.globalChanged) await onGlobalVariablesChange(resolved.global);

      return { text: resolved.text, state: next };
    },
    [character, preset, persona, globalVariables, onGlobalVariablesChange, dispatch, stateRef],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || stateRef.current.status !== 'idle' || summaryBusy()) return;

      stageForSend();
      const draft = await resolveDraft(trimmed);
      const resolved = draft.text.trim();

      /*
       * A draft whose macros left nothing behind — `{{setvar::hp::10}}` on its own.
       *
       * The variables are already committed above, so the gesture worked; what is refused is
       * the empty bubble and the generation it would trigger. This is what makes the
       * composer a usable place to set a variable rather than only a place to say something.
       */
      if (!resolved) return;

      const userAction: ChatAction = {
        // The name becomes message.name, which names_behavior can put into the prompt text —
        // so it has to be the same name {{user}} expands to, not a friendlier label. See
        // DEFAULT_USER_NAME. The persona id is recorded the same way: the message keeps the
        // face it was spoken with.
        type: 'message/appendUser',
        id: crypto.randomUUID(),
        name: persona?.name ?? DEFAULT_USER_NAME,
        personaId: persona?.id ?? null,
        text: resolved,
      };

      dispatch(userAction);
      // Hand the folded state forward: the user's message must be in the history the reply
      // is assembled from, and dispatch has not re-rendered yet.
      await generate('send', chatReducer(draft.state, userAction));
    },
    [generate, persona, resolveDraft, stageForSend, summaryBusy, dispatch, stateRef],
  );

  /**
   * `/roll`'s write path: a message, with no reply asked for.
   *
   * Text that is already resolved — the command rolled the dice itself — so it does not go
   * back through `resolveDraft`. Not generating matches every other slash command, and a
   * transcript left on the user's turn already offers retry.
   */
  const appendUserMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || stateRef.current.status !== 'idle') return;
      dispatch({
        type: 'message/appendUser',
        id: crypto.randomUUID(),
        name: persona?.name ?? DEFAULT_USER_NAME,
        personaId: persona?.id ?? null,
        text: trimmed,
      });
    },
    [persona, dispatch, stateRef],
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
    [generate, dispatch, stateRef],
  );

  /*
   * The scenario list's pick: a jump rather than a step, and only ever into swipes that
   * already exist — generating is the chevrons' job, not the popover's.
   *
   * Same-index is refused here rather than left to the reducer, which bumps the revision
   * unconditionally: a no-op pick would schedule a save for a chat that did not change.
   */
  const swipeTo = useCallback(
    (id: string, index: number) => {
      const current = stateRef.current;
      if (current.status !== 'idle') return;

      const target = current.messages.find((m) => m.id === id);
      if (!target || index < 0 || index >= target.swipes.length || index === target.swipe_id) {
        return;
      }

      dispatch({ type: 'swipe/select', id, index });
    },
    [dispatch, stateRef],
  );

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
   *
   * Guidance is typed in the same composer, so it resolves in the same place. This does not
   * weaken assembly's rule that macros inside `{{input}}` stay literal — that rule is what
   * stops one pass from becoming two. The text simply arrives already resolved.
   */
  const guidedRespond = useCallback(
    async (guidance: string) => {
      if (!guidance.trim() || stateRef.current.status !== 'idle') return;
      const draft = await resolveDraft(guidance);
      if (!draft.text.trim()) return;
      await generate('send', draft.state, draft.text);
    },
    [generate, resolveDraft, stateRef],
  );

  const guidedSwipe = useCallback(
    async (guidance: string) => {
      if (!guidance.trim() || stateRef.current.status !== 'idle') return;
      const draft = await resolveDraft(guidance);
      if (!draft.text.trim()) return;
      await generate('swipe', draft.state, draft.text);
    },
    [generate, resolveDraft, stateRef],
  );

  /**
   * Write the user's next message with the model — SillyTavern's Impersonate.
   *
   * The text belongs to the composer, never the transcript: this runs `generate` in mode
   * `impersonate`, which owns no message, and hands the finished text to `onText` so the
   * caller can put it in the draft for the user to edit and send.
   *
   * `instruction` is optional steering and rides the same one-shot guidance injection a
   * guided reply uses — resolved once at the composer chokepoint, so a macro becomes a fact
   * about this turn instead of being re-rolled later. It is the equivalent of the prompt
   * SillyTavern's `/impersonate <prompt>` passes along.
   */
  const impersonate = useCallback(
    async (instruction?: string, onText?: (text: string) => void) => {
      if (stateRef.current.status !== 'idle' || summaryBusy()) return;
      if (!character || !preset || !connection) return;
      const steer = instruction?.trim();
      const draft = steer ? await resolveDraft(steer) : null;
      await generate('impersonate', draft?.state, draft?.text, onText);
    },
    [character, preset, connection, generate, resolveDraft, summaryBusy, stateRef],
  );

  /**
   * "Previously on…": a recap of the visible transcript, read in an overlay.
   *
   * Deliberately not routed through `generate`. That path exists to assemble a *chat turn*
   * — preset prompts, card, persona, lore, memory, macros — and the recap's whole premise is
   * that none of it is in the request. So the prompt is built by hand in
   * `shared/chat/recap.ts` and the body assembled from a default preset: the same shape as
   * persona derivation, which bypasses assembly for the same reason.
   *
   * It does borrow impersonation's reducer contract — `gen/started` with no transcript home,
   * so `streamingId` stays null and every settle path clears the status without touching a
   * message. The mode is the mechanism, not the meaning: the result goes to the overlay
   * through `handlers.onText` and the usage log tags it `recap`, so nothing else has to know
   * a second home-less mode exists.
   */
  const recap = useCallback(
    async (handlers?: RecapHandlers) => {
      const current = stateRef.current;
      // Every bail still reports back: the caller has already opened its overlay in the
      // `active` shape, and a refusal with no `onDone` would leave it waiting forever.
      const refuse = (reason: string) => {
        handlers?.onError?.(reason);
        handlers?.onDone?.();
      };

      if (current.status !== 'idle' || summaryBusy()) {
        refuse('Wait for the current reply to finish.');
        return;
      }
      if (!current.chatId || !character || !preset || !connection) {
        refuse('Open a chat and choose a chat model before asking for a recap.');
        return;
      }

      // Snapshot the model like `generate` does: settings can change while the prompt is
      // being built, and a body and its server-side key lookup must agree on one.
      const model: ResolvedModel = { ...connection };

      const startAction: ChatAction = {
        type: 'gen/started',
        mode: 'impersonate',
        newId: crypto.randomUUID(),
        name: character.name,
      };
      const started = chatReducer(current, startAction);
      if (started.status === 'idle') {
        refuse('Wait for the current reply to finish.');
        return;
      }

      // Room kept free for the recap; never sent as a cap (the recap preset is unlimited).
      const maxTokens = responseReserve(preset);
      const built = buildRecapRequest({
        messages: toChatMessages(started),
        counter: countTokens,
        maxContext: preset.openai_max_context ?? 4095,
        maxTokens,
      });

      // Nothing visible to recap, or an instruction that cannot fit the declared context.
      // Both are settled with a reason rather than sent: a paid request whose only possible
      // answer is "there is nothing here" is worse than saying so. Decided before the
      // `gen/started` dispatch — a refusal dispatches nothing, so it must not enter the
      // connecting state first: nothing would settle it, and the slot is claimed only once
      // the request is really sent, so Stop could not either.
      if (!built.total) {
        refuse('This chat has nothing to recap yet.');
        return;
      }
      if (!built.fits) {
        refuse(
          "The recap does not fit in the chat model's context. Increase the context size in the preset.",
        );
        return;
      }

      dispatch(startAction);
      handlers?.onMeta?.({ dropped: built.dropped, total: built.total });

      const claim = slot.claim(() => stateRef.current.chatId === started.chatId);
      const generationId = crypto.randomUUID();
      let streamStarted = false;
      let text = '';
      const streamed = preset.stream_openai !== false;
      // Default samplers, with only the declared context and the streaming preference carried
      // over. Temperature, seed and `n` belong to writing a reply; a recap is a reading, and
      // `completions: 1` below forces a single take regardless of `preset.n`.
      const recapPreset: Preset = {
        ...createDefaultPreset(),
        openai_max_context: preset.openai_max_context ?? 4095,
        openai_max_tokens: maxTokens,
        stream_openai: streamed,
      };

      try {
        const body = buildRequestBody({
          messages: built.messages,
          preset: recapPreset,
          connection: model,
          stream: streamed,
          completions: 1,
        });

        stream.begin('', streamed);
        streamStarted = true;

        const final = await runGeneration({
          model,
          body,
          signal: claim.signal,
          usage: {
            feature: 'recap',
            generationId,
            ...(started.chatId ? { sessionId: started.chatId } : {}),
            ...(characterId ? { character: characterId } : {}),
            countText: countTokens.countText,
          },
          onFirstToken: () => {
            if (claim.live()) dispatch({ type: 'gen/streaming' });
          },
          onTick: (streamState) => {
            if (!claim.live()) return;
            text = streamState.content;
            stream.set(streamState.content, streamState.reasoning);
          },
        });

        if (!claim.ensureActive()) return;
        stream.end();
        streamStarted = false;

        // The same partial-text rule as impersonation: anything the model produced is the
        // user's result. Nothing produced means `onError` is not raised either — an empty
        // completion settles as "came back empty" in the overlay, not as a failure.
        if (final.content.trim()) handlers?.onText?.(final.content);

        // The extra is carried for the reducer's contract, not persisted: settle returns
        // early on the null `streamingId` and writes nothing.
        dispatch({
          type: 'gen/finished',
          text: final.content,
          finishReason: final.finishReason,
          extra: {
            model: final.model ?? model.model,
            connection_id: model.id,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
          },
        });
      } catch (error) {
        if (claim.owns()) {
          stream.end();
          streamStarted = false;
        }
        // A stopped recap keeps whatever arrived, exactly as a stopped impersonation does.
        if (claim.owns() && text.trim()) handlers?.onText?.(text);
        if (claim.owns() && claim.signal.aborted) {
          dispatch({ type: 'gen/aborted', text, generationId });
        } else if (claim.owns()) {
          const message = (error as Error).message;
          dispatch({ type: 'gen/failed', generationId, message, text });
          // Partial text is the user's result and speaks for itself; with nothing on screen
          // the failure is the only thing there is to show.
          if (!text.trim()) handlers?.onError?.(message);
        }
      } finally {
        // Only the run that still holds the slot cleans up and reports back. A stale run
        // left behind by navigation must not settle the overlay the new chat is showing.
        const stillHeld = claim.release();
        if (stillHeld && streamStarted) stream.end();
        if (stillHeld && stateRef.current.chatId === started.chatId) handlers?.onDone?.();
      }
    },
    [
      character,
      characterId,
      preset,
      connection,
      countTokens,
      stream,
      slot,
      summaryBusy,
      dispatch,
      stateRef,
    ],
  );

  const abort = useCallback(() => {
    slot.abort();
    // Stop the shared display immediately. A pending throttled frame must not remain visible
    // while the next chat is being loaded; a later generation's begin() will own the store
    // again before it publishes new content.
    stream.end();
  }, [slot, stream]);

  return {
    worldInfo,
    send,
    appendUserMessage,
    regenerate,
    continueLast,
    swipe,
    swipeTo,
    guidedRespond,
    guidedSwipe,
    impersonate,
    recap,
    abort,
  };
}

export type ChatGeneration = ReturnType<typeof useChatGeneration>;
