import type { Connection } from '@shared/providers/types.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import type {
  PresetCocreatorModelSettings,
  PresetCocreatorSession,
  PresetCocreatorSessionSummary,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import type { LorebookSummary, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Backdrop } from '../../components/Backdrop.tsx';
import { Select } from '../../components/Select.tsx';
import { ChevronLeftIcon } from '../../layout/icons.tsx';
import { presetCocreatorApi, referencePresetApi } from '../../lib/api.ts';
import type { PersistenceControls } from '../../lib/autosave.ts';
import type { EffectId } from '../backgrounds/effects.ts';
import { ParticleLayer } from '../backgrounds/ParticleLayer.tsx';
import { PresetCocreatorWorkspace } from './PresetCocreatorWorkspace.tsx';
import { PresetReferencePanel } from './PresetReferencePanel.tsx';
import './PresetCocreator.css';

interface PresetCocreatorShellProps {
  connections: readonly Connection[];
  activeConnectionId: string | null;
  presets: readonly PresetSummary[];
  activePresetId: string | null;
  characters: readonly CharacterSummary[];
  activeCharacterId?: string | null;
  personas: readonly Persona[];
  activePersonaId?: string | null;
  books: readonly LorebookSummary[];
  globalLorebookIds: readonly string[];
  worldInfoSettings: WorldInfoSettings;
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  tokenizerEncoding?: string;
  streamingFps: number;
  backgroundUrl: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  glass: boolean;
  effect: EffectId | null;
  effectLayer: 'behind' | 'front';
  onExit: () => Promise<void>;
  onPublished: (presetId: string, version: string) => void;
  registerPersistence: (controls: PersistenceControls | null) => void;
}

function modelDefaults(connection: Connection | null): PresetCocreatorModelSettings {
  return {
    connectionId: connection?.id ?? null,
    model: connection?.model ?? '',
    maxTokens: 4096,
    temperature: 0.2,
    reasoningEffort: 'medium',
  };
}

