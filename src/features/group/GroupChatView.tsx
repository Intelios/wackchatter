import type { MessageState } from '@shared/chat/message.ts';
import type { Persona } from '@shared/types/chat.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  QuickCommand,
} from '@shared/types/settings.ts';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContinueIcon, NexusIcon, PauseIcon } from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { characterApi, chatApi, personaApi } from '../../lib/api.ts';
import { resolveDialogueColor, useAvatarColor } from '../chat/avatarColor.ts';
import { BranchTree } from '../chat/BranchTree.tsx';
import { Composer, type ComposerHandle } from '../chat/Composer.tsx';
import { MessageBubble } from '../chat/MessageBubble.tsx';
import { QuickCommands } from '../chat/QuickCommands.tsx';
import type { GenMode } from '../chat/state/chatReducer.ts';
import { createStreamStore, type StreamStore } from '../chat/state/streamStore.ts';
import {
  appendTranscriptWindow,
  initialTranscriptWindow,
  prependTranscriptWindow,
  type TranscriptWindow,
  windowForJump,
} from '../chat/transcriptWindow.ts';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import { PersonaChip } from '../persona/PersonaChip.tsx';
import { GroupChatMenu } from './GroupChatMenu.tsx';
import { SpeakNextPopover } from './SpeakNextPopover.tsx';
import type { GroupChatController } from './useGroupChat.ts';
import './Group.css';

/** How close to a page edge the reader must scroll before the next page loads. */
const LOAD_AHEAD_PX = 800;

interface TranscriptWindowState extends TranscriptWindow {
  chatId: string | null;
}

interface GroupChatViewProps {
  chat: GroupChatController;
  personas: Persona[];
  /** Most recently switched to, newest first. Orders the composer's persona chip. */
  recentPersonaIds: readonly string[];
  personaAvatarVersions?: Readonly<Record<string, number>>;
  dialogueColors: DialogueColorSettings;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  /** Sets the app-wide persona and this scene's, together. */
  onSelectPersona: (id: string | null) => void;
  /** Opens a right panel — the cast, memory, or the persona manager. */
  onOpenPanel: (panel: RightPanelId) => void;
  /** Opens the prompt inspector in the left panel. */
  onInspect: () => void;
  directorConfigured: boolean;
  onClose(): void;
}

/**
 * An open group scene.
 *
 * Structurally this is `ChatView`: a transcript that scrolls under a pinned composer, no
 * chrome of its own. The scene's actions live in the composer's burger and its speaker
 * controls in the tray, exactly where a one-on-one chat keeps its equivalents, because a
 * group is a chat with more characters in it rather than a different screen.
 *
 * What is genuinely group-shaped is only where it has to be: each row resolves its own
 * speaker, and the tray carries a second identity chip for who is being addressed.
 *
 * The transcript shares `ChatView`'s windowed pages and hoisted callbacks, and for the
 * same reasons: a group exchange fires far more state changes than a one-on-one reply
 * (a director pick, several concurrent streams, a save per settle), and a long scene
 * rendering every message on each of them froze the tab.
 */
