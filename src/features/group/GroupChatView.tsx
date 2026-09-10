import type { MessageState } from '@shared/chat/message.ts';
import type { Persona } from '@shared/types/chat.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  QuickCommand,
} from '@shared/types/settings.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContinueIcon, NexusIcon, PauseIcon } from '../../layout/icons.tsx';
import type { RightPanelId } from '../../layout/panels.tsx';
import { characterApi, chatApi, personaApi } from '../../lib/api.ts';
import { resolveDialogueColor, useAvatarColor } from '../chat/avatarColor.ts';
import { BranchTree } from '../chat/BranchTree.tsx';
import { Composer, type ComposerHandle } from '../chat/Composer.tsx';
import { MessageBubble } from '../chat/MessageBubble.tsx';
import { QuickCommands } from '../chat/QuickCommands.tsx';
import { createStreamStore, type StreamStore } from '../chat/state/streamStore.ts';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import { PersonaChip } from '../persona/PersonaChip.tsx';
import { GroupChatMenu } from './GroupChatMenu.tsx';
import { SpeakNextPopover } from './SpeakNextPopover.tsx';
import type { GroupChatController } from './useGroupChat.ts';
import './Group.css';

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
  const { scrollToBottom } = useStickToBottom(scroll, content);
  const scene = chat.state.metadata.group;
  const coordinator = chat.coordinator;
  const running = Boolean(coordinator?.running || coordinator?.selecting);
  const jobList = coordinator ? [...coordinator.jobs.values()] : [];
  const busyMemberIds = jobList.map((job) => job.memberId);
  const blocked = chat.busy || chat.nexus.run.running || chat.summaryStatus.running;
  const act = (work: () => Promise<unknown>) => {
    void work().catch((e) => setError((e as Error).message));
  };

  // Jump to the end when a different scene is opened — the transcript has been replaced,
  // so the previous scroll position belongs to another conversation entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on scene identity
  useEffect(() => {
    scrollToBottom();
  }, [chat.state.chatId, scrollToBottom]);
  useEffect(() => {
    const id = chat.nexus.jumpId;
    // The bubble already carries `data-message-id`; scoped to this transcript so a jump
    // can never land on a row of some other view that happens to share the attribute.
    if (id)
      content.current
        ?.querySelector(`[data-message-id="${id}"]`)
        ?.scrollIntoView({ block: 'center' });
  }, [chat.nexus.jumpId]);

  const handleSend = useCallback(
    async (text: string): Promise<string | null> => {
      const sent = await chat.send(text);
      if (sent) scrollToBottom();
      return sent ? null : 'Message was not sent. Check the scene error above.';
    },
    [chat, scrollToBottom],
  );

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
            chat.state.messages.map((message, index) => {
              const jobEntry = Object.entries(chat.state.jobs).find(
                ([, job]) => job.messageId === message.id,
              );
              const stream = jobEntry
                ? (chat.streams.get(jobEntry[0]) ?? idleStream.current)
                : idleStream.current;
              return (
                <GroupMessageRow
                  key={message.id}
                  chat={chat}
                  message={message}
                  personas={personas}
                  personaAvatarVersions={personaAvatarVersions}
                  dialogueColors={dialogueColors}
                  streaming={Boolean(jobEntry)}
                  stream={stream}
                  streamNote={
                    jobEntry
                      ? stream.getSnapshot().active
                        ? 'Replying…'
                        : 'Connecting…'
                      : undefined
                  }
                  onStopStream={jobEntry ? () => coordinator?.stop(jobEntry[0]) : undefined}
                  isLast={index === chat.state.messages.length - 1}
                  busy={blocked}
                  summaryRunning={chat.summaryStatus.running}
                  memoryRunning={chat.nexus.run.running}
                  flash={chat.nexus.jumpId === message.id}
                  onReroll={(id) => chat.reroll(id)}
                  onSpeak={(memberId) => coordinator?.manual(memberId)}
                  onRetry={() => coordinator?.start()}
                  onEdit={(id, text) => {
                    if (!blocked) chat.dispatch({ type: 'message/edited', id, text });
                  }}
                  onEditReasoning={(id, reasoning) => {
                    if (!blocked) chat.dispatch({ type: 'message/reasoningEdited', id, reasoning });
                  }}
                  onDelete={(id) => {
                    if (!blocked) chat.dispatch({ type: 'message/deleted', id });
                  }}
                  onToggleHidden={(id) => {
                    if (!blocked) chat.dispatch({ type: 'message/toggleHidden', id });
                  }}
                  onBranch={(id) => act(() => chat.branch(id))}
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
  chat: GroupChatController;
  message: MessageState;
  personas: Persona[];
  personaAvatarVersions?: Readonly<Record<string, number>>;
  dialogueColors: DialogueColorSettings;
  streaming: boolean;
  stream: StreamStore;
  streamNote?: string;
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
}

/**
 * One turn, with its speaker's presentation resolved per row.
 *
 * A component rather than a loop body because the avatar-colour extraction is a hook, and
 * a group has as many speakers as it has rows — a member's dialogue colour comes from
 * their own card, the same rule (and the same cache) a one-on-one chat's does.
 *
 * Both kinds of row go through one path: a member resolves against the cast's colours, a
 * user resolves against the persona they actually sent as, falling back to the scene's
 * current persona only for messages that predate the speaker being recorded.
 */
function GroupMessageRow({
  chat,
  message,
  personas,
  personaAvatarVersions,
  dialogueColors,
  streaming,
  stream,
  streamNote,
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
}: GroupMessageRowProps) {
  const persona = message.is_user ? speakerOf(message, personas, chat.persona) : null;
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
      mode={runningMode(chat, message.id)}
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
        if (index >= 0 && index < message.swipes.length)
          chat.dispatch({ type: 'swipe/select', id: message.id, index });
        else if (direction > 0) onReroll(message.id);
      }}
      onSwipeTo={(id, index) => {
        if (!busy) chat.dispatch({ type: 'swipe/select', id, index });
      }}
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
}

/** The generation mode a row is streaming under, so a re-roll animates as a re-roll. */
function runningMode(chat: GroupChatController, messageId: string) {
  const job = Object.values(chat.state.jobs).find((entry) => entry.messageId === messageId);
  return job?.mode ?? null;
}

/** Who spoke, resolved the way `ChatView` resolves it: recorded, or the scene's current. */
function speakerOf(
  message: MessageState,
  personas: Persona[],
  current: Persona | null,
): Persona | null {
  const id = message.persona_id === undefined ? (current?.id ?? null) : message.persona_id;
  return id ? (personas.find((persona) => persona.id === id) ?? null) : null;
}
