/**
 * Chat orchestration, composed from four focused hooks:
 *
 *   - `useChatSession`    the chat's state, its saves, loading, the chat list and persona
 *   - `useChatGeneration` replies, swipes, guided replies, impersonation and the recap
 *   - `useChatSummary`    the Classic rolling summary
 *   - `useChatLifecycle`  opening, creating, reloading, renaming, deleting and branching
 *
 * plus Nexus (`useNexus`). This file only wires them together and keeps the one interface
 * the views consume. Replies and the recap share one `GenerationSlot` — one Stop — and the
 * summary has its own; neither starts while the other runs.
 *
 * Everything that mutates the transcript goes through the reducer; the streaming text goes
 * through the store and never touches React state.
 */

import { DEFAULT_NEXUS, type NexusSettings } from '@shared/nexus/types.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { RegexMacros } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type {
  ChatMessage,
  ChatMetadata,
  ChatSummary,
  MacroVariableMap,
  Persona,
} from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { GuidanceSettings, MemoryMode, SummarySettings } from '@shared/types/settings.ts';
import type { WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { GenerationSlot } from '../../lib/generation.ts';
import { type NexusController, useNexus } from '../nexus/useNexus.ts';
import type { ChatState, PromptInspection } from './state/chatReducer.ts';
import { createStreamStore, type StreamStore } from './state/streamStore.ts';
import { type RecapHandlers, useChatGeneration } from './useChatGeneration.ts';
import { useChatLifecycle } from './useChatLifecycle.ts';
import { useChatSession } from './useChatSession.ts';
import { type SummaryMode, type SummaryRunStatus, useChatSummary } from './useChatSummary.ts';

export type { RecapHandlers, SummaryMode, SummaryRunStatus };

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
  /** The `chat` slot's model, or null when it cannot run (the app shows why). */
  connection: ResolvedModel | null;
  countTokens: TokenCounter;
  streamingFps: number;
  /** Lorebooks that apply to this chat, already loaded. */
  worldInfoSources?: WorldInfoSource[];
  /** Resolve sources after this hook has selected the chat-scoped persona. */
  resolveWorldInfoSources?: (personaLorebookId?: string) => WorldInfoSource[];
  worldInfoSettings?: WorldInfoSettings;
  /** Template, depth and role for guided generations and persistent guides. */
  guidanceSettings?: GuidanceSettings;
  /** The `summary` slot's model and its model-specific counter. */
  summaryConnection?: ResolvedModel | null;
  /** Why the summary model cannot run, shown when someone asks for a summary anyway. */
  summaryBlockedReason?: string | null;
  summarySettings?: SummarySettings;
  summaryCountTokens?: TokenCounter;
  /** Which story-memory feature reaches the model on every generation. */
  memoryMode?: MemoryMode;
  nexusSettings?: NexusSettings;
  nexusConnection?: ResolvedModel | null;
  nexusCountTokens?: TokenCounter;
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
  nexus: NexusController;
  memoryMode: MemoryMode;
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
  /** Append a message and ask for nothing. `/roll`'s write path. */
  appendUserMessage(text: string): void;
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
  /**
   * Write the user's next message with the model, into the composer draft.
   *
   * Nothing reaches the transcript. `onText` receives the settled text — and the partial
   * text of a stopped or failed attempt — so the caller can place it in the field; it is
   * not called when no text arrived, leaving any existing draft untouched. `instruction`
   * is optional steering, injected exactly like a guided reply's guidance.
   */
  impersonate(instruction?: string, onText?: (text: string) => void): Promise<void>;
  /**
   * Write a "Previously on…" recap of the visible transcript.
   *
   * The request is built from the transcript alone — no preset prompts, card, persona,
   * lore or macros — and nothing reaches the transcript. Busy-gated against replies and
   * summaries, and stopped by the same `abort()`. `handlers.onText` receives the settled
   * text, or the partial text of a stopped attempt; the overlay owns where it is shown.
   */
  recap(handlers?: RecapHandlers): Promise<void>;
  abort(): void;

  summaryStatus: SummaryRunStatus;
  summaryPending: number;
  /** Summarised messages that have changed since they were summarised. */
  summaryChanged: number;
  summaryCovered: number;
  summaryCanUndo: boolean;
  summarize(settingsOverride?: SummarySettings, mode?: SummaryMode): Promise<void>;
  undoSummary(): void;
  /** Bring back an earlier version from the summary's history. */
  restoreSummary(index: number): void;
  cancelSummary(): void;
  editSummary(text: string): void;

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

export function useChat(options: UseChatOptions): UseChat {
  const {
    characterId,
    character,
    countTokens,
    streamingFps,
    memoryMode: defaultMemoryMode = 'classic',
    nexusSettings = DEFAULT_NEXUS,
  } = options;

  const session = useChatSession(options);
  const { state, stateRef, dispatch, persona, captureSnapshot, persistence } = session;
  const memoryMode = state.metadata.memoryMode ?? defaultMemoryMode;

  const stream = useMemo(() => createStreamStore(streamingFps), [streamingFps]);
  // Replies and the recap share one slot, so one Stop; the summary has its own.
  const [chatSlot] = useState(() => new GenerationSlot());
  const [summarySlot] = useState(() => new GenerationSlot());
  const summaryBusy = useCallback(() => summarySlot.busy, [summarySlot]);

  const nexus = useNexus({
    state,
    stateRef,
    dispatch,
    settings: nexusSettings,
    connection: options.nexusConnection ?? null,
    counter: options.nexusCountTokens ?? countTokens,
    enabled: memoryMode === 'nexus',
    profile: [character?.name, character?.description, persona?.name, persona?.description]
      .filter(Boolean)
      .join('\n'),
    captureSnapshot,
    persistence,
  });

  const generation = useChatGeneration({
    ...options,
    session,
    slot: chatSlot,
    summaryBusy,
    stream,
    nexus,
    memoryMode,
    nexusSettings,
  });

  const summary = useChatSummary({ ...options, session, slot: summarySlot, memoryMode });

  const lifecycle = useChatLifecycle({
    session,
    characterId,
    character,
    abort: generation.abort,
    cancelSummary: summary.cancelSummary,
  });

  // `chat/loaded` can arrive from a queued open or the character initialiser after the
  // caller has already moved on. Keep this as a second line of defence for transitions that
  // do not pass through one of the public chat-management callbacks.
  const { onChatChanged } = summary;
  useEffect(() => {
    chatSlot.abort();
    onChatChanged(state.chatId);
  }, [state.chatId, chatSlot, onChatChanged]);

  return {
    nexus,
    memoryMode,
    state,
    messages: session.messages,
    stream,
    inspection: state.inspections[0] ?? null,
    busy: state.status !== 'idle',
    generationBlocked: state.status !== 'idle' || summary.summaryStatus.running,
    saving: session.saving,
    saveError: session.saveError,
    loadError: session.loadError,

    send: generation.send,
    appendUserMessage: generation.appendUserMessage,
    regenerate: generation.regenerate,
    swipe: generation.swipe,
    swipeTo: generation.swipeTo,
    continueLast: generation.continueLast,
    guidedRespond: generation.guidedRespond,
    guidedSwipe: generation.guidedSwipe,
    impersonate: generation.impersonate,
    recap: generation.recap,
    abort: generation.abort,
    worldInfo:
      generation.worldInfo && generation.worldInfo.chatId === state.chatId
        ? generation.worldInfo.result
        : null,

    summaryStatus: summary.summaryStatus,
    summaryPending: summary.summaryPending,
    summaryChanged: summary.summaryChanged,
    summaryCovered: summary.summaryCovered,
    summaryCanUndo: summary.summaryCanUndo,
    summarize: summary.summarize,
    undoSummary: summary.undoSummary,
    restoreSummary: summary.restoreSummary,
    cancelSummary: summary.cancelSummary,
    editSummary: summary.editSummary,

    editMessage: session.editMessage,
    editReasoning: session.editReasoning,
    deleteMessage: session.deleteMessage,
    toggleHidden: session.toggleHidden,
    setHidden: session.setHidden,
    chats: session.chats,
    refreshChats: session.refreshChats,
    pendingChatRef: session.pendingChatRef,
    flushSaves: session.flushSaves,
    retrySave: session.retrySave,
    retryLoad: session.retryLoad,
    persona,
    setPersona: session.setPersona,
    resolvePersona: session.resolvePersona,
    updateMetadata: session.updateMetadata,
    renderGreeting: session.renderGreeting,
    regexMacros: session.regexMacros,

    ...lifecycle,
  };
}
