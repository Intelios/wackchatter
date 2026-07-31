import type { ChatSummary } from '@shared/types/chat.ts';
import { useEffect, useRef, useState } from 'react';
import { PlusIcon, TrashIcon } from '../../layout/icons.tsx';

interface ChatPickerProps {
  chats: ChatSummary[];
  activeId: string | null;
  title: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (title: string) => void;
}

export function ChatPicker({
  chats,
  activeId,
  title,
  onOpen,
  onNew,
  onDelete,
  onRename,
}: ChatPickerProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const renameInput = useRef<HTMLInputElement>(null);

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
    </div>
  );
}
