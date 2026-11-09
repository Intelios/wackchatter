/**
 * What the island shows in each of its shapes. Markup over props: the shell decides what
 * is true and what each button does.
 */

import type { ModelRef } from '@shared/models/slots.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary, Persona } from '@shared/types/chat.ts';
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { formatTimestamp } from '../features/chat/formatDate.ts';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { useModels } from '../features/models/ModelsContext.tsx';
import { modelName } from '../features/models/pickerLogic.ts';
import { Avatar } from './Avatar.tsx';
import { useArm } from './controls.tsx';
import type { IslandMode } from './Island.tsx';
import { Icon, type IconName } from './icons.tsx';
import { introLine } from './intro.ts';

export interface Face {
  name: string;
  url: string | null;
}

// --- Rest ---------------------------------------------------------------------

export function RestPane({
  character,
  chatTitle,
  persona,
  model,
  onOpen,
}: {
  /** None on the home screen, where nobody is in the scene yet. */
  character: Face | null;
  chatTitle: string;
  persona: Face | null;
  /** The chat's model, one click from changing. None on the home screen. */
  model?: ModelRef | null;
  onOpen: (mode: IslandMode) => void;
}) {
  return (
    <>
      {character ? (
        <>
          <button
            type="button"
            className="w3-isl-btn"
            aria-label={`${character.name}: switch character or chat`}
            onClick={() => onOpen('cast')}
          >
            <Avatar url={character.url} name={character.name} size="sm" />
            <span className="w3-isl-stack">
              <span className="w3-who-name">{character.name}</span>
              <span className="w3-who-sub">{chatTitle}</span>
            </span>
            <Icon name="chevronDown" size="sm" />
          </button>
          <span className="w3-isl-sep" aria-hidden="true" />
        </>
      ) : null}
      {model !== undefined ? (
        <>
          <ChatModelButton value={model} onOpen={() => onOpen('model')} />
          <span className="w3-isl-sep" aria-hidden="true" />
        </>
      ) : null}
      <button
        type="button"
        className="w3-isl-btn"
        aria-label="Switch persona"
        onClick={() => onOpen('persona')}
      >
        <Avatar url={persona?.url} name={persona?.name ?? '?'} size="sm" who="me" />
        <span className="w3-isl-stack">
          <span className="w3-me-name">{persona?.name ?? 'No persona'}</span>
          <span className="w3-who-sub">Your persona</span>
        </span>
      </button>
      <button
        type="button"
        className="w3-isl-search"
        aria-label="Search everything"
        onClick={() => onOpen('search')}
      >
        <Icon name="search" />
        <kbd className="w3-kbd">⌘K</kbd>
      </button>
    </>
  );
}

/** The chat's model on the island: its name, and a click opens the picker. */
function ChatModelButton({ value, onOpen }: { value: ModelRef | null; onOpen: () => void }) {
  const { catalogs } = useModels();
  const name = value ? (modelName(value, catalogs).split('/').pop() ?? value.modelId) : null;
  return (
    <button
      type="button"
      className="w3-isl-btn w3-isl-model"
      data-missing={name ? undefined : true}
      aria-label={name ? `Model: ${name}. Change it` : 'Choose a model'}
      title="The model writing this chat"
      onClick={onOpen}
    >
      <i aria-hidden="true" />
      <span className="w3-isl-stack">
        <span className="w3-who-sub">Model</span>
        <span className="w3-isl-model__name">{name ?? 'Choose a model'}</span>
      </span>
    </button>
  );
}

// --- Generating ---------------------------------------------------------------

const IDLE = { text: '', reasoning: '', active: false, incremental: false };

