/**
 * The Preset Co-Creator in the 3.0 shell: its own place, beside the Character Co-Creator.
 *
 * The screen is the loop you work in: you ask, the Co-Creator edits the preset, you test it
 * on the bench and send a reply back. So the Co-Creator sits on one side, the bench on the
 * other, and the preset between them lights up where it changed. The island carries the
 * preset, both models and what the session has cost.
 */

import './studio.css';
import './cocreator.css';
import './presetcc.css';

import { slotRef } from '@shared/models/slots.ts';
import type {
  PresetCocreatorSession,
  PresetCocreatorSessionSummary,
  ReferencePresetSummary,
} from '@shared/types/preset-cocreator.ts';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppController } from '../app/useAppController.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import {
  needsPortrait,
  resolveSpeakerColors,
  useAvatarPalette,
} from '../features/chat/avatarColor.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { personaApi, presetCocreatorApi, referencePresetApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { useArm } from './controls.tsx';
import { Island, type IslandMode, type IslandNotice } from './Island.tsx';
import { type SearchItem, SearchPane } from './IslandPanes.tsx';
import { Icon } from './icons.tsx';
import { PresetSession } from './PresetSession.tsx';
import { groupSessions } from './presetcc.ts';
import { editedWhen } from './studio.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

const LIME = '#c2ee4a';

