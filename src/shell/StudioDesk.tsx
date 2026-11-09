/**
 * The Studio's library: the card you were last working on lies on the desk, everything
 * else is under it. Search and folders narrow the lot; while they do, the desk steps
 * aside and everything that matches is laid out the same.
 */

import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { useMemo, useRef, useState } from 'react';
import { matchesQuery } from '../features/character/characterTree.ts';
import { characterApi } from '../lib/api.ts';
import { Icon } from './icons.tsx';
import { editedWhen } from './studio.ts';

export interface DeskActions {
  onOpen: (avatar: string) => void;
  onNew: () => void;
  onImport: (files: File[], folder: string) => void;
  onCoCreator: () => void;
  onDuplicate: (card: CharacterSummary) => void;
  onExport: (card: CharacterSummary) => void;
  /** The card under the pointer, for the colour; null when it leaves. */
  onHover: (avatar: string | null) => void;
}

export function StudioDesk({
  characters,
  folders,
  versions,
  countTokens,
  busy,
  actions,
}: {
  characters: readonly CharacterSummary[];
  folders: readonly string[];
  versions: Readonly<Record<string, number>>;
  countTokens: TokenCounter;
  busy: boolean;
  actions: DeskActions;
}) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const url = (card: CharacterSummary) =>
    characterApi.imageUrl(card.avatar, versions[card.avatar] ?? card.modified);

  const byEdit = useMemo(
    () => [...characters].sort((a, b) => b.modified - a.modified),
    [characters],
  );
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of characters) counts.set(card.folder, (counts.get(card.folder) ?? 0) + 1);
    return counts;
  }, [characters]);
  const folderList = useMemo(
    () =>
      [...new Set([...folders, ...characters.map((card) => card.folder)])]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [folders, characters],
  );

  const narrowed = Boolean(query.trim()) || folder !== null;
  const shown = narrowed
    ? byEdit.filter(
        (card) => (folder === null || card.folder === folder) && matchesQuery(card, query),
      )
    : byEdit;
  const desk = narrowed ? null : (shown[0] ?? null);
  const rest = desk ? shown.slice(1) : shown;

  return (
    <div className="w3-desk">
      <header className="w3-desk__head">
        <h1>
          Your cards
          <small>
            {characters.length.toLocaleString()} {characters.length === 1 ? 'card' : 'cards'}
          </small>
        </h1>
        <div className="w3-desk__acts">
          <button type="button" className="w3-st-pill" disabled={busy} onClick={actions.onNew}>
            <Icon name="plus" size="sm" />
            New card
          </button>
          <button
            type="button"
            className="w3-st-ghost"
            disabled={busy}
            onClick={actions.onCoCreator}
          >
            <Icon name="spark" size="sm" />
            Start with the Co-Creator
          </button>
          <button
            type="button"
            className="w3-st-ghost"
            disabled={busy}
            onClick={() => importRef.current?.click()}
          >
            <Icon name="upload" size="sm" />
            Import
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length) actions.onImport(files, folder ?? '');
            }}
          />
        </div>
      </header>

      <div className="w3-desk__filter">
        <label className="w3-st-search">
          <Icon name="search" size="sm" />
          <input
            value={query}
            placeholder="Search cards"
            aria-label="Search cards"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {folderList.length ? (
          <div className="w3-desk__folders">
            <button
              type="button"
              className="w3-chip"
              aria-pressed={folder === null}
              onClick={() => setFolder(null)}
            >
              All <small>{characters.length}</small>
            </button>
            {folderCounts.get('') ? (
              <button
                type="button"
                className="w3-chip"
                aria-pressed={folder === ''}
                onClick={() => setFolder(folder === '' ? null : '')}
              >
                Top level <small>{folderCounts.get('')}</small>
              </button>
            ) : null}
            {folderList.map((name) => (
              <button
                key={name}
                type="button"
                className="w3-chip"
                aria-pressed={folder === name}
                onClick={() => setFolder(folder === name ? null : name)}
              >
                {name} <small>{folderCounts.get(name) ?? 0}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {desk ? (
        <div
          className="w3-desk__desk"
          onPointerEnter={() => actions.onHover(desk.avatar)}
          onPointerLeave={() => actions.onHover(null)}
        >
          <button
            type="button"
            className="w3-desk__art"
            aria-label={`Open ${desk.name}`}
            onClick={() => actions.onOpen(desk.avatar)}
          >
            <img src={url(desk)} alt="" draggable={false} />
          </button>
          <div className="w3-desk__body">
            <span className="w3-desk__eyebrow">
              On your desk · edited {editedWhen(desk.modified, now)}
            </span>
            <h2>{desk.name || 'Untitled'}</h2>
            {desk.greeting ? <p className="w3-desk__quote">{desk.greeting}</p> : null}
            <div className="w3-desk__facts">
              <span>
                <b>{countTokens.countText(desk.description).toLocaleString()}</b> tokens of
                description
              </span>
              {desk.hasLorebook ? <span>Lorebook</span> : null}
              {desk.folder ? <span>{desk.folder}</span> : null}
            </div>
            <button
              type="button"
              className="w3-st-pill w3-desk__go"
              onClick={() => actions.onOpen(desk.avatar)}
            >
              Keep working
              <Icon name="chevronRight" size="sm" />
            </button>
          </div>
        </div>
      ) : null}

      {desk && rest.length ? <p className="w3-desk__label">Everything else</p> : null}
      {rest.length ? (
        <ul className="w3-desk__grid">
          {rest.map((card) => (
            <li
              key={card.avatar}
              className="w3-desk__card"
              onPointerEnter={() => actions.onHover(card.avatar)}
              onPointerLeave={() => actions.onHover(null)}
            >
              <button
                type="button"
                className="w3-desk__open"
                onClick={() => actions.onOpen(card.avatar)}
              >
                <span className="w3-desk__thumb">
                  <img src={url(card)} alt="" loading="lazy" decoding="async" draggable={false} />
                </span>
                <span className="w3-desk__name">{card.name || 'Untitled'}</span>
                <span className="w3-desk__when">{editedWhen(card.modified, now)}</span>
              </button>
              <span className="w3-desk__tools">
                <button
                  type="button"
                  aria-label={`Duplicate ${card.name}`}
                  title="Duplicate"
                  disabled={busy}
                  onClick={() => actions.onDuplicate(card)}
                >
                  <Icon name="copy" size="xs" />
                </button>
                <button
                  type="button"
                  aria-label={`Export ${card.name} as PNG`}
                  title="Export PNG"
                  onClick={() => actions.onExport(card)}
                >
                  <Icon name="download" size="xs" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : narrowed ? (
        <p className="w3-desk__none">No card matches.</p>
      ) : null}
    </div>
  );
}