export function GenPane({
  who,
  isPersona,
  label,
  thinkingLabel,
  stream,
  live,
  detail,
  stopLabel = 'Stop',
  onStop,
  lore,
  onOpenLore,
}: {
  who: Face;
  isPersona?: boolean;
  label: string;
  /** Shown instead of `label` while only reasoning has arrived. */
  thinkingLabel?: string;
  stream: StreamStore;
  /** Subscribe to the stream; off while nothing is generating. */
  live: boolean;
  /** Overrides the word count, e.g. a summary's progress. */
  detail?: string;
  stopLabel?: string;
  onStop: () => void;
  /**
   * The lore this reply fired, once the request is built. A new one unfurls its names
   * across the island for a moment, then folds to a small book with the count.
   */
  lore?: LoreMomentInfo | null;
  onOpenLore?: () => void;
}) {
  const unfurled = useUnfurl(lore ?? null);
  const snapshot = useSyncExternalStore(
    (listener) => (live ? stream.subscribe(listener) : () => {}),
    () => (live ? stream.getSnapshot() : IDLE),
  );
  const [start, setStart] = useState(() => Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    if (!live) return;
    setStart(Date.now());
    const timer = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, [live]);

  const words = countWords(snapshot.text);
  const thinking = Boolean(snapshot.reasoning) && !snapshot.text;
  const seconds = Math.max(0, (Date.now() - start) / 1000).toFixed(1);
  const count =
    detail ??
    (thinking
      ? `${countWords(snapshot.reasoning)} words of reasoning · ${seconds} s`
      : words
        ? `${words} words · ${seconds} s`
        : `Waiting for the first words · ${seconds} s`);

  return (
    <>
      <span className="w3-gen-av">
        <Avatar url={who.url} name={who.name} size="sm" who={isPersona ? 'me' : 'char'} />
      </span>
      <span className="w3-wave" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      {lore && unfurled ? (
        <button
          type="button"
          className="w3-lore-unfurl"
          onClick={onOpenLore}
          title="Open Lorebooks on what fired"
        >
          <Icon name="book" size="sm" />
          <b>{lore.count} lore</b>
          <span>{lore.names.join(', ')}</span>
          {lore.more ? <em>+{lore.more}</em> : null}
        </button>
      ) : (
        <span className="w3-isl-stack" role="status">
          <span className="w3-gen-label">{thinking && thinkingLabel ? thinkingLabel : label}</span>
          <span className="w3-gen-count">{count}</span>
        </span>
      )}
      {lore && !unfurled ? (
        <button
          type="button"
          className="w3-lore-chip"
          onClick={onOpenLore}
          title={`${lore.count} lore ${lore.count === 1 ? 'entry' : 'entries'} fired. Open Lorebooks`}
          aria-label={`${lore.count} lore entries fired. Open Lorebooks`}
        >
          <Icon name="book" size="xs" />
          {lore.count}
        </button>
      ) : null}
      <button type="button" className="w3-isl-stop" onClick={onStop}>
        <Icon name="stop" />
        {stopLabel}
      </button>
    </>
  );
}

export interface LoreMomentInfo {
  /** Changes with each reply's lore; a new one unfurls again. */
  key: object;
  count: number;
  names: string[];
  more: number;
}

/** How long the names stay spelled out before folding to the book. */
const UNFURL_MS = 2200;

