import type { CharacterSummary } from '@shared/types/card.ts';
import { useMemo, useRef, useState } from 'react';
import {
  CoCreatorIcon,
  DownloadIcon,
  PlusIcon,
  TrashIcon,
  UploadIcon,
} from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';

interface StudioLibraryProps {
  characters: readonly CharacterSummary[];
  folders: readonly string[];
  onOpen: (avatar: string) => void;
  onRefresh: () => Promise<void>;
  onOpenCoCreator: () => void;
}

function timestamp(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function StudioLibrary({
  characters,
  folders,
  onOpen,
  onRefresh,
  onOpenCoCreator,
}: StudioLibraryProps) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...characters]
      .filter((character) => !folder || character.folder === folder)
      .filter((character) => {
        if (!needle) return true;
        return [character.name, character.creator, character.tags.join(' ')].some((value) =>
          value.toLowerCase().includes(needle),
        );
      })
      .sort((left, right) => right.modified - left.modified);
  }, [characters, folder, query]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await characterApi.create('Untitled Character', 'Drafts');
      await onRefresh();
      onOpen(created.avatar);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await characterApi.import(file, folder);
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    await onRefresh();
    setBusy(false);
    if (failures.length) setError(failures.join('\n'));
  }

  async function duplicate(character: CharacterSummary) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(characterApi.exportUrl(character.avatar, 'png'));
      if (!response.ok) throw new Error(`Could not export ${character.name}.`);
      const file = new File([await response.blob()], `${character.name || 'Character'} copy.png`, {
        type: 'image/png',
      });
      const copied = await characterApi.import(file, character.folder);
      await onRefresh();
      onOpen(copied.avatar);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(avatar: string) {
    if (confirmDelete !== avatar) {
      setConfirmDelete(avatar);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await characterApi.remove(avatar);
      setConfirmDelete(null);
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const folderOptions = [
    ...new Set([...folders, ...characters.map((character) => character.folder)]),
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const recent = visible[0];

  return (
    <div className="studio-library">
      <header className="studio-library__hero">
        <div>
          <p className="studio-library__eyebrow">Character Creator Studio</p>
          <h1>Build cards with room to think.</h1>
          <p>Autosaved Character Card V2 PNGs, ready for WackChatter and SillyTavern.</p>
        </div>
        <div className="studio-library__primary-actions">
          <button
            type="button"
            className="wc-button wc-button--primary"
            disabled={busy}
            onClick={() => void create()}
          >
            <PlusIcon />
            New card
          </button>
          <button type="button" className="wc-button" disabled={busy} onClick={onOpenCoCreator}>
            <CoCreatorIcon />
            Design with an assistant
          </button>
          <button
            type="button"
            className="wc-button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <UploadIcon />
            Import PNG / JSON
          </button>
          <button
            type="button"
            className="wc-button"
            disabled={!recent || busy}
            title={!recent ? 'No cards are available yet.' : undefined}
            onClick={() => recent && onOpen(recent.avatar)}
          >
            Open recent
          </button>
        </div>
      </header>

      <div className="studio-library__filters">
        <input
          type="search"
          className="wc-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, creator, or tags"
          aria-label="Search cards"
        />
        <select
          className="wc-select"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        >
          <option value="">All folders</option>
          {folderOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {error ? <p className="studio-library__error">{error}</p> : null}
      {visible.length ? (
        <div className="studio-library__grid">
          {visible.map((character) => (
            <article className="studio-card" key={character.avatar}>
              <button
                type="button"
                className="studio-card__open"
                onClick={() => onOpen(character.avatar)}
              >
                <img
                  className="studio-card__avatar"
                  src={characterApi.imageUrl(character.avatar, character.modified)}
                  alt=""
                  loading="lazy"
                />
                <span className="studio-card__name">{character.name || 'Untitled Character'}</span>
                <span className="studio-card__meta">
                  {character.creator ? `by ${character.creator}` : 'No creator'} ·{' '}
                  {timestamp(character.modified)}
                </span>
                {character.tags.length ? (
                  <span className="studio-card__tags">{character.tags.join(' · ')}</span>
                ) : null}
              </button>
              <footer className="studio-card__actions">
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  disabled={busy}
                  onClick={() => void duplicate(character)}
                >
                  Duplicate
                </button>
                <a
                  className="wc-button wc-button--ghost"
                  href={characterApi.exportUrl(character.avatar, 'png')}
                  download
                  title="Export PNG"
                >
                  <DownloadIcon />
                </a>
                <button
                  type="button"
                  className="wc-button wc-button--ghost wc-button--danger"
                  disabled={busy}
                  onClick={() => void remove(character.avatar)}
                  onBlur={() =>
                    setConfirmDelete((current) => (current === character.avatar ? null : current))
                  }
                >
                  <TrashIcon />
                  {confirmDelete === character.avatar ? 'Confirm delete' : 'Delete'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="wc-empty">
          {characters.length
            ? 'No cards match those filters.'
            : 'Create or import your first character card.'}
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept=".png,.json"
        multiple
        className="wc-visually-hidden"
        onChange={(event) => {
          void importFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}