export function GroupChatView({
  chat,
  personas,
  recentPersonaIds,
  personaAvatarVersions,
  dialogueColors,
  quickCommands,
  onQuickCommandsChange,
  onSelectPersona,
  onOpenPanel,
  onInspect,
  directorConfigured,
  onClose,
}: GroupChatViewProps) {
  const [timeline, setTimeline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const idleStream = useRef(createStreamStore());
  const { scrollToBottom, stopFollowing } = useStickToBottom(scroll, content);
  const scene = chat.state.metadata.group;
  const coordinator = chat.coordinator;
  const running = Boolean(coordinator?.running || coordinator?.selecting);
  const jobList = coordinator ? [...coordinator.jobs.values()] : [];
  const jobsByMessageId = useMemo(
    () =>
      new Map(
        Object.entries(chat.state.jobs).map(([jobId, job]) => [job.messageId, { jobId, job }]),
      ),
    [chat.state.jobs],
  );
  const busyMemberIds = jobList.map((job) => job.memberId);
  const blocked = chat.busy || chat.nexus.run.running || chat.summaryStatus.running;
  const act = (work: () => Promise<unknown>) => {
    void work().catch((e) => setError((e as Error).message));
  };
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // --- The transcript window (the ChatView pattern) ---------------------------

  const [window, setWindow] = useState<TranscriptWindowState>({ chatId: null, start: 0, end: 0 });
  const atEndRef = useRef(true);
  const restorePrependScroll = useRef<{ messageId: string; offset: number } | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const [jumpSeq, setJumpSeq] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);
  const suppressLoadAheadRef = useRef(false);
  const programmaticScrollRef = useRef(false);

  // Reset to the newest page when a different scene is opened — the transcript has been
  // replaced, so the previous window and scroll position belong to another conversation
  // entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on scene identity
  useEffect(() => {
    const initial = initialTranscriptWindow(chat.state.messages.length);
    setWindow({ chatId: chat.state.chatId, start: initial.start, end: initial.end });
    setFlashId(null);
    scrollToBottom();
  }, [chat.state.chatId, scrollToBottom]);

  // A scene can render its loaded messages before the scene-change effect has set the
  // window. Deriving the initial tail page here prevents that first paint from mounting
  // every message in a long scene.
  const fallbackWindow = initialTranscriptWindow(chat.state.messages.length);
  const visibleStart =
    window.chatId === chat.state.chatId
      ? Math.min(window.start, chat.state.messages.length)
      : fallbackWindow.start;
  const visibleEnd =
    window.chatId === chat.state.chatId
      ? Math.min(window.end, chat.state.messages.length)
      : fallbackWindow.end;
  const visibleMessages = chat.state.messages.slice(visibleStart, visibleEnd);

  // While the window is not anchored to the tail, bottom-follow must stay off: the
  // "bottom" of the scroll container is a page boundary, not the transcript's end.
  atEndRef.current = visibleEnd >= chat.state.messages.length;

  const loadOlderMessages = useCallback(() => {
    if (visibleStart === 0) return;
    const scrollEl = scroll.current;
    const contentEl = content.current;
    const first = contentEl?.querySelector<HTMLElement>('[data-message-id]');
    if (scrollEl && first) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const firstRect = first.getBoundingClientRect();
      restorePrependScroll.current = {
        messageId: first.dataset.messageId!,
        offset: firstRect.top - scrollRect.top,
      };
    }
    setWindow((current) =>
      current.chatId === chat.state.chatId
        ? {
            chatId: current.chatId,
            ...prependTranscriptWindow(
              { start: current.start, end: current.end },
              chat.state.messages.length,
            ),
          }
        : current,
    );
  }, [visibleStart, chat.state.chatId, chat.state.messages.length]);

  const loadNewerMessages = useCallback(() => {
    if (visibleEnd >= chat.state.messages.length) return;
    setWindow((current) =>
      current.chatId === chat.state.chatId
        ? {
            chatId: current.chatId,
            ...appendTranscriptWindow(
              { start: current.start, end: current.end },
              chat.state.messages.length,
            ),
          }
        : current,
    );
  }, [visibleEnd, chat.state.chatId, chat.state.messages.length]);

  // Scrolling up loads the next older page on the way; scrolling down toward a page
  // boundary appends the next newer page. A tail-anchored window leaves the bottom edge
  // to the stick-to-bottom follow — the two would cascade page loads against each other.
  useEffect(() => {
    const scrollEl = scroll.current;
    if (!scrollEl) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      suppressLoadAheadRef.current = false;
      if (!atEndRef.current) stopFollowing();
      if (scrollEl.scrollTop < LOAD_AHEAD_PX) loadOlderMessages();
      if (atEndRef.current) return;
      if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < LOAD_AHEAD_PX) {
        loadNewerMessages();
      }
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [loadOlderMessages, loadNewerMessages, stopFollowing]);

  // The listeners run on scroll events; a page too short to scroll never fires one.
  // After the scene opens or a page lands, keep loading while the reader is still inside
  // a load-ahead band. A jump suppresses both until the reader scrolls.
  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current) return;
    const scrollEl = scroll.current;
    if (!scrollEl || visibleStart === 0) return;
    if (window.chatId !== chat.state.chatId) return;
    if (scrollEl.scrollTop >= LOAD_AHEAD_PX) return;
    loadOlderMessages();
  }, [visibleStart, window.chatId, chat.state.chatId, loadOlderMessages]);

  useLayoutEffect(() => {
    if (suppressLoadAheadRef.current) return;
    const scrollEl = scroll.current;
    if (!scrollEl || atEndRef.current) return;
    if (window.chatId !== chat.state.chatId) return;
    if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight >= LOAD_AHEAD_PX) return;
    loadNewerMessages();
  }, [window, chat.state.chatId, loadNewerMessages]);

  // Prepending adds DOM above the reader. Restore the same document position after the
  // layout commits, anchored to the first rendered message rather than a height delta —
  // the newer load-ahead can append below in the same commit.
  useLayoutEffect(() => {
    const restore = restorePrependScroll.current;
    const scrollEl = scroll.current;
    const contentEl = content.current;
    if (!restore || !scrollEl || !contentEl) return;
    const el = contentEl.querySelector(`[data-message-id="${restore.messageId}"]`);
    if (el) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      scrollEl.scrollTop += elRect.top - scrollRect.top - restore.offset;
    }
    restorePrependScroll.current = null;
  });

  // A window anchored to the tail follows it. Without this, a member's placeholder born
  // into a window whose end was computed before the growth would land past the rendered
  // rows and be invisible — the scene would look like nobody answered.
  const lastCountRef = useRef(chat.state.messages.length);
  useEffect(() => {
    const previous = lastCountRef.current;
    lastCountRef.current = chat.state.messages.length;
    if (window.chatId !== chat.state.chatId) return;
    if (chat.state.messages.length > previous && window.end >= previous) {
      setWindow((current) =>
        current.chatId === chat.state.chatId && current.end >= previous
          ? { ...current, end: chat.state.messages.length }
          : current,
      );
    }
  }, [chat.state.messages.length, window.chatId, chat.state.chatId, window.end]);

  // --- Nexus jump -------------------------------------------------------------

  const jumpTo = useCallback(
    (index: number) => {
      const count = chatRef.current.state.messages.length;
      if (count === 0) return;
      const target = Math.min(Math.max(0, index), count - 1);
      const win = windowForJump(target, count);
      pendingJumpRef.current = chatRef.current.state.messages[target]?.id ?? null;
      suppressLoadAheadRef.current = true;
      stopFollowing();
      setWindow({ chatId: chatRef.current.state.chatId, start: win.start, end: win.end });
      setJumpSeq((s) => s + 1);
    },
    [stopFollowing],
  );

  useEffect(() => {
    const id = chat.nexus.jumpId;
    if (!id) return;
    const index = chat.state.messages.findIndex((m) => m.id === id);
    if (index >= 0) jumpTo(index);
    chat.nexus.setJumpId(null);
  }, [chat.nexus.jumpId, chat.nexus.setJumpId, chat.state.messages, jumpTo]);

  // The flash is a notice, not a state: cleared on a timer so the row reads normally
  // again. The cleanup also cancels a pending clear when another jump re-arms it first.
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(timer);
  }, [flashId]);

  // The target only exists in the DOM once the new window has committed, so the scroll
  // waits for this layout effect. Centred, not snapped to the top. Declared before the
  // load-ahead effects so their scroll captures happen after the centering.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sequence is the trigger
  useLayoutEffect(() => {
    const id = pendingJumpRef.current;
    if (!id) return;
    pendingJumpRef.current = null;
    const scrollEl = scroll.current;
    const contentEl = content.current;
    if (!scrollEl || !contentEl) return;
    const el = contentEl.querySelector(`[data-message-id="${id}"]`);
    if (!el) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    programmaticScrollRef.current = true;
    scrollEl.scrollTop =
      elRect.top -
      scrollRect.top +
      scrollEl.scrollTop -
      scrollEl.clientHeight / 2 +
      elRect.height / 2;
    setFlashId(id);
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [jumpSeq]);

  // --- Actions, hoisted so a row's memo survives a re-render of this view ---------

  const handleSend = useCallback(
    async (text: string): Promise<string | null> => {
      const sent = await chatRef.current.send(text);
      if (sent) scrollToBottom();
      return sent ? null : 'Message was not sent. Check the scene error above.';
    },
    [scrollToBottom],
  );
  const rerollMessage = useCallback((id: string) => chatRef.current.reroll(id), []);
  const speakMember = useCallback(
    (memberId: string) => chatRef.current.coordinator?.manual(memberId),
    [],
  );
  const retryScene = useCallback(() => chatRef.current.coordinator?.start(), []);
  const editMessage = useCallback((id: string, text: string) => {
    const c = chatRef.current;
    if (c.busy || c.nexus.run.running || c.summaryStatus.running) return;
    c.dispatch({ type: 'message/edited', id, text });
  }, []);
  const editReasoning = useCallback((id: string, reasoning: string) => {
    const c = chatRef.current;
    if (c.busy || c.nexus.run.running || c.summaryStatus.running) return;
    c.dispatch({ type: 'message/reasoningEdited', id, reasoning });
  }, []);
  const deleteMessage = useCallback((id: string) => {
    const c = chatRef.current;
    if (c.busy || c.nexus.run.running || c.summaryStatus.running) return;
    c.dispatch({ type: 'message/deleted', id });
  }, []);
  const toggleHidden = useCallback((id: string) => {
    const c = chatRef.current;
    if (c.busy || c.nexus.run.running || c.summaryStatus.running) return;
    c.dispatch({ type: 'message/toggleHidden', id });
  }, []);
  const branchMessage = useCallback((id: string) => {
    void chatRef.current.branch(id).catch((e: unknown) => setError((e as Error).message));
  }, []);
  const selectSwipe = useCallback((id: string, index: number) => {
    const c = chatRef.current;
    if (c.busy || c.nexus.run.running || c.summaryStatus.running) return;
    c.dispatch({ type: 'swipe/select', id, index });
  }, []);

  if (chat.loading)
    return (
      <div className="wc-empty" role="status">
        <span>Opening scene…</span>
      </div>
    );
  if (!scene)
    return (
      <div className="wc-empty" role="alert">
        <span>{chat.state.error ?? 'Scene unavailable.'}</span>
      </div>
    );

  const pausedAtLimit = jobList.length >= scene.concurrency;
  const speakerBlockedReason = chat.nexus.run.running
    ? 'Cancel or finish the memory extraction first.'
    : chat.summaryStatus.running
      ? 'Cancel or finish the current summary first.'
      : undefined;
  const continueDisabled = !directorConfigured || blocked || running;
  /*
   * When an exchange is already running the reason points at Pause, which sits beside this
   * button — "wait for the current replies" is a dead end, while "pause it first" is the
   * actual next click, and pausing is what frees a director that has stopped answering.
   */
  const continueReason = !directorConfigured
    ? 'Choose a director connection and model in Cast & settings first.'
    : running
      ? 'An exchange is already running — pause it, then continue.'
      : blocked
        ? (speakerBlockedReason ?? 'Wait for the current reply to finish.')
        : 'Continue the conversation';
  // The scene's opening press is a start, the rest are continuations — the menu's first
  // entry says the same thing, and the two must not disagree about which one this is.
  const continueLabel = chat.state.messages.length ? 'Continue' : 'Start scene';

  return (
    <div className="chat-view">
      <div className="chat-view__scroll" ref={scroll}>
        <div className="chat-view__content" ref={content}>
          {chat.state.messages.length === 0 ? (
            <div className="wc-empty">
              <span>
                {scene.scenario ||
                  'Set the scene — write an opening message, or continue the conversation.'}
              </span>
            </div>
          ) : (
            visibleMessages.map((message) => {
              const entry = jobsByMessageId.get(message.id);
              const stream = entry
                ? (chat.streams.get(entry.jobId) ?? idleStream.current)
                : idleStream.current;
              return (
                <GroupMessageRow
                  key={message.id}
                  message={message}
                  personas={personas}
                  currentPersona={chat.persona}
                  personaAvatarVersions={personaAvatarVersions}
                  dialogueColors={dialogueColors}
                  streaming={Boolean(entry)}
                  stream={stream}
                  streamNote={
                    entry ? (stream.getSnapshot().active ? 'Replying…' : 'Connecting…') : undefined
                  }
                  mode={entry?.job.mode ?? null}
                  onStopStream={
                    entry ? () => chatRef.current.coordinator?.stop(entry.jobId) : undefined
                  }
                  isLast={message.id === chat.state.messages.at(-1)?.id}
                  busy={blocked}
                  summaryRunning={chat.summaryStatus.running}
                  memoryRunning={chat.nexus.run.running}
                  flash={flashId === message.id}
                  onReroll={rerollMessage}
                  onSpeak={speakMember}
                  onRetry={retryScene}
                  onEdit={editMessage}
                  onEditReasoning={editReasoning}
                  onDelete={deleteMessage}
                  onToggleHidden={toggleHidden}
                  onBranch={branchMessage}
                  onSwipeSelect={selectSwipe}
                />
              );
            })
          )}
        </div>
      </div>

      {/*
        The dock: failure notices and the composer, pinned below the transcript and outside
        its scroller — the same anchor ChatView uses, so the composer grows upward into a
        shorter transcript rather than pushing the transcript off the page.
      */}
      <div className="chat-view__dock">
        {chat.state.error || chat.saveError || error ? (
          <div className="chat-view__error" role="alert">
            <span className="chat-view__error-text">
              {chat.state.error || chat.saveError || error}
            </span>
            {chat.saveError ? (
              <button
                type="button"
                className="wc-button chat-view__retry"
                onClick={() => act(chat.saveNow)}
              >
                Retry save
              </button>
            ) : null}
          </div>
        ) : null}

        {/*
          The exchange's status, and the one place a stalled director is legible. A director
          call that never answers leaves the scene "active" with nothing arriving, so the
          stalling phase says what it is waiting on rather than looking like progress.
        */}
        {running ? (
          <p className="group-live" role="status">
            {coordinator?.selecting
              ? 'Director choosing who speaks…'
              : `Conversation active${coordinator?.remaining ? ` · ${coordinator.remaining} replies still to come` : ''}`}
          </p>
        ) : !directorConfigured ? (
          /*
           * A dead primary button with only a tooltip is a dead end, and this is a setup
           * problem rather than a passing state — so it says so once, in the one line the
           * dock already has, rather than leaving the user to guess why Continue is grey.
           */
          <p className="group-live">
            Choose a director connection and model in Cast &amp; settings to start an automatic
            conversation. You can still call on a member.
          </p>
        ) : null}

        <Composer
          key={chat.state.chatId}
          ref={composerRef}
          onSend={handleSend}
          onDraftChange={chat.nexus.draftChanged}
          onGuide={(text) => void chat.guide(text)}
          // The composer's Stop ends the whole exchange, which is what its label says. A
          // single member's reply has its own Stop in that row's header.
          onStop={() => coordinator?.stopAll()}
          busy={running || chat.busy}
          disabled={chat.loading || chat.nexus.run.running || chat.summaryStatus.running}
          placeholder="Join the conversation…"
          identity={
            <PersonaChip
              personas={personas}
              active={chat.persona}
              recentIds={recentPersonaIds}
              avatarVersions={personaAvatarVersions ?? {}}
              onSelect={onSelectPersona}
              onManage={() => onOpenPanel('persona')}
            />
          }
          leading={
            <>
              <GroupChatMenu
                chat={chat}
                directorConfigured={directorConfigured}
                onStopAll={() => coordinator?.stopAll()}
                onPause={() => coordinator?.pause()}
                onContinue={() => coordinator?.start()}
                onOpenCast={() => onOpenPanel('groups')}
                onOpenMemory={() => onOpenPanel('summary')}
                onOpenInspect={onInspect}
                onOpenBranchTree={() => setTimeline(true)}
                onCloseScene={onClose}
                onDeleteScene={() =>
                  act(async () => {
                    await chat.saveNow();
                    await chatApi.remove(chat.state.chatId!);
                    onClose();
                  })
                }
                onSelectMember={(id) => chat.selectMember(id)}
              />
              <QuickCommands
                quickCommands={quickCommands}
                onInsertCommand={(text) => composerRef.current?.insert(text)}
                onQuickCommandsChange={onQuickCommandsChange}
              />
              {chat.memoryMode === 'nexus' ? (
                <button
                  type="button"
                  className="wc-button wc-button--ghost composer__icon"
                  aria-label="Memory Nexus"
                  title="Memory Nexus"
                  onClick={() => chat.nexus.show('explore')}
                >
                  <NexusIcon />
                </button>
              ) : null}
            </>
          }
          trailing={
            <>
              {/*
                Both conversation controls are always mounted and always labelled.
                Labelled, because "continue the conversation" is the group's headline action
                and a bare fast-forward glyph does not read as a button you can press to
                nudge a director that has gone quiet — which is a real state, and the reason
                this pair exists at all.
                Both mounted, because appearing and disappearing would shift the speaker
                chip and the wand sideways every time an exchange starts; a disabled Pause
                says "nothing to pause" without moving anything.
              */}
              <button
                type="button"
                className="wc-button group-conversation"
                aria-label="Continue conversation"
                title={continueReason}
                disabled={continueDisabled}
                onClick={() => {
                  chat.dispatch({ type: 'error/cleared' });
                  coordinator?.start();
                }}
              >
                <ContinueIcon />
                {continueLabel}
              </button>
              <button
                type="button"
                className="wc-button group-conversation"
                aria-label="Pause conversation"
                // A stalled director is the case this button is for, so it says what
                // pausing actually does from where the user is standing.
                title={
                  coordinator?.selecting
                    ? 'Pause conversation — stop waiting on the director'
                    : 'Pause conversation — replies already running will finish'
                }
                disabled={!running}
                onClick={() => coordinator?.pause()}
              >
                <PauseIcon />
                Pause
              </button>
              <SpeakNextPopover
                members={scene.members}
                selectedId={chat.selectedMemberId}
                busyIds={busyMemberIds}
                disabledReason={speakerBlockedReason}
                busyReason={
                  pausedAtLimit ? 'The conversation is already running its replies.' : undefined
                }
                onSpeak={(id) => {
                  chat.selectMember(id);
                  coordinator?.manual(id);
                }}
              />
            </>
          }
        />
      </div>

      {timeline ? <BranchTree chat={chat} onClose={() => setTimeline(false)} /> : null}
    </div>
  );
}