/** True for a moment after a new reply's lore arrives. */
function useUnfurl(lore: LoreMomentInfo | null): boolean {
  const [shown, setShown] = useState<object | null>(null);
  const key = lore?.key ?? null;
  useEffect(() => {
    if (!key) return;
    setShown(key);
    const timer = setTimeout(() => setShown(null), UNFURL_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return Boolean(key) && shown === key;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// --- Character and chat ---------------------------------------------------------

export interface CastAction {
  id: string;
  label: string;
  icon: IconName;
  run: () => void;
  disabledReason?: string;
  /** Destructive: the first click arms it and shows this label, the second runs it. */
  confirmLabel?: string;
}

export function CastPane({
  active,
  character,
  description,
  recent,
  avatarUrl,
  onPickCharacter,
  onAllCharacters,
  onReadCard,
  onEditCharacter,
  chatTitle,
  messageCount,
  hasChat,
  onRename,
  renameDisabledReason,
  actions,
  chats,
  currentChatId,
  onOpenChat,
  onDeleteChat,
  deleteDisabledReason,
}: {
  active: boolean;
  character: CharacterSummary;
  description: string;
  recent: CharacterSummary[];
  avatarUrl: (avatar: string) => string;
  onPickCharacter: (avatar: string) => void;
  onAllCharacters: () => void;
  onReadCard: () => void;
  onEditCharacter: () => void;
  chatTitle: string;
  messageCount: number;
  hasChat: boolean;
  onRename: (title: string) => void;
  renameDisabledReason?: string;
  actions: CastAction[];
  chats: ChatSummary[];
  currentChatId: string | null;
  onOpenChat: (id: string) => void;
  /** Sends a chat to the trash bin, where it can be restored. */
  onDeleteChat: (id: string) => void;
  deleteDisabledReason?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const arm = useArm();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) setRenaming(false);
  }, [active]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  }, [renaming]);

  const commit = (value: string) => {
    const title = value.trim();
    if (title && title !== chatTitle) onRename(title);
    setRenaming(false);
  };

  const others = chats.filter((chat) => chat.id !== currentChatId);

  return (
    <>
      <div className="w3-cast-top">
        <Avatar url={avatarUrl(character.avatar)} name={character.name} size="lg" />
        <span className="w3-cast-top__grow">
          <b>{character.name}</b>
          {description ? <span>{description}</span> : null}
        </span>
        <button type="button" className="w3-pill" onClick={onReadCard}>
          <Icon name="card" size="sm" />
          Read card
        </button>
        <button type="button" className="w3-pill" onClick={onEditCharacter}>
          <Icon name="pencil" size="sm" />
          Edit
        </button>
      </div>

      {recent.length > 1 ? (
        <>
          <div className="w3-p-head">
            Recent characters
            <button type="button" className="w3-linkish" onClick={onAllCharacters}>
              All characters
            </button>
          </div>
          <div className="w3-cast-row">
            {recent.map((summary) => (
              <button
                key={summary.avatar}
                type="button"
                className="w3-cast-pick"
                aria-current={summary.avatar === character.avatar}
                onClick={() => onPickCharacter(summary.avatar)}
              >
                <Avatar url={avatarUrl(summary.avatar)} name={summary.name} size="lg" />
                <span>{summary.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="w3-p-head">
        {hasChat ? 'This chat' : 'No chat open'}
        {hasChat ? <span>{plural(messageCount, 'message')}</span> : null}
      </div>
      {hasChat ? (
        <div className="w3-chat-title">
          {renaming ? (
            <input
              ref={inputRef}
              className="w3-ct-in"
              defaultValue={chatTitle}
              aria-label="Chat name"
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit(event.currentTarget.value);
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setRenaming(false);
                }
              }}
              onBlur={(event) => commit(event.currentTarget.value)}
            />
          ) : (
            <button
              type="button"
              className="w3-ct"
              title={renameDisabledReason ?? 'Rename this chat'}
              disabled={Boolean(renameDisabledReason)}
              onClick={() => setRenaming(true)}
            >
              <span>{chatTitle}</span>
              <Icon name="pencil" size="sm" />
            </button>
          )}
        </div>
      ) : null}
      <div className="w3-chat-acts">
        {actions.map((action) => {
          const armed = arm.armed === `act:${action.id}`;
          return (
            <button
              key={action.id}
              type="button"
              className="w3-pill"
              data-armed={armed || undefined}
              onClick={() =>
                action.confirmLabel ? arm.press(`act:${action.id}`, action.run) : action.run()
              }
              onBlur={() => armed && arm.disarm()}
              disabled={Boolean(action.disabledReason)}
              title={action.disabledReason ?? (armed ? 'Click again to confirm' : action.label)}
            >
              <Icon name={action.icon} size="sm" />
              {armed ? action.confirmLabel : action.label}
            </button>
          );
        })}
      </div>

      <div className="w3-p-head">
        {hasChat ? 'Other chats' : 'Chats'} with {character.name}
      </div>
      <div className="w3-opt-list">
        {others.length ? (
          others.map((chat) => (
            <div key={chat.id} className="w3-opt-row">
              <button type="button" className="w3-opt" onClick={() => onOpenChat(chat.id)}>
                <span className="w3-opt__ico">
                  <Icon name="chat" size="sm" />
                </span>
                <span className="w3-opt__grow">
                  <span className="w3-opt__t">{chat.title}</span>
                  <span className="w3-opt__s">
                    {chat.lastMessage
                      ? chat.lastMessage.slice(0, 120)
                      : plural(chat.messageCount, 'message')}
                  </span>
                </span>
                <span className="w3-opt__k">{formatTimestamp(chat.modified)?.short ?? ''}</span>
              </button>
              <button
                type="button"
                className="w3-opt-x"
                data-armed={arm.armed === `del:${chat.id}` || undefined}
                disabled={Boolean(deleteDisabledReason)}
                aria-label={`Delete ${chat.title}`}
                title={
                  deleteDisabledReason ??
                  (arm.armed === `del:${chat.id}`
                    ? 'Click again to delete. It goes to the trash bin.'
                    : 'Delete this chat')
                }
                onClick={() => arm.press(`del:${chat.id}`, () => onDeleteChat(chat.id))}
                onBlur={() => arm.armed === `del:${chat.id}` && arm.disarm()}
              >
                {arm.armed === `del:${chat.id}` ? 'Delete?' : <Icon name="trash" size="sm" />}
              </button>
            </div>
          ))
        ) : (
          <div className="w3-p-foot">
            <span>No other chats yet.</span>
          </div>
        )}
      </div>
    </>
  );
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}

// --- Persona ------------------------------------------------------------------

export function PersonaPane({
  personas,
  activeId,
  recentIds,
  avatarUrl,
  onPick,
  onManage,
}: {
  personas: Persona[];
  activeId: string | null;
  recentIds: readonly string[];
  avatarUrl: (persona: Persona) => string | null;
  onPick: (id: string | null) => void;
  onManage: () => void;
}) {
  const ordered = useMemo(() => {
    const rank = new Map(recentIds.map((id, index) => [id, index]));
    return [...personas].sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.name.localeCompare(b.name),
    );
  }, [personas, recentIds]);

  return (
    <>
      <div className="w3-p-head">
        You are
        <span>Each chat remembers who you were</span>
      </div>
      <div className="w3-opt-list">
        {ordered.map((persona) => (
          <button
            key={persona.id}
            type="button"
            className="w3-opt"
            onClick={() => onPick(persona.id)}
          >
            <Avatar url={avatarUrl(persona)} name={persona.name} size="sm" who="me" />
            <span className="w3-opt__grow">
              <span className="w3-opt__t">
                {persona.name}
                {persona.variantLabel ? ` (${persona.variantLabel})` : ''}
              </span>
              {introLine(persona.description) ? (
                <span className="w3-opt__s">{introLine(persona.description)}</span>
              ) : null}
            </span>
            {persona.id === activeId ? (
              <span className="w3-opt__ok">
                <Icon name="check" size="sm" />
              </span>
            ) : null}
          </button>
        ))}
        <button type="button" className="w3-opt" onClick={() => onPick(null)}>
          <span className="w3-opt__ico">
            <Icon name="close" size="sm" />
          </span>
          <span className="w3-opt__grow">
            <span className="w3-opt__t">No persona</span>
          </span>
          {activeId === null ? (
            <span className="w3-opt__ok">
              <Icon name="check" size="sm" />
            </span>
          ) : null}
        </button>
      </div>
      <div className="w3-p-foot">
        <span>Variants and editing live in Personas.</span>
        <button type="button" className="w3-pill" onClick={onManage}>
          Manage personas
        </button>
      </div>
    </>
  );
}

// --- Search (⌘K) --------------------------------------------------------------

export interface SearchItem {
  key: string;
  kind: string;
  label: string;
  sub?: string;
  /** More words it answers to, never shown. */
  terms?: string;
  icon?: IconName;
  face?: Face & { me?: boolean };
  run: () => void;
}

export function SearchPane({
  active,
  items,
  onRun,
  placeholder = 'Jump to a character, chat, persona, tool or app',
}: {
  active: boolean;
  items: SearchItem[];
  onRun: (item: SearchItem) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [hot, setHot] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) {
      setQuery('');
      setHot(0);
      // After the morph has started, so the focus does not fight the animation.
      const timer = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 60);
      return () => clearTimeout(timer);
    }
  }, [active]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Personas and settings wait to be asked for by name.
      return items.filter((item) => item.kind !== 'Persona' && item.kind !== 'Setting').slice(0, 9);
    }
    return items
      .filter((item) =>
        `${item.label} ${item.sub ?? ''} ${item.terms ?? ''} ${item.kind}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 9);
  }, [items, query]);

  const current = Math.min(hot, Math.max(0, results.length - 1));

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHot((n) => Math.min(results.length - 1, n + 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHot((n) => Math.max(0, n - 1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[current];
      if (item) onRun(item);
    }
  };

  return (
    <>
      <label className="w3-p-field">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHot(0);
          }}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label="Search everything"
          aria-controls="w3-search-results"
        />
      </label>
      <div className="w3-opt-list" id="w3-search-results" ref={listRef} role="listbox">
        {results.length ? (
          results.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === current}
              className="w3-opt"
              data-hot={index === current || undefined}
              onPointerMove={() => setHot(index)}
              onClick={() => onRun(item)}
            >
              {item.face ? (
                <Avatar
                  url={item.face.url}
                  name={item.face.name}
                  size="sm"
                  who={item.face.me ? 'me' : 'char'}
                />
              ) : (
                <span className="w3-opt__ico">
                  <Icon name={item.icon ?? 'search'} size="sm" />
                </span>
              )}
              <span className="w3-opt__grow">
                <span className="w3-opt__t">{item.label}</span>
                {item.sub ? <span className="w3-opt__s">{item.sub}</span> : null}
              </span>
              <span className="w3-opt__k">{item.kind}</span>
            </button>
          ))
        ) : (
          <div className="w3-p-foot">
            <span>Nothing matches “{query}”.</span>
          </div>
        )}
      </div>
      <div className="w3-p-foot">
        <span>↑ ↓ to move, Enter to open</span>
        <span>Esc closes</span>
      </div>
    </>
  );
}

// --- "Previously on…" -----------------------------------------------------------

export function RecapPane({
  title,
  status,
  text,
  error,
  stream,
  modelName,
  dropped,
  onStop,
  onClose,
}: {
  title: string;
  status: 'active' | 'done' | 'failed';
  text: string;
  error: string | null;
  stream: StreamStore;
  modelName: string | null;
  /** Messages too old to fit the recap's budget. */
  dropped: number;
  onStop: () => void;
  onClose: () => void;
}) {
  const live = status === 'active';
  const snapshot = useSyncExternalStore(
    (listener) => (live ? stream.subscribe(listener) : () => {}),
    () => (live ? stream.getSnapshot() : IDLE),
  );
  const shown = live ? (snapshot.active ? snapshot.text : '') : text;

  return (
    <>
      <span className="w3-recap-eyebrow">Previously on</span>
      <h3 className="w3-recap-title">{title}</h3>
      {status === 'failed' ? (
        <p className="w3-recap-text" data-failed>
          {error ?? 'The recap could not be written.'}
        </p>
      ) : (
        <p className="w3-recap-text">
          {shown || (live ? 'Reading back through the chat…' : 'The recap came back empty.')}
        </p>
      )}
      <div className="w3-p-foot">
        <span>
          {modelName ? `Written by ${modelName} from this chat alone.` : 'From this chat alone.'}
          {dropped > 0 ? ` The oldest ${plural(dropped, 'message')} did not fit.` : ''}
        </span>
        {live ? (
          <button type="button" className="w3-pill" onClick={onStop}>
            <Icon name="stop" size="sm" />
            Stop
          </button>
        ) : (
          <button type="button" className="w3-pill" onClick={onClose}>
            Back to the scene
          </button>
        )}
      </div>
    </>
  );
}
