import type { CharacterSummary } from '@shared/types/card.ts';
import { useMemo, useRef, useState } from 'react';
import { PlusIcon, UploadIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import './CharacterList.css';

interface CharacterListProps {
  characters: CharacterSummary[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (avatar: string) => void;
  onRefresh: () => void;
}

export function CharacterList({
  characters,
  selected,
  loading,
  error,
  onSelect,
  onRefresh,
}: CharacterListProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return characters;
    return characters.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        c.creator.toLowerCase().includes(q),
    );
  }, [characters, query]);

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
      onSelect(created.avatar);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
      </div>

      {message ? <div className="character-list__error">{message}</div> : null}

      <div className="character-list__items">
        {loading ? (
          <div className="wc-empty">Loading…</div>
        ) : filtered.length === 0 ? (
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
          filtered.map((character) => (
            <button
              type="button"
              key={character.avatar}
              className="character-card"
              aria-current={character.avatar === selected}
              onClick={() => onSelect(character.avatar)}
            >
              <img
                className="character-card__avatar"
                src={characterApi.imageUrl(character.avatar, character.modified)}
                alt=""
                loading="lazy"
              />
              <span className="character-card__text">
                <span className="character-card__name">{character.name}</span>
                <span className="character-card__meta">
                  {character.creator ? `by ${character.creator}` : 'Unknown creator'}
                  {character.tags.length ? ` · ${character.tags.slice(0, 3).join(', ')}` : ''}
                </span>
              </span>
              <span className="character-card__badges">
                {character.hasLorebook ? <span className="badge">Lore</span> : null}
                {character.alternateGreetingCount > 0 ? (
                  <span className="badge">+{character.alternateGreetingCount}</span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </div>

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
