import type { Connection } from '@shared/providers/types.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { CocreatorSession, CocreatorSessionSummary } from '@shared/types/cocreator.ts';
import type { Preset, PresetSummary } from '@shared/types/preset.ts';
import type { CoCreatorSettings } from '@shared/types/settings.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { ChevronLeftIcon } from '../../layout/icons.tsx';
import { characterApi, cocreatorApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import { CocreatorDesk } from './CocreatorDesk.tsx';
import { CocreatorSessions } from './CocreatorSessions.tsx';
import './CocreatorShell.css';

interface CocreatorShellProps {
  defaults: CoCreatorSettings;
  connections: Connection[];
  activeConnectionId: string | null;
  presets: PresetSummary[];
  activePresetId: string | null;
  activePreset: Preset | null;
  tokenizerEncoding?: 'auto' | 'o200k_base' | 'cl100k_base';
  onDefaultsChange: (patch: Partial<CoCreatorSettings>) => void;
  /** The library, for the example picker. */
  characters: readonly CharacterSummary[];
  streamingFps: number;
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  onExit: () => Promise<void>;
  /** Leave for the Studio, opened on the card this session produced. */
  onFinished: (avatar: string) => void;
  /**
   * The card the Studio just handed off. Entering with one creates a seeded session instead
   * of showing the list: the card becomes the transcript's opening turn and the stash's
   * starting contents, so Finish can produce a complete variant of it.
   */
  seedAvatar?: string | null;
  registerPersistence: (controls: PersistenceControls | null) => void;
}

/**
 * A separate destination, like the Studio and for the same reason: designing a card is not
 * something you do beside a chat, and the screen needs the whole window.
 */
export function CocreatorShell({
  defaults,
  connections,
  activeConnectionId,
  presets,
  activePresetId,
  activePreset,
  tokenizerEncoding,
  onDefaultsChange,
  characters,
  streamingFps,
  backgroundUrl,
  backgroundBlur,
  backgroundDim,
  glass,
  onExit,
  onFinished,
  seedAvatar,
  registerPersistence,
}: CocreatorShellProps) {
  const [sessions, setSessions] = useState<CocreatorSessionSummary[]>([]);
  const [session, setSession] = useState<CocreatorSession | null>(null);
  /** The handed-off card itself, fetched once so the desk can seed from it. */
  const [seed, setSeed] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const persistenceRef = useRef<PersistenceControls | null>(null);

  useEffect(() => {
    return () => registerPersistence(null);
  }, [registerPersistence]);

  const refresh = useCallback(async () => {
    setSessions(await cocreatorApi.list());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void cocreatorApi
      .list()
      .then((list) => {
        if (!cancelled) setSessions(list);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const registerDeskPersistence = useCallback(
    (controls: PersistenceControls | null) => {
      persistenceRef.current = controls;
      registerPersistence(controls);
    },
    [registerPersistence],
  );

  const open = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      // Opening anything by hand ends the handoff's context: a blank session created next
      // must stay blank, not inherit a seed that was only ever meant for the arrival.
      setSeed(null);
      setSession(await cocreatorApi.get(id));
      setStatus('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const create = useCallback(async () => {
    setError(null);
    try {
      const created = await cocreatorApi.create();
      setSeed(null);
      setSession(created);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

  /*
   * The Studio's handoff. Keyed on the avatar, so arriving with one seeds exactly once: the
   * Co-Creator is otherwise entered on the sessions list, and this must not re-seed after
   * the user has navigated away. A failed fetch or create leaves them on that list with the
   * error showing — never a silent blank session pretending to be the one they asked for.
   */
  useEffect(() => {
    if (!seedAvatar) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    void characterApi
      .get(seedAvatar)
      .then(async (detail) => {
        const created = await cocreatorApi.create(detail.name.trim() || undefined, seedAvatar);
        if (cancelled) return;
        setSeed(detail);
        setSession(created);
        await refresh();
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [seedAvatar, refresh]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await cocreatorApi.remove(id);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh],
  );

  /**
   * Leaving the desk drains its queue first, and a failed flush aborts the transition —
   * the same bargain every navigation edge in this app makes. Losing work silently is worse
   * than refusing to move.
   */
  const returnToSessions = useCallback(async () => {
    try {
      await persistenceRef.current?.flush();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setSession(null);
    setSeed(null);
    setStatus('');
    try {
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

  return (
    <div
      className="cocreator-shell"
      data-overlay-root
      data-glass={backgroundUrl !== null && glass}
      data-session={session !== null || undefined}
      style={
        {
          '--wc-bg-blur': `${backgroundBlur}px`,
          '--wc-bg-dim': backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={backgroundUrl} />
      {backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}
      <header className="cocreator-shell__bar">
        <div className="cocreator-shell__navigation">
          {session ? (
            <button
              type="button"
              className="wc-button wc-button--primary"
              onClick={() => void returnToSessions()}
            >
              <ChevronLeftIcon />
              Back to sessions
            </button>
          ) : null}
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void onExit()}
          >
            <ChevronLeftIcon />
            Exit Co-Creator
          </button>
        </div>
        <div className="cocreator-shell__title">
          <span>{session ? session.title : 'Character Co-Creator'}</span>
        </div>
        <div className="cocreator-shell__actions">
          {status ? <span className="cocreator-shell__status">{status}</span> : null}
        </div>
      </header>
      <div className="cocreator-shell__body">
        {error ? (
          <p className="cocreator-shell__error" role="alert">
            {error}
          </p>
        ) : null}
        {loading && !session ? <div className="wc-empty">Loading…</div> : null}
        {session ? (
          <CocreatorDesk
            key={session.id}
            session={session}
            seed={seed}
            defaults={defaults}
            connections={connections}
            activeConnectionId={activeConnectionId}
            presets={presets}
            activePresetId={activePresetId}
            activePreset={activePreset}
            tokenizerEncoding={tokenizerEncoding}
            onDefaultsChange={onDefaultsChange}
            characters={characters}
            streamingFps={streamingFps}
            registerPersistence={registerDeskPersistence}
            onStatusChange={setStatus}
            onFinished={onFinished}
            onError={setError}
          />
        ) : loading ? null : (
          <CocreatorSessions
            sessions={sessions}
            loading={false}
            onOpen={(id) => void open(id)}
            onCreate={() => void create()}
            onDelete={(id) => void remove(id)}
          />
        )}
      </div>
    </div>
  );
}
