import {
  type AuthorNotePosition,
  type ChatMetadata,
  type ChatSummary,
  DEFAULT_AUTHOR_NOTE,
} from '@shared/types/chat.ts';
import { useEffect, useRef, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';
import { Markdown } from './Markdown.tsx';
import './ChatPicker.css';

interface ChatPickerProps {
  chats: ChatSummary[];
  activeId: string | null;
  metadata: ChatMetadata;
  inheritedScenario: string;
  /** The card's `creator_notes`, shown read-only. Empty hides the section entirely. */
  creatorNotes: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (title: string) => void;
  onMetadataChange: (patch: Partial<ChatMetadata>) => void;
}

export function ChatPicker({
  chats,
  activeId,
  metadata,
  inheritedScenario,
  creatorNotes,
  onOpen,
  onNew,
  onDelete,
  onRename,
  onMetadataChange,
}: ChatPickerProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const renameInput = useRef<HTMLInputElement>(null);
  const scenarioOverridden = typeof metadata.scenario === 'string';
  const authorNote = { ...DEFAULT_AUTHOR_NOTE, ...metadata.authorNote };

  function updateAuthorNote(patch: Partial<typeof authorNote>) {
    onMetadataChange({ authorNote: { ...authorNote, ...patch } });
  }

  // Focus on appearance rather than autoFocus, which would also grab focus on page load.
  useEffect(() => {
    if (renamingId) renameInput.current?.select();
  }, [renamingId]);

  return (
    <div className="chat-picker">
      <div className="chat-picker__top">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          onClick={onNew}
          title="Start a new chat"
          aria-label="New chat"
        >
          <PlusIcon />
        </button>
      </div>

      {chats.length > 0 ? (
        <ul className="chat-picker__list">
          {chats.map((chat) => (
            <li key={chat.id} className="chat-picker__item" data-active={chat.id === activeId}>
              {renamingId === chat.id ? (
                <input
                  ref={renameInput}
                  className="wc-input chat-picker__rename"
                  value={draft}
                  aria-label={`Rename ${chat.title}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => {
                    // Renaming targets the open chat; the guard drops a commit that raced
                    // the click-to-open of an inactive row.
                    if (draft.trim() && renamingId === activeId) onRename(draft.trim());
                    setRenamingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="chat-picker__open"
                  onClick={() => onOpen(chat.id)}
                  onDoubleClick={() => {
                    setDraft(chat.title);
                    setRenamingId(chat.id);
                  }}
                >
                  <span className="chat-picker__name" title="Double-click to rename">
                    {chat.title}
                  </span>
                  <span className="chat-picker__preview">
                    {chat.lastMessage || 'No messages yet'}
                  </span>
                  <span className="chat-picker__count">{chat.messageCount} messages</span>
                </button>
              )}
              <button
                type="button"
                className="wc-button wc-button--ghost wc-button--danger"
                onClick={() =>
                  confirming === chat.id ? onDelete(chat.id) : setConfirming(chat.id)
                }
                onBlur={() => setConfirming(null)}
                title={confirming === chat.id ? 'Click again to delete' : 'Delete this chat'}
                aria-label={confirming === chat.id ? 'Click again to delete' : 'Delete chat'}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Creator notes are how a card explains itself — who the character is, what the
        scenario expects of you, which greeting is which. Buried in the editor they may as
        well not exist, so they sit here, read-only, next to the other per-chat context.
      */}
      {creatorNotes.trim() ? (
        <details className="chat-picker__context">
          <summary>Creator notes</summary>
          <Markdown text={creatorNotes} className="chat-picker__notes" />
        </details>
      ) : null}

      {activeId ? (
        <details className="chat-picker__context">
          <summary>Chat Context</summary>
          <div className="chat-picker__context-body">
            <CheckField
              label="Override character scenario"
              checked={scenarioOverridden}
              onChange={(checked) =>
                onMetadataChange({ scenario: checked ? inheritedScenario : undefined })
              }
              hint="An enabled but empty override deliberately clears the scenario."
            />
            {scenarioOverridden ? (
              <TextField
                label="Scenario for this chat"
                value={metadata.scenario ?? ''}
                onChange={(scenario) => onMetadataChange({ scenario })}
                multiline
                rows={4}
                placeholder="Leave empty to clear the character scenario."
              />
            ) : (
              <p className="wc-hint">Inheriting: {inheritedScenario || 'No character scenario'}</p>
            )}

            <TextField
              label="Author’s Note"
              value={authorNote.text}
              onChange={(text) => updateAuthorNote({ text })}
              multiline
              rows={4}
              placeholder="A recurring instruction for this chat."
            />
            <div className="field-row">
              <NumberField
                label="Every N user turns"
                value={authorNote.interval}
                min={0}
                step={1}
                onChange={(interval) => updateAuthorNote({ interval: Math.floor(interval) })}
                hint="0 disables the note."
              />
              <SelectField<AuthorNotePosition>
                label="Position"
                value={authorNote.position}
                options={[
                  { label: 'Before scenario', value: 'beforeScenario' },
                  { label: 'After scenario', value: 'afterScenario' },
                  { label: 'At chat depth', value: 'atDepth' },
                ]}
                onChange={(position) => updateAuthorNote({ position })}
              />
            </div>
            {authorNote.position === 'atDepth' ? (
              <NumberField
                label="Depth"
                value={authorNote.depth}
                min={0}
                step={1}
                onChange={(depth) => updateAuthorNote({ depth: Math.floor(depth) })}
                hint="Messages back from the end."
              />
            ) : null}
            <SelectField<'system' | 'user' | 'assistant'>
              label="Role"
              value={authorNote.role}
              options={[
                { label: 'System', value: 'system' },
                { label: 'User', value: 'user' },
                { label: 'Assistant', value: 'assistant' },
              ]}
              onChange={(role) => updateAuthorNote({ role })}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
