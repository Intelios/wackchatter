import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { LorebookSummary } from '@shared/types/worldinfo.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon, DownloadIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { StudioLibrary } from './StudioLibrary.tsx';
import { StudioWorkbench } from './StudioWorkbench.tsx';
import './StudioShell.css';

interface StudioShellProps {
  characters: readonly CharacterSummary[];
  folders: readonly string[];
  books: readonly LorebookSummary[];
  countTokens: TokenCounter;
  contextLimit: number | undefined;
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  inspectorCollapsed: boolean;
  onInspectorCollapsedChange: (collapsed: boolean) => void;
  onExit: () => Promise<void>;
  registerPersistence: (controls: PersistenceControls | null) => void;
}

/** A separate destination, not a chat panel: card creation needs a full editing surface. */
export function StudioShell({
  characters,
  folders,
  books,
  countTokens,
  contextLimit,
  backgroundUrl,
  backgroundBlur,
  backgroundDim,
  glass,
  inspectorCollapsed,
  onInspectorCollapsedChange,
  onExit,
  registerPersistence,
}: StudioShellProps) {
  const [library, setLibrary] = useState<CharacterSummary[]>([...characters]);
  const [libraryFolders, setLibraryFolders] = useState<string[]>([...folders]);
  const [detail, setDetail] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const persistenceRef = useRef<PersistenceControls | null>(null);

  useEffect(() => setLibrary([...characters]), [characters]);
  useEffect(() => setLibraryFolders([...folders]), [folders]);
  useEffect(() => {
    return () => registerPersistence(null);
  }, [registerPersistence]);

  const refreshLibrary = useCallback(async () => {
    const [nextCharacters, nextFolders] = await Promise.all([
      characterApi.list(),
      characterApi.folders.list(),
    ]);
    setLibrary(nextCharacters);
    setLibraryFolders(nextFolders);
  }, []);

  const open = useCallback(async (avatar: string) => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await characterApi.get(avatar));
      setStatus('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const registerDraftPersistence = useCallback(
    (controls: PersistenceControls | null) => {
      persistenceRef.current = controls;
      registerPersistence(controls);
    },
    [registerPersistence],
  );

  const returnToLibrary = useCallback(async () => {
    try {
      await persistenceRef.current?.flush();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setDetail(null);
    setStatus('');
    try {
      await refreshLibrary();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refreshLibrary]);

  const updateSummary = useCallback((saved: CharacterDetail) => {
    setDetail(saved);
    setLibrary((current) =>
      current.map((entry) => (entry.avatar === saved.avatar ? { ...entry, ...saved } : entry)),
    );
  }, []);

  const handleRenamed = useCallback(
    (saved: CharacterDetail) => {
      setDetail(saved);
      setLibrary((current) => {
        const previous = detail?.avatar;
        return current.map((entry) => (entry.avatar === previous ? { ...entry, ...saved } : entry));
      });
      void refreshLibrary().catch((err) => setError((err as Error).message));
    },
    [detail?.avatar, refreshLibrary],
  );

  const handleDeleted = useCallback(() => {
    setDetail(null);
    setStatus('');
    void refreshLibrary().catch((err) => setError((err as Error).message));
  }, [refreshLibrary]);

  return (
    <div
      className="studio-shell"
      data-overlay-root
      data-glass={backgroundUrl !== null && glass}
      style={
        {
          '--wc-bg-blur': `${backgroundBlur}px`,
          '--wc-bg-dim': backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={backgroundUrl} />
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}
      <header className="studio-shell__bar">
        <div className="studio-shell__navigation">
          {detail ? (
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={() => void returnToLibrary()}
            >
              <ChevronLeftIcon />
              Back to library
            </button>
          ) : null}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void onExit()}
          >
            <ChevronLeftIcon />
            Exit Studio
          </button>
        </div>
        <div className="studio-shell__title">
          {detail ? (
            <>
              <img src={characterApi.imageUrl(detail.avatar, detail.modified)} alt="" />
              <span>{detail.card.data.name || 'Untitled Character'}</span>
            </>
          ) : (
            <span>Character Creator Studio</span>
          )}
        </div>
        <div className="studio-shell__actions">
          {status ? <span className="studio-shell__status">{status}</span> : null}
          {detail ? (
            <>
              <a
                className="wc-button wc-button--ghost"
                href={characterApi.exportUrl(detail.avatar, 'png')}
                download
              >
                <DownloadIcon />
                Export PNG
              </a>
              <a
                className="wc-button wc-button--ghost"
                href={characterApi.exportUrl(detail.avatar, 'json')}
                download
              >
                Export JSON
              </a>
            </>
          ) : null}
        </div>
      </header>
      <div className="studio-shell__body">
        {loading ? <div className="wc-empty">Opening card…</div> : null}
        {error ? <p className="studio-shell__error">{error}</p> : null}
        {!loading && detail ? (
          <StudioWorkbench
            key={detail.avatar}
            detail={detail}
            folders={libraryFolders}
            books={books}
            countTokens={countTokens}
            contextLimit={contextLimit}
            inspectorCollapsed={inspectorCollapsed}
            onInspectorCollapsedChange={onInspectorCollapsedChange}
            onSaved={updateSummary}
            onRenamed={handleRenamed}
            onDeleted={handleDeleted}
            onBack={() => void returnToLibrary()}
            registerPersistence={registerDraftPersistence}
            onStatusChange={setStatus}
          />
        ) : null}
        {!loading && !detail ? (
          <StudioLibrary
            characters={library}
            folders={libraryFolders}
            onOpen={(avatar) => void open(avatar)}
            onRefresh={refreshLibrary}
          />
        ) : null}
      </div>
    </div>
  );
}
