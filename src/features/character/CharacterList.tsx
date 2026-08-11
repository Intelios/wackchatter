import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CharacterSummary } from '@shared/types/card.ts';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, type MenuEntry } from '../../components/Menu.tsx';
import {
  ChevronIcon,
  EditIcon,
  FolderIcon,
  GripIcon,
  MoreIcon,
  PlusIcon,
  StarIcon,
  UploadIcon,
} from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { buildCharacterTree, type TreeRow } from './characterTree.ts';
import './CharacterList.css';

interface CharacterListProps {
  characters: CharacterSummary[];
  /** Folder paths from the server, including empty ones. */
  folders: string[];
  collapsedFolders: string[];
  /** The user's ratings, keyed by avatar filename. Absent means unrated. */
  ratings: Readonly<Record<string, number>>;
  /** How the cards are ordered within each folder. */
  sort: 'name' | 'rating';
  onSortChange: (sort: 'name' | 'rating') => void;
  selected: string | null;
  loading: boolean;
  error: string | null;
  /** Open this character's chat. */
  onSelect: (avatar: string) => void;
  /** Open this character's card in the editor. */
  onEdit: (avatar: string) => void;
  onRefresh: () => void;
  onCollapsedFoldersChange: (next: string[]) => void;
}

/**
 * Drop targets are folder paths, and '' is a legitimate one (the top level), so the id has
 * to be prefixed — a bare '' is falsy and dnd-kit would treat it as no target at all.
 */
const DROP_PREFIX = 'folder:';

