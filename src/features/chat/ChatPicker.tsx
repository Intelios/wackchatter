import {
  type AuthorNotePosition,
  type ChatMetadata,
  type ChatSummary,
  DEFAULT_AUTHOR_NOTE,
} from '@shared/types/chat.ts';
import { useEffect, useRef, useState } from 'react';
import { CheckField, NumberField, SelectField, TextField } from '../../components/Field.tsx';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';

interface ChatPickerProps {
  chats: ChatSummary[];
  activeId: string | null;
  title: string;
  metadata: ChatMetadata;
  inheritedScenario: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (title: string) => void;
  onMetadataChange: (patch: Partial<ChatMetadata>) => void;
}

export function ChatPicker({
  chats,
  activeId,
  title,
  metadata,
  inheritedScenario,
  onOpen,
  onNew,
  onDelete,
  onRename,
  onMetadataChange,
}: ChatPickerProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const renameInput = useRef<HTMLInputElement>(null);
  const scenarioOverridden = typeof metadata.scenario === 'string';
  const authorNote = { ...DEFAULT_AUTHOR_NOTE, ...metadata.authorNote };

  function updateAuthorNote(patch: Partial<typeof authorNote>) {
    onMetadataChange({ authorNote: { ...authorNote, ...patch } });
  }

  // Focus on appearance rather than autoFocus, which would also grab focus on page load.
  useEffect(() => {
    if (renaming) renameInput.current?.select();
  }, [renaming]);

  return (
    <div className="chat-picker">
      <div className="chat-picker__top">
        {renaming ? (
          <input
            ref={renameInput}
            className="wc-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft.trim()) onRename(draft.trim());
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="chat-picker__title"
            onClick={() => {
              setDraft(title);
              setRenaming(true);
            }}
            title="Rename this chat"
          >
            {title || 'Untitled chat'}
          </button>
        )}

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

      {chats.length > 1 ? (
        <ul className="chat-picker__list">
          {chats.map((chat) => (
            <li key={chat.id} className="chat-picker__item" data-active={chat.id === activeId}>
              <button type="button" className="chat-picker__open" onClick={() => onOpen(chat.id)}>
                <span className="chat-picker__name">{chat.title}</span>
                <span className="chat-picker__preview">
                  {chat.lastMessage || 'No messages yet'}
                </span>
                <span className="chat-picker__count">{chat.messageCount} messages</span>
              </button>
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
