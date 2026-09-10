import { currentText } from '@shared/chat/message.ts';
import type { Persona } from '@shared/types/chat.ts';
import { memberLabel } from '@shared/types/group.ts';
import { useEffect, useRef, useState } from 'react';
import { characterApi, chatApi, personaApi } from '../../lib/api.ts';
import { BranchTree } from '../chat/BranchTree.tsx';
import { Composer } from '../chat/Composer.tsx';
import { MessageBubble } from '../chat/MessageBubble.tsx';
import { createStreamStore } from '../chat/state/streamStore.ts';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import type { GroupChatController } from './useGroupChat.ts';
import './Group.css';

export function GroupChatView({
  chat,
  personas,
  onClose,
  onSettings,
  onInspect,
  onMemory,
  directorConfigured,
}: {
  chat: GroupChatController;
  personas: Persona[];
  onClose(): void;
  onSettings(): void;
  onInspect(): void;
  onMemory(): void;
  directorConfigured: boolean;
}) {
  const [timeline, setTimeline] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.state.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const idleStream = useRef(createStreamStore());
  const { scrollToBottom } = useStickToBottom(scroll, content);
  const scene = chat.state.metadata.group;
  const blocked = chat.busy || chat.nexus.run.running || chat.summaryStatus.running;
  const act = (work: () => Promise<unknown>) => {
    void work().catch((e) => setError(e.message));
  };
  useEffect(() => {
    scrollToBottom();
  }, [chat.state.chatId, scrollToBottom]);
  useEffect(() => {
    const id = chat.nexus.jumpId;
    if (id) document.getElementById(`group-message-${id}`)?.scrollIntoView({ block: 'center' });
  }, [chat.nexus.jumpId]);
  if (chat.loading)
    return (
      <div className="group-empty" role="status">
        Opening scene…
      </div>
    );
  if (!scene)
    return (
      <div className="group-empty" role="alert">
        {chat.state.error ?? 'Scene unavailable.'}
      </div>
    );
  const running = chat.coordinator?.running || chat.coordinator?.selecting;
  return (
    <div className="group-chat">
      <header className="group-header">
        <div>
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                chat.dispatch({ type: 'chat/renamed', title: title.trim() || chat.state.title });
                setRenaming(false);
              }}
            >
              <input
                className="wc-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Scene title"
              />
              <button type="submit" className="wc-button">
                Save title
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="group-title"
              onClick={() => {
                setTitle(chat.state.title);
                setRenaming(true);
              }}
            >
              {chat.state.title}
            </button>
          )}
          <p className="group-note">
            {scene.members.map((m) => memberLabel(m, scene.members)).join(' · ')}
          </p>
        </div>
        <button type="button" className="wc-button" onClick={onClose}>
          Close
        </button>
      </header>
      <nav className="group-actions group-toolbar" aria-label="Scene controls">
        <button type="button" className="wc-button" onClick={onSettings}>
          Cast & settings
        </button>
        <button type="button" className="wc-button" onClick={onMemory}>
          Memory
        </button>
        <button type="button" className="wc-button" onClick={onInspect}>
          Inspect
        </button>
        <button type="button" className="wc-button" onClick={() => setTimeline(true)}>
          Branch timeline
        </button>
        {chat.state.chatId ? (
          <a className="wc-button" href={chatApi.exportUrl(chat.state.chatId)} download>
            Export
          </a>
        ) : null}
        <button
          type="button"
          className="wc-button"
          disabled={blocked}
          onBlur={() => setConfirmDelete(false)}
          onClick={() =>
            confirmDelete
              ? act(async () => {
                  await chat.saveNow();
                  await chatApi.remove(chat.state.chatId!);
                  onClose();
                })
              : setConfirmDelete(true)
          }
        >
          {confirmDelete ? 'Confirm delete scene' : 'Delete scene'}
        </button>
      </nav>
      <div className="group-activity" aria-live="polite">
        <span>
          {chat.coordinator?.selecting
            ? 'Director choosing speakers…'
            : running
              ? 'Conversation active'
              : 'Conversation paused'}
          {running ? ` · ${chat.coordinator?.remaining ?? 0} replies remaining` : ''}
        </span>
        <span>{chat.saving ? 'Saving…' : 'Saved'}</span>
      </div>
      {chat.state.error || chat.saveError || error ? (
        <div className="group-error" role="alert">
          {chat.state.error || chat.saveError || error}
          {chat.saveError ? (
            <button type="button" className="wc-button" onClick={() => act(chat.saveNow)}>
              Retry save
            </button>
          ) : null}
        </div>
      ) : null}
      {!directorConfigured ? (
        <p className="group-error">
          Choose a director connection and model in Cast & settings to enable automatic
          conversation. You can still call on a configured member.
        </p>
      ) : null}
      <div className="group-transcript" ref={scroll}>
        <div ref={content}>
          {!chat.state.messages.length ? (
            <div className="group-empty">
              <h2>Set the scene</h2>
              <p>
                {scene.scenario ||
                  'Write an opening message, or ask the director to start the scene.'}
              </p>
            </div>
          ) : null}
          {chat.state.messages.map((m, i) => {
            const jobEntry = Object.entries(chat.state.jobs).find(([, j]) => j.messageId === m.id);
            const stream = jobEntry
              ? (chat.streams.get(jobEntry[0]) ?? idleStream.current)
              : idleStream.current;
            const persona = m.is_user ? personas.find((p) => p.id === m.persona_id) : null;
            return (
              <div id={`group-message-${m.id}`} key={m.id} className="group-message">
                <MessageBubble
                  message={m}
                  avatarUrl={
                    m.is_user
                      ? persona?.avatar
                        ? personaApi.avatarUrl(persona.id)
                        : null
                      : m.characterId
                        ? characterApi.imageUrl(m.characterId)
                        : null
                  }
                  dialogueActive={false}
                  dialogueColor={null}
                  streaming={!!jobEntry}
                  mode={jobEntry?.[1].mode ?? null}
                  stream={stream}
                  isLast={i === chat.state.messages.length - 1}
                  busy={blocked}
                  summaryRunning={chat.summaryStatus.running}
                  memoryRunning={chat.nexus.run.running}
                  flash={chat.nexus.jumpId === m.id}
                  onSwipe={(direction) => {
                    if (blocked) return;
                    const index = m.swipe_id + direction;
                    if (index >= 0 && index < m.swipes.length)
                      chat.dispatch({ type: 'swipe/select', id: m.id, index });
                    else if (direction > 0) chat.reroll(m.id);
                  }}
                  onSwipeTo={(id, index) => {
                    if (!blocked) chat.dispatch({ type: 'swipe/select', id, index });
                  }}
                  onRegenerate={() => chat.reroll(m.id)}
                  onContinue={() => chat.coordinator?.manual(m.memberId ?? '')}
                  onRetry={() => chat.coordinator?.start()}
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
                {jobEntry ? (
                  <div className="group-message-tools">
                    <span role="status">
                      {stream.getSnapshot().active ? 'Replying…' : 'Connecting…'}
                    </span>
                    <button
                      type="button"
                      className="wc-button"
                      onClick={() => chat.coordinator?.stop(jobEntry[0])}
                    >
                      Stop {m.name}
                    </button>
                  </div>
                ) : !m.is_user && currentText(m) ? (
                  <div className="group-message-tools">
                    <button
                      type="button"
                      className="wc-button wc-button--ghost"
                      disabled={blocked}
                      onClick={() => chat.reroll(m.id)}
                    >
                      {i === chat.state.messages.length - 1 ? 'Reroll' : 'Branch & reroll'}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="group-actions group-controls">
        <button
          type="button"
          className="wc-button wc-button--primary"
          disabled={
            !directorConfigured || chat.nexus.run.running || chat.summaryStatus.running || !!running
          }
          onClick={() => {
            chat.dispatch({ type: 'error/cleared' });
            chat.coordinator?.start();
          }}
        >
          {chat.state.messages.length ? 'Continue conversation' : 'Start scene'}
        </button>
        <button
          type="button"
          className="wc-button"
          disabled={!running}
          onClick={() => chat.coordinator?.pause()}
        >
          Pause conversation
        </button>
        <button
          type="button"
          className="wc-button"
          disabled={!blocked}
          onClick={() => chat.coordinator?.stopAll()}
        >
          Stop all
        </button>
        <label>
          Speak next
          <select
            className="wc-input"
            value=""
            disabled={
              chat.nexus.run.running ||
              chat.summaryStatus.running ||
              (chat.coordinator?.jobs.size ?? 0) >= scene.concurrency
            }
            onChange={(e) => chat.coordinator?.manual(e.target.value)}
          >
            <option value="">Choose member</option>
            {scene.members.map((m) => (
              <option
                key={m.id}
                value={m.id}
                disabled={
                  m.muted ||
                  [...(chat.coordinator?.jobs.values() ?? [])].some((j) => j.memberId === m.id)
                }
              >
                {memberLabel(m, scene.members)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Composer
        key={chat.state.chatId}
        onSend={async (text) =>
          (await chat.send(text)) ? null : 'Message was not sent. Check the scene error above.'
        }
        onDraftChange={chat.nexus.draftChanged}
        onGuide={(text) => void chat.guide(text)}
        onStop={() => chat.coordinator?.stopAll()}
        busy={false}
        disabled={chat.loading || chat.nexus.run.running || chat.summaryStatus.running}
        placeholder="Join the conversation…"
        identity={
          <label className="group-composer-label">
            Writing as
            <select
              className="wc-input"
              value={chat.persona?.id ?? ''}
              onChange={(e) => chat.setPersona(e.target.value || null)}
            >
              <option value="">User</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.variantLabel ? ` (${p.variantLabel})` : ''}
                </option>
              ))}
            </select>
          </label>
        }
        trailing={
          <label className="group-composer-label">
            Macro character
            <select
              className="wc-input"
              value={chat.selectedMemberId}
              onChange={(e) => chat.selectMember(e.target.value)}
            >
              {scene.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberLabel(m, scene.members)}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {timeline ? <BranchTree chat={chat} onClose={() => setTimeline(false)} /> : null}
    </div>
  );
}
