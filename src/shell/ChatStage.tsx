/**
 * The chat itself: the transcript and the Line, centred in the scene.
 *
 * Markup over the chat surface (`useChatSurface`), which holds the behaviour.
 */

import type { Persona } from '@shared/types/chat.ts';
import type {
  DialogueColorOverride,
  DialogueColorSettings,
  GuidanceSettings,
  QuickCommand,
} from '@shared/types/settings.ts';
import { memo, type RefObject, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  needsPortrait,
  resolveDialogueColor,
  useAvatarPalette,
} from '../features/chat/avatarColor.ts';
import type { UseChat } from '../features/chat/useChat.ts';
import type { ChatSurface } from '../features/chat/useChatSurface.ts';
import { personaApi } from '../lib/api.ts';
import { Avatar } from './Avatar.tsx';
import { Icon } from './icons.tsx';
import { LineComposer, type LineHandle } from './LineComposer.tsx';
import { Message, type MessageCard } from './Message.tsx';

interface ChatStageProps {
  chat: UseChat;
  surface: ChatSurface;
  lineRef: RefObject<LineHandle | null>;
  characterName: string;
  characterDescription: string;
  greetingCount: number;
  personaAvatarVersions: Readonly<Record<string, number>>;
  dialogueColors: DialogueColorSettings;
  guidance: GuidanceSettings;
  onGuidanceChange: (patch: Partial<GuidanceSettings>) => void;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => void;
  /** Settings ▸ Look ▸ Streaming is off: replies appear whole when finished. */
  revealWhole: boolean;
  ready: boolean;
  notReadyReason: string | null;
  onChooseModel: () => void;
  onCopied: (ok: boolean) => void;
  /** A message was sent: the shell lifts the backdrop's bloom. */
  onSent: () => void;
}