export function PresetCoCreator({ controller }: { controller: AppController }) {
  const { app, library } = controller;
  const { settings, view: prefs, models } = app;

  const [sessions, setSessions] = useState<PresetCocreatorSessionSummary[]>([]);
  const [references, setReferences] = useState<ReferencePresetSummary[]>([]);
  const [session, setSession] = useState<PresetCocreatorSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<IslandMode | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const noticeId = useRef(0);
  const persistence = useRef<PersistenceControls | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLDivElement>(null);

  const say = useCallback((next: Omit<IslandNotice, 'id'>) => {
    noticeId.current += 1;
    setNotice({ ...next, id: noticeId.current });
  }, []);
  const fail = useCallback(
    (err: unknown) =>
      say({
        icon: 'alert',
        title: 'Preset Co-Creator',
        text: typeof err === 'string' ? err : (err as Error).message,
        tone: 'bad',
        sticky: true,
      }),
    [say],
  );

  const refresh = useCallback(async () => {
    const [list, refs] = await Promise.all([
      presetCocreatorApi.list(),
      referencePresetApi.list().catch(() => [] as ReferencePresetSummary[]),
    ]);
    setSessions(list);
    setReferences(refs);
  }, []);
  useEffect(() => {
    void refresh()
      .catch(fail)
      .finally(() => setLoading(false));
  }, [refresh, fail]);

  const registerPersistence = useMemo(
    () => controller.registerPersistence('cocreator'),
    [controller],
  );
  const register = useCallback(
    (controls: PersistenceControls | null) => {
      persistence.current = controls;
      registerPersistence(controls);
    },
    [registerPersistence],
  );
  useEffect(() => () => registerPersistence(null), [registerPersistence]);

  const leaveSession = useCallback(async () => {
    try {
      await persistence.current?.flush();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }, [fail]);

  const open = useCallback(
    async (id: string) => {
      setMode(null);
      if (!(await leaveSession())) return;
      try {
        setSession(await presetCocreatorApi.get(id));
      } catch (err) {
        fail(err);
      }
    },
    [fail, leaveSession],
  );

  const create = useCallback(
    async (presetId: string | null) => {
      setMode(null);
      if (!(await leaveSession())) return;
      // The Co-Creator thinks with the Co-Creator's model; the bench runs the one you chat
      // with, since that is the model the preset is for.
      const assistant = slotRef(models.slots, 'cocreator');
      const tester = models.slots.chat;
      try {
        const created = await presetCocreatorApi.create({
          presetId,
          settings: {
            assistant: {
              model: assistant,
              maxTokens: 8192,
              temperature: 0.2,
              reasoningEffort: 'medium',
            },
            testing: { model: tester, maxTokens: 1024, temperature: 0.2, reasoningEffort: 'auto' },
          },
        });
        setSession(created);
        void refresh().catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    [fail, leaveSession, models.slots, refresh],
  );

  const toSessions = useCallback(async () => {
    setMode(null);
    if (!(await leaveSession())) return;
    setSession(null);
    void refresh().catch(fail);
  }, [fail, leaveSession, refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await presetCocreatorApi.remove(id);
        await refresh();
      } catch (err) {
        fail(err);
      }
    },
    [fail, refresh],
  );

  const addReference = useCallback(
    async (file: File) => {
      const added = await referencePresetApi.import(file);
      await refresh();
      return added;
    },
    [refresh],
  );

  // --- Colour: the Co-Creator's lime, and your persona's for your own turns ---
  const persona = library.personas.find((p) => p.id === settings?.personaId) ?? null;
  const personaUrl = persona?.avatar
    ? personaApi.avatarUrl(persona.id, library.personaAvatarVersions[persona.id] ?? persona.avatar)
    : null;
  const personaOverride = persona ? prefs.dialogueColors.personas[persona.id] : undefined;
  const personaAuto = useAvatarPalette(needsPortrait(personaOverride) ? personaUrl : null);
  const personaColor = resolveSpeakerColors(true, personaOverride, personaAuto).aura;
  useAura(rootRef, washRef, LIME, personaColor, 'cocreator');
  const [firstAura] = useState(() => initialAuraStyle(LIME, personaColor));

  useEffect(() => {
    if (session) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMode((current) => (current === 'search' ? null : 'search'));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session]);

  const searchItems = useMemo<SearchItem[]>(
    () => [
      ...[...sessions]
        .sort((a, b) => b.modified - a.modified)
        .map((s) => ({
          key: s.id,
          kind: 'Session',
          label: s.title || 'Untitled session',
          sub: s.lastMessage.slice(0, 60) || undefined,
          icon: 'sliders' as const,
          run: () => void open(s.id),
        })),
      ...library.presets.map((p) => ({
        key: `new:${p.id}`,
        kind: 'Start from',
        label: p.name,
        icon: 'plus' as const,
        run: () => void create(p.id),
      })),
    ],
    [sessions, library.presets, open, create],
  );

  const backLabel = controller.active ? 'Back to chat' : 'Home';
  const islandMode: IslandMode = mode ?? 'rest';
  const shared = {
    connections: settings?.connections ?? [],
    presets: library.presets,
    references,
    characters: library.characters,
    personas: library.personas,
    personaAvatarVersions: library.personaAvatarVersions,
    dialogueColors: prefs.dialogueColors,
    books: library.books,
    activeCharacterId: controller.selected ?? null,
    activePersonaId: settings?.personaId ?? null,
    globalLorebookIds: prefs.globalBookIds,
    worldInfoSettings: prefs.worldInfo,
    globalVariables: settings?.variables ?? {},
    regexScripts: prefs.regexScripts,
    tokenizerEncoding: settings?.tokenizerEncoding,
    streamingFps: prefs.streamingFps,
  };

  return (
    <ModelsProvider
      connections={settings?.connections ?? []}
      recentModels={settings?.recentModels ?? []}
      chatModel={models.slots.chat}
      onRecentModels={app.rememberModels}
      favoriteModels={settings?.favoriteModels ?? []}
      onFavoriteModels={app.setFavoriteModels}
      pickerGroups={settings?.modelPickerGroups ?? {}}
      onPickerGroups={app.setModelPickerGroups}
    >
      <div
        ref={rootRef}
        className="wc3 w3-studio w3-co w3-pc"
        data-overlay-root
        data-screen={session ? 'desk' : 'sessions'}
        style={firstAura as CSSProperties}
      >
        <div className="w3-aura" aria-hidden="true" />
        <div className="w3-wash" ref={washRef} aria-hidden="true" />

        <ErrorBoundary where="Preset Co-Creator" resetKeys={[session?.id ?? null]}>
          {session ? (
            <PresetSession
              key={session.id}
              initial={session}
              {...shared}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              onFail={fail}
              onSay={say}
              onBack={() => void toSessions()}
              onPublished={controller.presetPublished}
              onAddReference={addReference}
              registerPersistence={register}
            />
          ) : (
            <>
              <header className="w3-studio__top">
                <div className="w3-studio__side">
                  <button
                    type="button"
                    className="w3-st-topbtn"
                    onClick={() => void controller.exitCoCreator()}
                  >
                    <Icon name="chevronLeft" size="sm" />
                    {backLabel}
                  </button>
                </div>
                <div className="w3-studio__side w3-studio__side--right" />
              </header>
              <Island
                mode={islandMode}
                generating={false}
                onCollapse={() => setMode(null)}
                notice={notice}
                onDismissNotice={() => setNotice(null)}
                wingsPinned={false}
                wingLeft={null}
                wingRight={null}
                panes={{
                  rest: (
                    <>
                      <span className="w3-st-mark">
                        <Icon name="sliders" size="sm" />
                        Preset Co-Creator
                      </span>
                      <span className="w3-isl-sep" aria-hidden="true" />
                      <button
                        type="button"
                        className="w3-isl-search"
                        aria-label="Find a session"
                        onClick={() => setMode('search')}
                      >
                        <Icon name="search" />
                        Find a session
                        <kbd className="w3-kbd">⌘K</kbd>
                      </button>
                    </>
                  ),
                  search: (
                    <SearchPane
                      active={islandMode === 'search'}
                      items={searchItems}
                      placeholder="Find a session, or a preset to start from"
                      onRun={(item) => {
                        setMode(null);
                        item.run();
                      }}
                    />
                  ),
                }}
              />
              <div className="w3-studio__body">
                {loading ? null : (
                  <Sessions
                    sessions={sessions}
                    presets={library.presets}
                    activePresetId={library.presetId}
                    references={references}
                    onOpen={(id) => void open(id)}
                    onCreate={(id) => void create(id)}
                    onDelete={(id) => void remove(id)}
                    onCharacter={() => controller.setCoCreatorMode('character')}
                    onAddReference={(file) => void addReference(file).catch(fail)}
                    onRemoveReference={(id) =>
                      void referencePresetApi.remove(id).then(refresh).catch(fail)
                    }
                  />
                )}
              </div>
            </>
          )}
        </ErrorBoundary>
      </div>
    </ModelsProvider>
  );
}

// ---------- Sessions: start from the preset you want to fix ----------

function Sessions({
  sessions,
  presets,
  activePresetId,
  references,
  onOpen,
  onCreate,
  onDelete,
  onCharacter,
  onAddReference,
  onRemoveReference,
}: {
  sessions: readonly PresetCocreatorSessionSummary[];
  presets: AppController['library']['presets'];
  activePresetId: string | null;
  references: readonly ReferencePresetSummary[];
  onOpen: (id: string) => void;
  onCreate: (presetId: string | null) => void;
  onDelete: (id: string) => void;
  onCharacter: () => void;
  onAddReference: (file: File) => void;
  onRemoveReference: (id: string) => void;
}) {
  const arm = useArm();
  const fileRef = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const groups = groupSessions(sessions, presets);
  const starts = [...presets].sort(
    (a, b) => Number(b.id === activePresetId) - Number(a.id === activePresetId),
  );

  return (
    <div className="w3-desk w3-pc-sessions">
      <header className="w3-desk__head">
        <h1>
          Preset Co-Creator
          <small>Start from the preset you want to fix.</small>
        </h1>
        <div className="w3-desk__acts">
          <button type="button" className="w3-st-ghost" onClick={onCharacter}>
            <Icon name="spark" size="sm" />
            Character Co-Creator
          </button>
        </div>
      </header>

      <section className="w3-pc-block">
        <p className="w3-desk__label">Start a session from</p>
        <div className="w3-pc-starts">
          {starts.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="w3-pc-start"
              onClick={() => onCreate(preset.id)}
            >
              <b>{preset.name}</b>
              <small>{preset.id === activePresetId ? 'Your chat preset' : 'Your preset'}</small>
            </button>
          ))}
          <button
            type="button"
            className="w3-pc-start w3-pc-start--blank"
            onClick={() => onCreate(null)}
          >
            <b>The built-in default</b>
            <small>WackChatter's own</small>
          </button>
        </div>
      </section>

      {groups.length ? (
        <section className="w3-pc-block">
          <p className="w3-desk__label">Continue</p>
          {groups.map((group) => (
            <div key={group.key} className="w3-pc-group">
              <h3>
                {group.name}
                <small>
                  {group.sessions.length} {group.sessions.length === 1 ? 'session' : 'sessions'}
                </small>
              </h3>
              {group.sessions.map((s) => (
                <div key={s.id} className="w3-co-row">
                  <button type="button" className="w3-pc-row" onClick={() => onOpen(s.id)}>
                    <span className="w3-co-row__text">
                      <b>{s.title || 'Untitled session'}</b>
                      <small>{s.lastMessage.split('\n')[0] || 'No conversation yet'}</small>
                    </span>
                    <span className="w3-pc-row__k">
                      Revision {s.draftRevision} · {s.testCount}{' '}
                      {s.testCount === 1 ? 'test' : 'tests'}
                    </span>
                    <span className="w3-co-row__when">{editedWhen(s.modified, now)}</span>
                  </button>
                  <button
                    type="button"
                    className="w3-co-row__del"
                    data-armed={arm.armed === s.id || undefined}
                    aria-label={
                      arm.armed === s.id ? 'Click again to delete the session' : `Delete ${s.title}`
                    }
                    title={arm.armed === s.id ? 'Click again to delete' : 'Delete the session'}
                    onClick={() => arm.press(s.id, () => onDelete(s.id))}
                    onBlur={arm.disarm}
                  >
                    <Icon name="trash" size="xs" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      <section className="w3-pc-block">
        <p className="w3-desk__label">References the Co-Creator can read</p>
        <div className="w3-pc-refs">
          {references.map((ref) => (
            <span key={ref.id} className="w3-pc-ref">
              <Icon name="lines" size="xs" />
              {ref.name}
              <button
                type="button"
                className="w3-pc-ref__x"
                data-armed={arm.armed === `ref:${ref.id}` || undefined}
                aria-label={
                  arm.armed === `ref:${ref.id}` ? 'Click again to remove' : `Remove ${ref.name}`
                }
                title={arm.armed === `ref:${ref.id}` ? 'Click again to remove' : 'Remove'}
                onClick={() => arm.press(`ref:${ref.id}`, () => onRemoveReference(ref.id))}
                onBlur={arm.disarm}
              >
                <Icon name="close" size="xs" />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="w3-pc-ref w3-pc-ref--add"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="plus" size="xs" />
            Add a JSON file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onAddReference(file);
            }}
          />
        </div>
      </section>
    </div>
  );
}