export function CharacterList({
  characters,
  folders,
  collapsedFolders,
  ratings,
  sort,
  onSortChange,
  selected,
  loading,
  error,
  onSelect,
  onEdit,
  onRefresh,
  onCollapsedFoldersChange,
}: CharacterListProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<CharacterSummary | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;

  const rows = useMemo(
    () =>
      buildCharacterTree({
        characters,
        folders,
        collapsed: collapsedFolders,
        query,
        sort,
        ratings,
      }),
    [characters, folders, collapsedFolders, query, sort, ratings],
  );

  // Matching PromptManager: a small distance threshold so a plain click on the grip is still
  // a click, and a drag only begins once the pointer has actually moved.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function toggleFolder(path: string) {
    onCollapsedFoldersChange(
      collapsedFolders.includes(path)
        ? collapsedFolders.filter((entry) => entry !== path)
        : [...collapsedFolders, path],
    );
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }

  async function handleImport(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setActionError(null);

    // Import each file independently so one bad card doesn't abort the batch.
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await characterApi.import(file);
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }

    setBusy(false);
    if (failures.length) setActionError(failures.join('\n'));
    onRefresh();
  }

  async function handleCreate() {
    setBusy(true);
    setActionError(null);
    try {
      const created = await characterApi.create('New Character');
      onRefresh();
      // A blank card needs filling in before it can be chatted with.
      onEdit(created.avatar);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleNewFolder(parent = '') {
    const base = parent ? `${parent}/New folder` : 'New folder';
    void run(async () => {
      const { path } = await characterApi.folders.create(freeFolderName(base, folders));
      // Straight into rename: a folder called "New folder" is never what anyone wanted.
      setRenaming(path);
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);

    const over = event.over?.id;
    if (typeof over !== 'string' || !over.startsWith(DROP_PREFIX)) return;

    const avatar = String(event.active.id);
    const target = over.slice(DROP_PREFIX.length);
    const current = characters.find((character) => character.avatar === avatar);
    if (!current || current.folder === target) return;

    void run(() => characterApi.setFolder(avatar, target));
  }

  const message = error ?? actionError;

  return (
    <div className="character-list">
      <div className="character-list__search">
        <input
          className="wc-input"
          type="search"
          placeholder="Search characters…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search characters"
        />
        <select
          className="wc-select character-list__sort"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as 'name' | 'rating')}
          aria-label="Sort characters"
          title="Sort characters"
        >
          <option value="name">Name</option>
          <option value="rating">Rating</option>
        </select>
      </div>

      {message ? <div className="character-list__error">{message}</div> : null}

      <DndContext
        sensors={sensors}
        // pointerWithin rather than closestCenter: these are containers, not a sorted list, so
        // a drop should only register when the pointer is genuinely over a folder. Releasing
        // in empty space means "never mind", not "put it in whatever was nearest".
        collisionDetection={pointerWithin}
        onDragStart={(event: DragStartEvent) =>
          setDragging(characters.find((c) => c.avatar === String(event.active.id)) ?? null)
        }
        onDragCancel={() => setDragging(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="character-list__items">
          {/* Only while dragging a card that is in a folder — otherwise it is a target that
              would do nothing, taking up space at the top of every library. */}
          {dragging?.folder ? <RootDropZone /> : null}

          {loading ? (
            <div className="wc-empty">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="wc-empty">
              {characters.length === 0 ? (
                <>
                  <span>No characters yet.</span>
                  <span>Import a SillyTavern card to get started.</span>
                </>
              ) : (
                <span>No characters match “{query}”.</span>
              )}
            </div>
          ) : (
            rows.map((row) =>
              row.kind === 'folder' ? (
                <FolderRow
                  key={`folder:${row.path}`}
                  row={row}
                  renaming={renaming === row.path}
                  busy={busy}
                  onToggle={() => toggleFolder(row.path)}
                  onStartRename={() => setRenaming(row.path)}
                  onRename={(name) => {
                    setRenaming(null);
                    const parent = row.path.slice(0, row.path.length - row.name.length);
                    if (name && name !== row.name) {
                      void run(() => characterApi.folders.rename(row.path, `${parent}${name}`));
                    }
                  }}
                  onNewSubfolder={() => handleNewFolder(row.path)}
                  onDelete={() => void run(() => characterApi.folders.remove(row.path))}
                />
              ) : (
                <CharacterRow
                  key={row.character.avatar}
                  character={row.character}
                  depth={row.depth}
                  rating={ratings[row.character.avatar]}
                  showFolder={searching}
                  draggable={!searching}
                  current={row.character.avatar === selected}
                  onSelect={() => onSelect(row.character.avatar)}
                  onEdit={() => onEdit(row.character.avatar)}
                />
              ),
            )
          )}
        </div>

        {/* The ghost under the cursor. Rendered outside the scroll container so it is not
            clipped when dragging past the top or bottom edge of the list. */}
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="character-card character-card--ghost">
              <img
                className="character-card__avatar"
                src={characterApi.imageUrl(dragging.avatar, dragging.modified)}
                alt=""
              />
              <span className="character-card__name">{dragging.name}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="character-list__footer">
        <button
          type="button"
          className="wc-button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <UploadIcon />
          Import
        </button>
        <button type="button" className="wc-button" disabled={busy} onClick={handleCreate}>
          <PlusIcon />
          New
        </button>
        <button
          type="button"
          className="wc-button"
          disabled={busy}
          onClick={() => handleNewFolder()}
          title="New folder"
        >
          <FolderIcon />
          Folder
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".png,.json"
          multiple
          className="wc-visually-hidden"
          onChange={(e) => {
            handleImport(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

/** The way back out of a folder. Only mounted mid-drag, so it never sits there at rest. */
function RootDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: DROP_PREFIX });
  return (
    <div ref={setNodeRef} className="character-list__root-drop" data-over={isOver || undefined}>
      Move to top level
    </div>
  );
}

interface FolderRowProps {
  row: Extract<TreeRow, { kind: 'folder' }>;
  renaming: boolean;
  busy: boolean;
  onToggle: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onNewSubfolder: () => void;
  onDelete: () => void;
}

function FolderRow({
  row,
  renaming,
  busy,
  onToggle,
  onStartRename,
  onRename,
  onNewSubfolder,
  onDelete,
}: FolderRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DROP_PREFIX}${row.path}` });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const entries: MenuEntry[] = [
    { label: 'New subfolder', onSelect: onNewSubfolder },
    { label: 'Rename', onSelect: onStartRename },
    { kind: 'separator' },
    {
      // Says what it does, because it does not do the frightening thing: the cards come out
      // to the top level and keep their chats. Only the container goes.
      label: confirmDelete ? 'Really delete folder?' : 'Delete folder',
      danger: true,
      keepOpen: !confirmDelete,
      disabled: busy,
      onSelect: () => {
        if (confirmDelete) onDelete();
        else setConfirmDelete(true);
      },
    },
  ];

  return (
    <div
      ref={setNodeRef}
      className="character-folder"
      style={{ '--depth': row.depth } as CSSProperties}
      data-over={isOver || undefined}
      data-collapsed={row.collapsed || undefined}
    >
      {/*
       * Renaming swaps the whole toggle out rather than putting the field inside it. An input
       * nested in a button is invalid HTML, and the button swallows the Enter key that is
       * supposed to commit the name — the same reason a card row is a row and not one button.
       */}
      {renaming ? (
        <div className="character-folder__toggle">
          <ChevronIcon className="character-folder__chevron" />
          <FolderIcon className="character-folder__icon" />
          <RenameField initial={row.name} onCommit={onRename} />
        </div>
      ) : (
        <button
          type="button"
          className="character-folder__toggle"
          onClick={onToggle}
          aria-expanded={!row.collapsed}
        >
          <ChevronIcon className="character-folder__chevron" />
          <FolderIcon className="character-folder__icon" />
          <span className="character-folder__name">{row.name}</span>
          <span className="character-folder__count">{row.count}</span>
        </button>
      )}

      <Menu
        label={`Actions for ${row.name}`}
        icon={<MoreIcon />}
        // End-aligned, because the trigger sits hard against the panel's right edge: a
        // start-aligned popup grows outward from there, past the edge, and the list has to
        // be scrolled sideways to reach the entries. Growing back over the list instead
        // puts the menu where the pointer already is.
        placement="bottom-end"
        className="wc-button wc-button--ghost character-folder__menu"
        entries={entries}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
      />
    </div>
  );
}

/** Inline rename, the same shape as ChatPicker's: commit on blur or Enter, Escape abandons. */
function RenameField({ initial, onCommit }: { initial: string; onCommit: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  // Focused on appear rather than with autoFocus, and with preventScroll: the panel is fixed
  // to the viewport, so letting the browser scroll to reveal the field moves the whole app.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);

  return (
    <input
      ref={input}
      className="wc-input character-folder__rename"
      value={value}
      aria-label={`Rename ${initial}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(e) => {
        // Enter commits via blur, so the two paths cannot disagree.
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') onCommit('');
      }}
    />
  );
}

interface CharacterRowProps {
  character: CharacterSummary;
  depth: number;
  /** The user's rating for this character, or undefined when unrated. */
  rating: number | undefined;
  /** Under search the tree is flat, so each match says which folder it came from. */
  showFolder: boolean;
  draggable: boolean;
  current: boolean;
  onSelect: () => void;
  onEdit: () => void;
}

function CharacterRow({
  character,
  depth,
  rating,
  showFolder,
  draggable,
  current,
  onSelect,
  onEdit,
}: CharacterRowProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: character.avatar,
    disabled: !draggable,
  });

  const meta = showFolder
    ? character.folder || 'Top level'
    : character.creator
      ? `by ${character.creator}`
      : 'Unknown creator';
  const tagOccurrences = new Map<string, number>();
  const visibleTags = character.tags.slice(0, 3).map((tag) => {
    const occurrence = tagOccurrences.get(tag) ?? 0;
    tagOccurrences.set(tag, occurrence + 1);
    return { key: `${tag}-${occurrence}`, value: tag };
  });

  return (
    // A row rather than one big button: the card needs two distinct actions,
    // and a button inside a button is invalid.
    <div
      className="character-card"
      style={{ '--depth': depth } as CSSProperties}
      data-current={current || undefined}
      data-dragging={isDragging || undefined}
    >
      {/*
       * A dedicated grip rather than making the whole row draggable, exactly as PromptManager
       * does. Hanging the listeners off the row would put dnd-kit's role and tabIndex on a
       * div that already contains two buttons, and every click would have to be disambiguated
       * from the start of a drag.
       */}
      {draggable ? (
        <button
          type="button"
          className="character-card__grip"
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${character.name}`}
          title="Drag into a folder"
        >
          <GripIcon />
        </button>
      ) : (
        <span className="character-card__grip character-card__grip--placeholder" />
      )}

      <button
        type="button"
        className="character-card__open"
        aria-current={current}
        onClick={onSelect}
        title={`Chat with ${character.name}`}
      >
        <img
          className="character-card__avatar"
          src={characterApi.imageUrl(character.avatar, character.modified)}
          alt=""
          loading="lazy"
        />
        <span className="character-card__text">
          <span className="character-card__name">{character.name}</span>
          <span className="character-card__meta">{meta}</span>
          {character.tags.length ? (
            <span className="character-card__tags" title={character.tags.join(', ')}>
              {visibleTags.map(({ key, value }) => (
                <span className="character-card__tag" key={key}>
                  {value}
                </span>
              ))}
              {character.tags.length > 3 ? (
                <span className="character-card__tag character-card__tag--more">
                  +{character.tags.length - 3}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="character-card__badges">
          {rating !== undefined ? (
            <span
              className="character-card__stars"
              role="img"
              aria-label={`Rated ${rating} out of 5`}
              title={`Rated ${rating} out of 5`}
            >
              {[1, 2, 3, 4, 5].map((star) => (
                <StarIcon key={star} className="character-card__star" filled={star <= rating} />
              ))}
            </span>
          ) : null}
        </span>
      </button>

      <button
        type="button"
        className="wc-button wc-button--ghost character-card__edit"
        onClick={onEdit}
        title={`Edit ${character.name}`}
        aria-label={`Edit ${character.name}`}
      >
        <EditIcon />
      </button>
    </div>
  );
}

/** "New folder", "New folder 2", … so the button can be pressed twice without an error. */
function freeFolderName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }
  return base;
}