export function ChatStage({
  chat,
  surface,
  lineRef,
  characterName,
  characterDescription,
  greetingCount,
  personaAvatarVersions,
  dialogueColors,
  guidance,
  onGuidanceChange,
  quickCommands,
  onQuickCommandsChange,
  revealWhole,
  ready,
  notReadyReason,
  onChooseModel,
  onCopied,
  onSent,
}: ChatStageProps) {
  const { state, stream, busy } = chat;
  const summaryRunning = chat.summaryStatus.running;
  const {
    scrollRef,
    contentRef,
    flashId,
    visibleStart,
    visibleMessages,
    characterAvatarUrl,
    characterDialogue,
    speakerOf,
    displayTexts,
    renderedNotes,
    lastId,
    awaitingReply,
    guides,
    guidedSwipeDisabledReason,
    impersonating,
    loadBlocksChat,
  } = surface;

  // --- Sending: the Line flares and your message rises into its place ----------------
  const liftFrom = useRef<DOMRect | null>(null);
  const liftCount = useRef(0);
  const onBeforeSend = useCallback(
    (rect: DOMRect) => {
      liftFrom.current = rect;
      liftCount.current = state.messages.length;
    },
    [state.messages.length],
  );

  useLayoutEffect(() => {
    const from = liftFrom.current;
    if (!from || state.messages.length <= liftCount.current) return;
    liftFrom.current = null;
    // The user's new row is the last user row on screen.
    const rows = contentRef.current?.querySelectorAll<HTMLElement>('.w3-msg[data-role="user"]');
    const row = rows?.[rows.length - 1];
    if (!row) return;
    if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      // A short rise and fade, not a flight from the Line: only transform and opacity, so
      // it never repaints the transcript.
      row.animate(
        [
          { transform: 'translateY(40px)', opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 700, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      );
    }
    onSent();
  }, [state.messages.length, contentRef, onSent]);

  // The portrait beside each of the character's lines opens their card.
  const messageCard = useMemo<MessageCard>(
    () => ({
      store: surface.cardStore,
      line: characterDescription,
      onOpenReader: surface.openCardReader,
      onEditCharacter: surface.editCharacter,
    }),
    [surface.cardStore, characterDescription, surface.openCardReader, surface.editCharacter],
  );

  const continueDisabledReason = !lastId
    ? 'This chat has no messages yet.'
    : awaitingReply
      ? 'The last message is yours.'
      : undefined;

  const blockedReason = loadBlocksChat
    ? 'Retry loading this character before writing.'
    : !ready
      ? (notReadyReason ?? 'Choose a chat model to start writing.')
      : undefined;

  const placeholder = blockedReason
    ? blockedReason
    : `Your turn${chat.persona ? `, ${chat.persona.name}` : ''}…`;

  return (
    <div className="w3-stage">
      <div className="w3-transcript" ref={scrollRef}>
        <div className="w3-col" ref={contentRef}>
          <header className="w3-cover">
            <Avatar url={characterAvatarUrl} name={characterName} size="xl" />
            <h1>{characterName}</h1>
            {characterDescription ? <p>{characterDescription}</p> : null}
            {state.chatId ? (
              <span className="w3-cover__meta">
                {state.title} · {state.messages.length.toLocaleString()}{' '}
                {state.messages.length === 1 ? 'message' : 'messages'}
              </span>
            ) : null}
          </header>

          {state.messages.length === 0 && state.chatId ? (
            <p className="w3-empty">No messages yet. Say something to {characterName}.</p>
          ) : null}

          {visibleMessages.map((message, index) => {
            const messageIndex = visibleStart + index;
            const shared = {
              message,
              streaming: state.streamingId === message.id,
              revealWhole,
              card: messageCard,
              flash: message.id === flashId,
              mode: state.mode,
              stream,
              isLast: message.id === lastId,
              busy,
              summaryRunning,
              displayText: displayTexts.get(message.id)?.text,
              displayReasoning: displayTexts.get(message.id)?.reasoning,
              creatorNotes: messageIndex === 0 ? renderedNotes : undefined,
              greetingCount: messageIndex === 0 ? greetingCount : undefined,
              onSwipe: surface.swipe,
              onSwipeTo: surface.swipeTo,
              onRegenerate: surface.regenerate,
              onContinue: surface.continueLast,
              onRetry: surface.regenerate,
              onEdit: surface.editMessage,
              onEditReasoning: surface.editReasoning,
              onDelete: surface.deleteMessage,
              onToggleHidden: surface.toggleHidden,
              onBranch: surface.branchFrom,
              onCopied,
            };
            if (message.is_user) {
              const speaker = speakerOf(message);
              return (
                <UserMessage
                  key={message.id}
                  {...shared}
                  persona={speaker}
                  avatarVersion={speaker ? personaAvatarVersions[speaker.id] : undefined}
                  dialogueEnabled={dialogueColors.enabled}
                  override={speaker ? dialogueColors.personas[speaker.id] : undefined}
                />
              );
            }
            return (
              <Message
                key={message.id}
                {...shared}
                avatarUrl={characterAvatarUrl}
                dialogueActive={characterDialogue.active}
                dialogueColor={characterDialogue.color}
                dialogueGradient={characterDialogue.gradient}
              />
            );
          })}

          {/* A failure sits where the reply would have been, with the way out beside it. */}
          {state.error ? (
            <Problem
              title="The reply didn't arrive."
              detail={state.error}
              action={awaitingReply ? { label: 'Try again', run: surface.regenerate } : undefined}
              disabled={busy || summaryRunning || !ready}
            />
          ) : null}
          {chat.saveError ? (
            <Problem
              title="This chat couldn't be saved."
              detail={chat.saveError}
              action={{ label: 'Try saving again', run: () => void chat.retrySave() }}
              disabled={busy || chat.saving}
            />
          ) : null}
          {chat.loadError ? (
            <Problem
              title="This character's chats couldn't be loaded."
              detail={chat.loadError}
              action={{ label: 'Try again', run: chat.retryLoad }}
              disabled={busy}
            />
          ) : null}
        </div>
      </div>

      <div className="w3-dock">
        <LineComposer
          key={state.chatId}
          ref={lineRef}
          onSend={surface.handleSend}
          onGuide={surface.guide}
          onGuidedSwipe={surface.guidedSwipe}
          guidedSwipeDisabledReason={guidedSwipeDisabledReason}
          onImpersonate={surface.impersonate}
          impersonating={impersonating}
          stream={stream}
          onContinue={surface.continueLast}
          continueDisabledReason={continueDisabledReason}
          onStop={chat.abort}
          busy={busy}
          memoryRunning={summaryRunning}
          disabled={Boolean(blockedReason)}
          disabledReason={blockedReason}
          onChooseModel={!ready && !loadBlocksChat ? onChooseModel : undefined}
          placeholder={placeholder}
          guides={guides}
          onGuidesChange={(next) => chat.updateMetadata({ guides: next })}
          guidance={guidance}
          onGuidanceChange={onGuidanceChange}
          quickCommands={quickCommands}
          onQuickCommandsChange={onQuickCommandsChange}
          onDraftChange={chat.nexus.draftChanged}
          onBeforeSend={onBeforeSend}
          failed={state.error}
        />
      </div>
    </div>
  );
}

function Problem({
  title,
  detail,
  action,
  disabled,
}: {
  title: string;
  detail: string;
  action?: { label: string; run: () => void };
  disabled?: boolean;
}) {
  return (
    <div className="w3-problem" role="alert">
      <div className="w3-problem__head">
        <Icon name="alert" />
        <b>{title}</b>
      </div>
      <p className="w3-problem__detail">{detail}</p>
      {action ? (
        <button type="button" className="w3-textbtn" onClick={action.run} disabled={disabled}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

type UserMessageProps = Omit<
  Parameters<typeof Message>[0],
  'avatarUrl' | 'dialogueActive' | 'dialogueColor' | 'dialogueGradient'
> & {
  persona: Persona | null;
  avatarVersion: number | undefined;
  dialogueEnabled: boolean;
  override: DialogueColorOverride | undefined;
};

/** A user row with its own speaker's face and colour, resolved per message. */
const UserMessage = memo(function UserMessage({
  persona,
  avatarVersion,
  dialogueEnabled,
  override,
  ...rest
}: UserMessageProps) {
  const avatarUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, avatarVersion ?? persona.avatar)
    : null;
  const autoColor = useAvatarPalette(dialogueEnabled && needsPortrait(override) ? avatarUrl : null);
  const dialogue = resolveDialogueColor(dialogueEnabled, override, autoColor);
  return (
    <Message
      {...rest}
      avatarUrl={avatarUrl}
      dialogueActive={dialogue.active}
      dialogueColor={dialogue.color}
      dialogueGradient={dialogue.gradient}
    />
  );
});