export function PresetCocreatorShell(props: PresetCocreatorShellProps) {
  const [sessions, setSessions] = useState<PresetCocreatorSessionSummary[]>([]);
  const [references, setReferences] = useState<ReferencePresetSummary[]>([]);
  const [session, setSession] = useState<PresetCocreatorSession | null>(null);
  const [sourcePresetId, setSourcePresetId] = useState(props.activePresetId ?? '');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const persistenceRef = useRef<PersistenceControls | null>(null);
  const startingPresetId = useId();
  const activeConnection =
    props.connections.find((connection) => connection.id === props.activeConnectionId) ??
    props.connections[0] ??
    null;

  const refresh = useCallback(async () => {
    const [sessionList, referenceList] = await Promise.all([
      presetCocreatorApi.list(),
      referencePresetApi.list(),
    ]);
    setSessions(sessionList);
    setReferences(referenceList);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refresh()
      .catch((failure) => {
        if (!cancelled) setError((failure as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      props.registerPersistence(null);
    };
  }, [props.registerPersistence, refresh]);

  const open = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      setSession(await presetCocreatorApi.get(id));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const create = async () => {
    setLoading(true);
    setError('');
    try {
      const assistant = modelDefaults(activeConnection);
      const created = await presetCocreatorApi.create({
        presetId: sourcePresetId || null,
        title: title.trim() || undefined,
        settings: {
          assistant,
          testing: { ...assistant, maxTokens: 1024, reasoningEffort: 'auto' },
        },
      });
      setSession(created);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (id: string) => {
    if (confirmingDelete !== id) {
      setConfirmingDelete(id);
      return;
    }
    setConfirmingDelete(null);
    try {
      await presetCocreatorApi.remove(id);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const returnToSessions = async () => {
    try {
      await persistenceRef.current?.flush();
      setSession(null);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <div
      className="preset-cc-shell"
      data-overlay-root
      data-glass={props.backgroundUrl !== null && props.glass}
      style={
        {
          '--wc-bg-blur': `${props.backgroundBlur}px`,
          '--wc-bg-dim': props.backgroundDim,
        } as CSSProperties
      }
    >
      <Backdrop url={props.backgroundUrl} />
      {props.backgroundUrl ? <div className="shell__scrim" aria-hidden="true" /> : null}
      {!session ? (
        <header className="preset-cc-shell__bar">
          <button
            type="button"
            className="wc-button wc-button--ghost"
            onClick={() => void props.onExit()}
          >
            <ChevronLeftIcon /> Co-Creator
          </button>
          <strong>Preset Co-Creator</strong>
          <span />
        </header>
      ) : null}
      <main className="preset-cc-shell__body">
        {error ? (
          <p className="preset-cc-global-error" role="alert">
            {error}
          </p>
        ) : null}
        {session ? (
          <PresetCocreatorWorkspace
            key={session.id}
            initial={session}
            connections={props.connections}
            characters={props.characters}
            presets={props.presets}
            references={references}
            personas={props.personas}
            books={props.books}
            initialCharacterId={props.activeCharacterId}
            initialPersonaId={props.activePersonaId}
            globalLorebookIds={props.globalLorebookIds}
            worldInfoSettings={props.worldInfoSettings}
            globalVariables={props.globalVariables}
            regexScripts={props.regexScripts}
            tokenizerEncoding={props.tokenizerEncoding}
            streamingFps={props.streamingFps}
            onBack={returnToSessions}
            onPublished={props.onPublished}
            registerPersistence={(controls) => {
              persistenceRef.current = controls;
              props.registerPersistence(controls);
            }}
          />
        ) : loading ? (
          <div className="wc-empty">Loading preset design sessions…</div>
        ) : (
          <div className="preset-cc-sessions">
            <section className="preset-cc-sessions__create">
              <p className="preset-cc-eyebrow">New design session</p>
              <h1>Edit, test, and publish a preset</h1>
              <div className="field">
                <label className="wc-label" htmlFor={startingPresetId}>
                  Starting preset
                </label>
                <Select
                  id={startingPresetId}
                  label="Starting preset"
                  value={sourcePresetId}
                  onChange={setSourcePresetId}
                  options={[
                    { value: '', label: 'WackChatter default preset' },
                    ...props.presets.map((preset) => ({ value: preset.id, label: preset.name })),
                  ]}
                />
              </div>
              <label className="field">
                <span className="wc-label">Session name</span>
                <input
                  className="wc-input"
                  value={title}
                  placeholder="Optional"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="wc-button wc-button--primary"
                onClick={() => void create()}
              >
                Create session
              </button>
            </section>
            <section className="preset-cc-sessions__existing">
              <h2>Continue a session</h2>
              {sessions.length ? (
                sessions.map((entry) => (
                  <article className="preset-cc-session-row" key={entry.id}>
                    <button
                      type="button"
                      className="preset-cc-session-row__open"
                      onClick={() => void open(entry.id)}
                    >
                      <strong>{entry.title}</strong>
                      <span>
                        Revision {entry.draftRevision} · {entry.testCount} test
                        {entry.testCount === 1 ? '' : 's'}
                      </span>
                      <span>{entry.lastMessage || 'No design conversation yet'}</span>
                    </button>
                    <button
                      type="button"
                      className="wc-button wc-button--danger"
                      onClick={() => void remove(entry.id)}
                    >
                      {confirmingDelete === entry.id ? 'Delete?' : 'Delete'}
                    </button>
                  </article>
                ))
              ) : (
                <div className="wc-empty">No preset design sessions yet.</div>
              )}
            </section>
            <PresetReferencePanel
              references={references}
              presets={props.presets}
              onChanged={refresh}
              onError={setError}
            />
          </div>
        )}
      </main>
      <ParticleLayer effect={props.effect} layer={props.effectLayer} />
    </div>
  );
}