interface GroupMessageRowProps {
  message: MessageState;
  personas: Persona[];
  /** The scene's current persona, for rows sent before speakers were recorded. */
  currentPersona: Persona | null;
  personaAvatarVersions?: Readonly<Record<string, number>>;
  dialogueColors: DialogueColorSettings;
  streaming: boolean;
  stream: StreamStore;
  streamNote?: string;
  mode: GenMode | null;
  onStopStream?: () => void;
  isLast: boolean;
  busy: boolean;
  summaryRunning: boolean;
  memoryRunning: boolean;
  flash: boolean;
  onReroll: (id: string) => void;
  onSpeak: (memberId: string) => void;
  onRetry: () => void;
  onEdit: (id: string, text: string) => void;
  onEditReasoning: (id: string, reasoning: string) => void;
  onDelete: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onBranch: (id: string) => void;
  /** Show a different existing swipe by index. */
  onSwipeSelect: (id: string, index: number) => void;
}

/**
 * One turn, with its speaker's presentation resolved per row.
 *
 * Memoised, and only because everything it takes is a primitive or a stable identity —
 * the callbacks are hoisted into the view, so a scene state change re-renders only the
 * rows whose own message moved. The row-internal swipe closures are rebuilt when the row
 * itself re-renders, which is the only place a new identity can leak.
 *
 * Both kinds of row go through one path: a member resolves against the cast's colours, a
 * user resolves against the persona they actually sent as, falling back to the scene's
 * current persona only for messages that predate the speaker being recorded.
 */
