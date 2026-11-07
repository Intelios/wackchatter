/**
 * The Lorebooks tool: what feeds this chat, and what the last reply took from it.
 *
 * The list opens on your books, the ones feeding the open chat first, each with the faces
 * of the cards that link it. A book lists its entries with their keys; the last reply's
 * marks say which fired and which were skipped, and the entry page says why. Opening an
 * entry widens the margin (the shell's `data-wide`), like a prompt in the Preset tool.
 *
 * A card's own book is read here and edited in the Studio: it lives inside the card, and
 * the Studio is where a card is written.
 */

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import {
  type LorebookSummary,
  WI_POSITION,
  type WiLogic,
  type WiPosition,
  type WiRole,
  type WorldInfoEntry,
  type WorldInfoSettings,
} from '@shared/types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { bookEntries } from '@shared/worldinfo/convert.ts';
import { type ReactNode, useEffect, useState } from 'react';
import type { LoreFilter, LorePage } from '../app/useAppController.ts';
import { CheckField, KeyField, SelectField } from '../components/Field.tsx';
import { Select } from '../components/Select.tsx';
import {
  EntryChanceFields,
  EntryMatchingFields,
  EntryRecursionFields,
  LOGIC_OPTIONS,
  labelFor,
  ROLE_OPTIONS,
} from '../features/lore/LorebookEditor.tsx';
import { useLorebookWorkbench } from '../features/lore/useLorebookWorkbench.ts';
import { characterApi, lorebookApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { Icon } from './icons.tsx';
import {
  type BookRow,
  bookRows,
  CARD_BOOK,
  firedByBook,
  lastReplyMarks,
  type ReplyMark,
  whyLine,
} from './lore.ts';
import { depthWords } from './personas.ts';
import './lore.css';
import './preset.css';
import './sheet.css';

export interface LoreToolProps {
  page: LorePage | null;
  setPage: (page: LorePage | null) => void;
  books: LorebookSummary[];
  characters: CharacterSummary[];
  characterAvatarVersions: Readonly<Record<string, number>>;
  /** The books the engine consults for the open chat. */
  sources: WorldInfoSource[];
  /** What World Info did on the open chat's last reply. */
  lastReply: ActivationResult | null;
  settings: WorldInfoSettings;
  onSettingsChange: (patch: Partial<WorldInfoSettings>) => void;
  onBooksChanged: () => void;
  onBookEdited: (id: string) => void;
  registerPersistence?: (controls: PersistenceControls | null) => void;
  countTokens: TokenCounter;
  /** The open card, whose own book this tool reads. */
  cardAvatar: string | null;
  onOpenStudio: (avatar: string) => void;
}

export function LoreTool(props: LoreToolProps) {
  const { page, setPage, settings, lastReply } = props;
  const bench = useLorebookWorkbench({
    selected: page && page.book !== CARD_BOOK ? page.book : null,
    setSelected: (id) => setPage(id ? { book: id, entry: null, filter: 'all' } : null),
    onBooksChanged: props.onBooksChanged,
    onBookEdited: props.onBookEdited,
    registerPersistence: props.registerPersistence,
  });

  const faceUrl = (card: CharacterSummary) =>
    characterApi.imageUrl(card.avatar, props.characterAvatarVersions[card.avatar] ?? card.modified);

  if (page) {
    const isCard = page.book === CARD_BOOK;
    const cardSource = props.sources.find((s) => s.kind === 'embedded');
    const entries = isCard ? (cardSource ? bookEntries(cardSource.book) : []) : bench.entries;
    const loading = isCard ? !cardSource : !bench.book;
    return (
      <div className="w3-lore">
        {bench.error ? (
          <p className="w3-persona__error" role="alert">
            {bench.error}
            <button type="button" onClick={bench.retry}>
              Retry save
            </button>
          </p>
        ) : null}
        <BookPage
          page={page}
          setPage={setPage}
          isCard={isCard}
          loading={loading}
          entries={entries}
          marks={lastReplyMarks(lastReply, page.book)}
          bench={bench}
          settings={settings}
          countTokens={props.countTokens}
          onOpenStudio={
            isCard && props.cardAvatar
              ? () => props.onOpenStudio(props.cardAvatar as string)
              : undefined
          }
        />
      </div>
    );
  }

  const { thisChat, other } = bookRows(props.books, props.characters, props.sources);
  const fired = firedByBook(lastReply);
  const firedTotal = lastReply?.activated.length ?? 0;
  const open = (id: string) =>
    void bench.selectBook(null).then(() => setPage({ book: id, entry: null, filter: 'all' }));

  const row = (book: BookRow) => (
    <button key={book.id} type="button" className="w3-book" onClick={() => open(book.id)}>
      <BookFaces cards={book.cards} faceUrl={faceUrl} />
      <span className="w3-book__text">
        <b>
          {book.name}
          {book.isCard ? <span className="w3-tag">card</span> : null}
        </b>
        <span>
          {book.isCard
            ? 'Inside the card'
            : book.cards.length
              ? `Linked to ${listNames(book.cards.map((card) => card.name))}`
              : 'Not linked to a card'}{' '}
          · {book.entryCount} {book.entryCount === 1 ? 'entry' : 'entries'}
        </span>
      </span>
      {fired.get(book.id) ? (
        <span className="w3-fired" title="Fired on the last reply">
          {fired.get(book.id)} fired
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="w3-lore">
      {bench.error ? (
        <p className="w3-persona__error" role="alert">
          {bench.error}
        </p>
      ) : null}
      {thisChat.length ? (
        <section className="w3-lore__group" aria-label="This chat">
          <h3 className="w3-sheet__label">
            This chat
            {lastReply ? (
              <small>
                last reply: {firedTotal} {firedTotal === 1 ? 'entry' : 'entries'} fired
              </small>
            ) : null}
          </h3>
          <div className="w3-books">{thisChat.map(row)}</div>
        </section>
      ) : null}
      <section className="w3-lore__group" aria-label="Your books">
        <h3 className="w3-sheet__label">{thisChat.length ? 'Other books' : 'Your books'}</h3>
        {other.length ? (
          <div className="w3-books">{other.map(row)}</div>
        ) : (
          <p className="w3-sheet__hint">
            {props.books.length ? 'Every book is in use here.' : 'No lorebooks yet.'}
          </p>
        )}
        <div className="w3-preset__adds">
          <button type="button" className="w3-preset__ghost" onClick={() => void bench.create()}>
            <Icon name="plus" size="xs" />
            New book
          </button>
          <label className="w3-preset__ghost">
            <Icon name="upload" size="xs" />
            Import
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void bench.importFile(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>
      <ScanSettings settings={settings} onChange={props.onSettingsChange} />
    </div>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function BookFaces({
  cards,
  faceUrl,
}: {
  cards: CharacterSummary[];
  faceUrl: (card: CharacterSummary) => string;
}) {
  return (
    <span className="w3-book__faces" aria-hidden="true">
      {cards.length ? (
        cards.slice(0, 2).map((card) => <img key={card.avatar} src={faceUrl(card)} alt="" />)
      ) : (
        <i>
          <Icon name="book" size="sm" />
        </i>
      )}
    </span>
  );
}

function Fold({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w3-hfold" data-open={open || undefined}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevronDown" size="xs" />
        {title}
        {meta ? <small>{meta}</small> : null}
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function ScanSettings({
  settings,
  onChange,
}: {
  settings: WorldInfoSettings;
  onChange: (patch: Partial<WorldInfoSettings>) => void;
}) {
  const number = (
    key: keyof WorldInfoSettings,
    label: string,
    hint: string,
    min = 0,
    max?: number,
  ) => (
    <label className="w3-lore__set">
      <span>
        {label}
        <small>{hint}</small>
      </span>
      <input
        type="number"
        value={settings[key] as number}
        min={min}
        max={max}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) onChange({ [key]: value });
        }}
      />
    </label>
  );
  const toggle = (key: keyof WorldInfoSettings, label: string) => (
    <label className="w3-htoggle">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        className="w3-switch"
        aria-checked={Boolean(settings[key])}
        onClick={() => onChange({ [key]: !settings[key] })}
      />
    </label>
  );
  return (
    <div className="w3-hfolds">
      <Fold
        title="Scan settings"
        meta={`Every chat · ${settings.depth} ${settings.depth === 1 ? 'message' : 'messages'}, ${settings.budget}%`}
      >
        {number('depth', 'Scan depth', 'Recent messages searched for keys')}
        {number('budget', 'Budget', 'Share of the context lore may use (%)', 0, 100)}
        {number('budgetCap', 'Budget cap', 'Tokens; 0 means no cap')}
        {number(
          'maxRecursionSteps',
          'Max recursion steps',
          'How many times entries may set off others',
          1,
        )}
        {toggle('recursive', 'Entries can set off other entries')}
        {toggle('caseSensitive', 'Case sensitive by default')}
        {toggle('matchWholeWords', 'Whole words by default')}
      </Fold>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A book

type Bench = ReturnType<typeof useLorebookWorkbench>;

function BookPage({
  page,
  setPage,
  isCard,
  loading,
  entries,
  marks,
  bench,
  settings,
  countTokens,
  onOpenStudio,
}: {
  page: LorePage;
  setPage: (page: LorePage | null) => void;
  isCard: boolean;
  loading: boolean;
  entries: WorldInfoEntry[];
  marks: Map<number, ReplyMark>;
  bench: Bench;
  settings: WorldInfoSettings;
  countTokens: TokenCounter;
  onOpenStudio?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const back = () => void bench.selectBook(null).then((ok) => ok && setPage(null));
  const setFilter = (filter: LoreFilter) => setPage({ ...page, filter, entry: null });
  const firedCount = entries.filter((e) => marks.get(e.uid)?.state === 'fired').length;
  const skippedCount = entries.filter((e) => marks.get(e.uid)?.state === 'skipped').length;
  const shown =
    page.filter === 'all'
      ? entries
      : entries.filter((e) => marks.get(e.uid)?.state === page.filter);
  const open = page.entry === null ? null : (entries.find((e) => e.uid === page.entry) ?? null);

  const list = (
    <EntryList
      entries={shown}
      marks={marks}
      open={page.entry}
      rail={Boolean(open)}
      readOnly={isCard}
      draggable={page.filter === 'all' && !isCard}
      onOpen={(uid) => setPage({ ...page, entry: page.entry === uid ? null : uid })}
      onToggle={(entry) => bench.updateEntry(entry.uid, { disable: !entry.disable })}
      onReorder={(uids) => bench.reorder(uids)}
    />
  );

  return (
    <div className="w3-lore__book">
      <button type="button" className="w3-sheet__back" onClick={back}>
        <Icon name="chevronLeft" size="sm" />
        All lorebooks
      </button>

      {loading ? <p className="w3-sheet__hint">Loading…</p> : null}

      {isCard ? (
        <div className="w3-lore__studio">
          <span>This book lives inside the card. Read it here; change it in the Studio.</span>
          {onOpenStudio ? (
            <button type="button" onClick={onOpenStudio}>
              <Icon name="studio" size="xs" />
              Open in Studio
            </button>
          ) : null}
        </div>
      ) : open ? null : (
        <BookTools
          name={page.book}
          onRename={(name) => void bench.rename(name)}
          exportUrl={lorebookApi.exportUrl(page.book)}
          confirmDelete={confirmDelete}
          onDelete={() => {
            if (!confirmDelete) return setConfirmDelete(true);
            setConfirmDelete(false);
            void bench.remove();
          }}
          onDisarm={() => setConfirmDelete(false)}
        />
      )}

      {open ? null : (
        <div className="w3-lore__filters">
          <button
            type="button"
            className="w3-chip"
            aria-pressed={page.filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All {entries.length}
          </button>
          <button
            type="button"
            className="w3-chip"
            aria-pressed={page.filter === 'fired'}
            onClick={() => setFilter('fired')}
            title="Went into the last reply"
          >
            Fired {firedCount}
          </button>
          <button
            type="button"
            className="w3-chip"
            aria-pressed={page.filter === 'skipped'}
            onClick={() => setFilter('skipped')}
            title="Matched the last reply but were left out"
          >
            Skipped {skippedCount}
          </button>
          {isCard ? null : (
            <button
              type="button"
              className="w3-preset__ghost w3-lore__add"
              onClick={() => {
                const uid = bench.addEntry();
                if (uid !== null) setPage({ ...page, filter: 'all', entry: uid });
              }}
            >
              <Icon name="plus" size="xs" />
              Entry
            </button>
          )}
        </div>
      )}

      {open ? (
        <div className="w3-preset__split">
          {list}
          <EntryEditor
            key={open.uid}
            entry={open}
            mark={marks.get(open.uid)}
            readOnly={isCard}
            settings={settings}
            countTokens={countTokens}
            onChange={(patch) => bench.updateEntry(open.uid, patch)}
            onDelete={() => {
              setPage({ ...page, entry: null });
              bench.deleteEntry(open.uid);
            }}
            onClose={() => setPage({ ...page, entry: null })}
          />
        </div>
      ) : shown.length ? (
        list
      ) : (
        <p className="w3-sheet__hint">
          {page.filter === 'fired'
            ? 'Nothing from this book went into the last reply.'
            : page.filter === 'skipped'
              ? 'Nothing from this book was skipped on the last reply.'
              : 'No entries yet.'}
        </p>
      )}
    </div>
  );
}

/** The book's name (which is its file name too), export and delete. */
function BookTools({
  name,
  onRename,
  exportUrl,
  confirmDelete,
  onDelete,
  onDisarm,
}: {
  name: string;
  onRename: (name: string) => void;
  exportUrl: string;
  confirmDelete: boolean;
  onDelete: () => void;
  onDisarm: () => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };
  return (
    <div className="w3-lore__tools">
      <input
        className="w3-lore__name"
        value={draft}
        aria-label="Book name"
        title="The file name too. Cards link to a book by name, so a rename follows them."
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(name);
          }
        }}
      />
      <a className="w3-preset__icon" href={exportUrl} download title="Export" aria-label="Export">
        <Icon name="download" size="sm" />
      </a>
      <button
        type="button"
        className="w3-preset__icon"
        data-armed={confirmDelete || undefined}
        title={confirmDelete ? 'Click again to delete' : 'Delete book'}
        aria-label={confirmDelete ? 'Click again to delete the book' : 'Delete book'}
        onClick={onDelete}
        onBlur={onDisarm}
      >
        <Icon name="trash" size="sm" />
        {confirmDelete ? <span>Click again</span> : null}
      </button>
    </div>
  );
}

export function EntryList({
  entries,
  marks,
  open,
  rail,
  readOnly,
  draggable,
  onOpen,
  onToggle,
  onReorder,
}: {
  entries: WorldInfoEntry[];
  marks: Map<number, ReplyMark>;
  open: number | null;
  rail: boolean;
  readOnly: boolean;
  draggable: boolean;
  onOpen: (uid: number) => void;
  onToggle: (entry: WorldInfoEntry) => void;
  onReorder: (uids: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = entries.findIndex((e) => e.uid === active.id);
    const to = entries.findIndex((e) => e.uid === over.id);
    if (from === -1 || to === -1) return;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onReorder(next.map((e) => e.uid));
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={entries.map((e) => e.uid)} strategy={verticalListSortingStrategy}>
        <ul className="w3-ents" data-rail={rail || undefined}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.uid}
              entry={entry}
              mark={marks.get(entry.uid)}
              open={open === entry.uid}
              readOnly={readOnly}
              draggable={draggable}
              onOpen={() => onOpen(entry.uid)}
              onToggle={() => onToggle(entry)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function EntryRow({
  entry,
  mark,
  open,
  readOnly,
  draggable,
  onOpen,
  onToggle,
}: {
  entry: WorldInfoEntry;
  mark: ReplyMark | undefined;
  open: boolean;
  readOnly: boolean;
  draggable: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.uid,
    disabled: !draggable,
  });
  const name = labelFor(entry);
  const matched = mark?.state === 'fired' ? mark.entry.matchedKey : undefined;
  const keys = entry.key.filter((key) => key.trim());
  return (
    <li
      ref={setNodeRef}
      className="w3-ent"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging || undefined}
      data-off={entry.disable || undefined}
      data-open={open || undefined}
      data-mark={mark?.state}
    >
      {draggable ? (
        <button
          type="button"
          className="w3-prompt__grip"
          aria-label={`Move ${name}`}
          {...attributes}
          {...listeners}
        >
          <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true" fill="currentColor">
            <circle cx="2" cy="3" r="1.3" />
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="2" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="2" cy="13" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        role="switch"
        className="w3-switch"
        aria-checked={!entry.disable}
        aria-label={`Use ${name}`}
        disabled={readOnly}
        title={readOnly ? 'Change this in the Studio' : undefined}
        onClick={onToggle}
      />
      <button type="button" className="w3-ent__main" onClick={onOpen} aria-expanded={open}>
        <span className="w3-ent__name">
          <b>{name}</b>
          {entry.constant ? <span className="w3-tag">always</span> : null}
          {entry.position === WI_POSITION.atDepth ? (
            <span className="w3-tag">@{entry.depth}</span>
          ) : null}
          {entry.group.trim() ? (
            <span className="w3-tag">{entry.group.split(/,\s*/)[0]}</span>
          ) : null}
          {mark ? (
            <span className="w3-ent__mark" data-mark={mark.state}>
              {mark.state}
            </span>
          ) : null}
        </span>
        <span className="w3-ent__keys">
          {entry.constant
            ? 'always on'
            : keys.length
              ? keys.map((key, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a book may repeat a key; its place is its identity
                  <span key={`${key}-${index}`}>
                    {index ? ', ' : ''}
                    {key === matched ? <em>{key}</em> : key}
                  </span>
                ))
              : 'no keys'}
        </span>
      </button>
      <span className="w3-ent__order">{entry.order}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// An entry

const PLACEMENTS: readonly { value: WiPosition; label: string }[] = [
  { value: WI_POSITION.before, label: 'before the card' },
  { value: WI_POSITION.after, label: 'after the card' },
  { value: WI_POSITION.atDepth, label: 'into the chat' },
  { value: WI_POSITION.ANTop, label: 'above the Author’s Note (as before)' },
  { value: WI_POSITION.ANBottom, label: 'below the Author’s Note (as after)' },
  { value: WI_POSITION.EMTop, label: 'above the examples (as before)' },
  { value: WI_POSITION.EMBottom, label: 'below the examples (as after)' },
  { value: WI_POSITION.outlet, label: 'to an outlet (as before)' },
];

export function EntryEditor({
  entry,
  mark,
  readOnly,
  settings,
  countTokens,
  onChange,
  onDelete,
  onClose,
  when,
}: {
  entry: WorldInfoEntry;
  mark: ReplyMark | undefined;
  readOnly: boolean;
  settings: WorldInfoSettings;
  countTokens: TokenCounter;
  onChange: (patch: Partial<WorldInfoEntry>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** In place of the last reply's line, where there is no chat to point at (the Studio). */
  when?: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newKey, setNewKey] = useState('');
  const why = when ?? whyLine(mark, entry, settings.depth);
  const matched = mark?.state === 'fired' ? mark.entry.matchedKey : undefined;
  const depth = entry.scanDepth ?? settings.depth;
  const word = <T,>(
    label: string,
    value: T,
    options: readonly { value: T; label: string }[],
    onPick: (value: T) => void,
  ) =>
    readOnly ? (
      <b className="w3-lore__word">
        {options.find((o) => o.value === value)?.label ?? String(value)}
      </b>
    ) : (
      <Select
        className="w3-word"
        label={label}
        value={value}
        options={options}
        onChange={onPick}
        searchable={false}
      />
    );
  const scanChoices = [
    {
      value: -1,
      label: `${settings.depth === 1 ? 'message' : `${settings.depth} messages`} (the default)`,
    },
    ...Array.from({ length: Math.max(11, depth + 1) }, (_, n) => ({
      value: n,
      label: n === 0 ? 'no messages (never scans)' : n === 1 ? 'message' : `${n} messages`,
    })),
  ];
  const addKey = () => {
    const key = newKey.trim();
    if (key && !entry.key.includes(key)) onChange({ key: [...entry.key, key] });
    setNewKey('');
  };

  return (
    <div className="w3-pe w3-lore__entry">
      <div className="w3-pe__top">
        {readOnly ? (
          <h3 className="w3-pe__title">{labelFor(entry)}</h3>
        ) : (
          <input
            className="w3-pe__name"
            value={entry.comment}
            placeholder={labelFor(entry)}
            aria-label="Memo"
            title="For your eyes only: it names the entry in this list."
            onChange={(event) => onChange({ comment: event.target.value })}
          />
        )}
        <button type="button" className="w3-margin__close" aria-label="Close" onClick={onClose}>
          <Icon name="close" size="sm" />
        </button>
      </div>

      <div className="w3-lore__why" data-mark={mark?.state ?? 'quiet'}>
        <small>{when ? 'When' : 'Last reply'}</small>
        {why}
      </div>

      <p className="w3-pe__how">
        {word(
          'When it fires',
          entry.constant,
          [
            { value: false, label: 'Fires when any key' },
            { value: true, label: 'Always on' },
          ],
          (constant: boolean) => onChange({ constant }),
        )}
        {entry.constant ? null : (
          <>
            {' '}
            appears in the last{' '}
            {word('Scan depth', entry.scanDepth ?? -1, scanChoices, (value: number) =>
              onChange({ scanDepth: value < 0 ? null : value }),
            )}
          </>
        )}
        , sent{' '}
        {word('Where it goes', entry.position, PLACEMENTS, (position: WiPosition) =>
          onChange({ position }),
        )}
        {entry.position === WI_POSITION.atDepth ? (
          <>
            ,{' '}
            {word(
              'Depth',
              entry.depth,
              Array.from({ length: Math.max(21, entry.depth + 1) }, (_, value) => ({
                value,
                label: depthWords(value),
              })),
              (value: number) => onChange({ depth: value }),
            )}{' '}
            as a{' '}
            {word(
              'Role',
              entry.role,
              ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label.toLowerCase() })),
              (role: WiRole) => onChange({ role }),
            )}{' '}
            message
          </>
        ) : null}
        .
      </p>

      {entry.constant ? null : (
        <div className="w3-lore__keys">
          {entry.key.map((key, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a book may repeat a key; its place is its identity
              key={`${key}-${index}`}
              className="w3-lore__key"
              data-hit={key === matched || undefined}
            >
              {key}
              {readOnly ? null : (
                <button
                  type="button"
                  aria-label={`Remove the key ${key}`}
                  onClick={() => onChange({ key: entry.key.filter((_, i) => i !== index) })}
                >
                  <Icon name="close" size="xs" />
                </button>
              )}
            </span>
          ))}
          {readOnly ? null : (
            <input
              value={newKey}
              placeholder="Add a key"
              aria-label="Add a key"
              title="Enter adds it. A /pattern/flags key is a regex."
              onChange={(event) => setNewKey(event.target.value)}
              onBlur={addKey}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') {
                  event.preventDefault();
                  addKey();
                }
              }}
            />
          )}
        </div>
      )}

      {readOnly ? (
        <div className="w3-lore__read">{entry.content}</div>
      ) : (
        <textarea
          className="w3-lore__text"
          value={entry.content}
          placeholder="What the model is told when this entry fires."
          aria-label="Content"
          spellCheck={false}
          onChange={(event) => onChange({ content: event.target.value })}
        />
      )}

      {readOnly ? null : (
        <div className="w3-hfolds">
          <Fold
            title="Matching"
            meta={entry.selective && entry.keysecondary.length ? 'Secondary keys' : 'Book defaults'}
          >
            {entry.constant ? null : (
              <>
                <CheckField
                  label="Also needs secondary keys"
                  checked={entry.selective}
                  onChange={(selective) => onChange({ selective })}
                />
                {entry.selective ? (
                  <>
                    <KeyField
                      label="Secondary keys"
                      value={entry.keysecondary}
                      onChange={(keysecondary) => onChange({ keysecondary })}
                    />
                    <SelectField<WiLogic>
                      label="Secondary logic"
                      value={entry.selectiveLogic}
                      options={LOGIC_OPTIONS}
                      onChange={(selectiveLogic) => onChange({ selectiveLogic })}
                    />
                  </>
                ) : null}
              </>
            )}
            <EntryMatchingFields entry={entry} globals={settings} onChange={onChange} />
          </Fold>
          <Fold
            title="Chance and groups"
            meta={
              [
                entry.useProbability && entry.probability < 100 ? `${entry.probability}%` : '',
                entry.group.trim() ? `Group: ${entry.group.split(/,\s*/)[0]}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'Always'
            }
          >
            <EntryChanceFields entry={entry} onChange={onChange} />
          </Fold>
          <Fold
            title="Recursion and budget"
            meta={entry.ignoreBudget ? 'Ignores the budget' : 'Default'}
          >
            <EntryRecursionFields entry={entry} onChange={onChange} />
          </Fold>
        </div>
      )}

      <div className="w3-pe__foot">
        <span>
          <b>{countTokens.countText(entry.content).toLocaleString()}</b> tokens · order{' '}
          {readOnly ? (
            entry.order
          ) : (
            <input
              className="w3-pe__order"
              type="number"
              value={entry.order}
              aria-label="Insertion order"
              title="Higher sits closer to the chat"
              onChange={(event) => onChange({ order: Number(event.target.value) })}
            />
          )}
        </span>
        {readOnly ? null : (
          <button
            type="button"
            className="w3-preset__ghost"
            data-armed={confirmDelete || undefined}
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
          >
            <Icon name="trash" size="xs" />
            {confirmDelete ? 'Click again to delete' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}