const GroupMessageRow = memo(function GroupMessageRow({
  message,
  personas,
  currentPersona,
  personaAvatarVersions,
  dialogueColors,
  streaming,
  stream,
  streamNote,
  mode,
  onStopStream,
  isLast,
  busy,
  summaryRunning,
  memoryRunning,
  flash,
  onReroll,
  onSpeak,
  onRetry,
  onEdit,
  onEditReasoning,
  onDelete,
  onToggleHidden,
  onBranch,
  onSwipeSelect,
}: GroupMessageRowProps) {
  const persona = message.is_user ? speakerOf(message, personas, currentPersona) : null;
  const characterId = message.is_user ? null : (message.characterId ?? null);
  const avatarUrl = message.is_user
    ? persona?.avatar
      ? personaApi.avatarUrl(persona.id, personaAvatarVersions?.[persona.id] ?? persona.avatar)
      : null
    : characterId
      ? characterApi.imageUrl(characterId)
      : null;
  const override: DialogueColorOverride | undefined = message.is_user
    ? persona
      ? dialogueColors.personas[persona.id]
      : undefined
    : characterId
      ? dialogueColors.characters[characterId]
      : undefined;
  const autoColor = useAvatarColor(
    dialogueColors.enabled && override === undefined ? avatarUrl : null,
  );
  const dialogue = resolveDialogueColor(dialogueColors.enabled, override, autoColor);

  return (
    <MessageBubble
      message={message}
      avatarUrl={avatarUrl}
      dialogueActive={dialogue.active}
      dialogueColor={dialogue.color}
      streaming={streaming}
      mode={mode}
      stream={stream}
      isLast={isLast}
      busy={busy}
      summaryRunning={summaryRunning}
      memoryRunning={memoryRunning}
      flash={flash}
      streamNote={streamNote}
      onStopStream={onStopStream}
      onSwipe={(direction) => {
        if (busy) return;
        const index = message.swipe_id + direction;
        if (index >= 0 && index < message.swipes.length) onSwipeSelect(message.id, index);
        else if (direction > 0) onReroll(message.id);
      }}
      onSwipeTo={onSwipeSelect}
      onRegenerate={() => onReroll(message.id)}
      onContinue={() => message.memberId && onSpeak(message.memberId)}
      onRetry={onRetry}
      onEdit={onEdit}
      onEditReasoning={onEditReasoning}
      onDelete={onDelete}
      onToggleHidden={onToggleHidden}
      onBranch={onBranch}
    />
  );
});

/** Who spoke, resolved the way `ChatView` resolves it: recorded, or the scene's current. */
function speakerOf(
  message: MessageState,
  personas: Persona[],
  current: Persona | null,
): Persona | null {
  const id = message.persona_id === undefined ? (current?.id ?? null) : message.persona_id;
  return id ? (personas.find((persona) => persona.id === id) ?? null) : null;
}
