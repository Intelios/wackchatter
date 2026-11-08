/**
 * The Character Co-Creator in the 3.0 shell: its own place, like the Studio.
 *
 * The island carries only the session: the card taking shape (its face, its name, how many
 * fields are in) and ⌘K for another session. On the way in, the sessions lie like the
 * Studio's desk: the one you were last on, big, the rest under it. The colour is the app's
 * own lime, the colour of making something; a new card has no portrait to take one from.
 *
 * The Preset Co-Creator is its own thing and still draws in the 2.x shell.
 */

import './studio.css';
import './cocreator.css';

import { slotRef } from '@shared/models/slots.ts';
import type { CharacterDetail, CharacterSummary } from '@shared/types/card.ts';
import type { CocreatorSession, CocreatorSessionSummary } from '@shared/types/cocreator.ts';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppController } from '../app/useAppController.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { Popover } from '../components/Popover.tsx';
import {
  needsPortrait,
  resolveSpeakerColors,
  useAvatarPalette,
} from '../features/chat/avatarColor.ts';
import { ModelsProvider } from '../features/models/ModelsContext.tsx';
import { characterApi, cocreatorApi, personaApi } from '../lib/api.ts';
import type { PersistenceControls } from '../lib/autosave.ts';
import { Avatar } from './Avatar.tsx';
import { CoCreatorDesk, type DeskHandle, type DeskReport } from './CoCreatorDesk.tsx';
import { MAIN_FIELD_COUNT } from './cocreator.ts';
import { Island, type IslandMode, type IslandNotice } from './Island.tsx';
import { type SearchItem, SearchPane } from './IslandPanes.tsx';
import { Icon } from './icons.tsx';
import { ModelPane } from './ModelPane.tsx';
import { editedWhen } from './studio.ts';
import { initialAuraStyle, useAura } from './useAura.ts';

const LIME = '#c2ee4a';

/** A model id as a short name: the part after the vendor, e.g. "GLM-5.3-Flash". */
function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.split('/').pop() ?? id;
}

export function CoCreator({ controller }: { controller: AppController }) {
  const { app, library } = controller;
  const { settings, view: prefs, models } = app;

  const [sessions, setSessions] = useState<CocreatorSessionSummary[]>([]);
  const [session, setSession] = useState<CocreatorSession | null>(null);
  const [seed, setSeed] = useState<CharacterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<IslandMode | null>(null);
  const [report, setReport] = useState<DeskReport | null>(null);
  const [notice, setNotice] = useState<IslandNotice | null>(null);
  const noticeId = useRef(0);
  const persistence = useRef<PersistenceControls | null>(null);
  const seededFrom = useRef<string | null>(null);
  const deskRef = useRef<DeskHandle | null>(null);
  const [modelFor, setModelFor] = useState<'main' | 'side'>('main');
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
        title: 'Co-Creator',
        text: typeof err === 'string' ? err : (err as Error).message,
        tone: 'bad',
        sticky: true,
      }),
    [say],
  );

  const refresh = useCallback(async () => setSessions(await cocreatorApi.list()), []);
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
        const next = await cocreatorApi.get(id);
        setReport(null);
        setSeed(null);
        setSession(next);
      } catch (err) {
        fail(err);
      }
    },
    [fail, leaveSession],
  );

  const create = useCallback(
    async (from?: CharacterSummary) => {
      setMode(null);
      if (!(await leaveSession())) return;
      try {
        const detail = from ? await characterApi.get(from.avatar) : null;
        const created = await cocreatorApi.create(
          detail ? detail.name.trim() || undefined : undefined,
          detail ? detail.avatar : undefined,
        );
        setReport(null);
        setSeed(detail);
        setSession(created);
        void refresh().catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    [fail, leaveSession, refresh],
  );

  // The Studio's handoff: arrive on a new session seeded from that card, exactly once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the handed-off card
  useEffect(() => {
    const avatar = controller.cocreatorSeedAvatar;
    // Once per handoff, even when an effect runs twice: a second run would make a second
    // session from the same card.
    if (!avatar || seededFrom.current === avatar) return;
    seededFrom.current = avatar;
    const card = library.characters.find((c) => c.avatar === avatar);
    void create(card ?? ({ avatar } as CharacterSummary));
  }, [controller.cocreatorSeedAvatar]);

  const toSessions = useCallback(async () => {
    setMode(null);
    if (!(await leaveSession())) return;
    setSession(null);
    setSeed(null);
    setReport(null);
    void refresh().catch(fail);
  }, [fail, leaveSession, refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await cocreatorApi.remove(id);
        await refresh();
      } catch (err) {
        fail(err);
      }
    },
    [fail, refresh],
  );

  // --- Colour: the app's lime, and your persona's for your own turns ---
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
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMode((current) => (current === 'search' ? null : 'search'));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const searchItems = useMemo<SearchItem[]>(
    () => [
      { key: 'new', kind: 'Action', label: 'New card', icon: 'plus', run: () => void create() },
      ...[...sessions]
        .filter((s) => s.id !== session?.id)
        .sort((a, b) => b.modified - a.modified)
        .map((s) => ({
          key: s.id,
          kind: 'Session',
          label: s.title || 'Untitled session',
          sub: s.lastMessage.slice(0, 60) || undefined,
          face: {
            name: s.title,
            url: s.avatar ? cocreatorApi.avatarUrl(s.id, s.modified) : null,
          },
          run: () => void open(s.id),
        })),
    ],
    [sessions, session?.id, create, open],
  );

  const seedName = session?.seedAvatar
    ? (seed?.card.data.name ??
      library.characters.find((c) => c.avatar === session.seedAvatar)?.name ??
      null)
    : null;
  const filled = report?.filled ?? 0;

  const restPane = session ? (
    <>
      <span className="w3-isl-btn w3-st-isl-card">
        <Avatar
          url={session.avatar ? cocreatorApi.avatarUrl(session.id, session.modified) : null}
          name={report?.name || session.title}
          size="sm"
        />
        <span className="w3-isl-stack">
          <span className="w3-who-name">{report?.name || session.title || 'Untitled'}</span>
          <span className="w3-who-sub w3-co-isl-sub">
            {seedName ? `Updating ${seedName}` : 'New card'} · {filled} of {MAIN_FIELD_COUNT}
            <span className="w3-co-meter" aria-hidden="true">
              {Array.from({ length: MAIN_FIELD_COUNT }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of dots
                <i key={i} data-on={i < filled || undefined} />
              ))}
            </span>
            {report?.saveError ? <b className="w3-co-isl-err"> · Not saved</b> : null}
          </span>
        </span>
      </span>
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-btn w3-co-isl-model"
        aria-label={`Model: ${report?.modelName ?? 'none'}. Change it`}
        title="The model writing this card"
        onClick={() => {
          setModelFor('main');
          setMode('model');
        }}
      >
        <span className="w3-isl-stack">
          <span className="w3-co-isl-model__name">
            {modelLabel(report?.modelName) ?? 'Choose a model'}
          </span>
          <span className="w3-who-sub">{report?.model ? 'This session' : 'The Co-Creator’s'}</span>
        </span>
        <Icon name="chevronDown" size="sm" />
      </button>
      <span className="w3-isl-sep" aria-hidden="true" />
      <button
        type="button"
        className="w3-isl-search"
        aria-label="Find a session"
        onClick={() => setMode('search')}
      >
        <Icon name="search" />
        <kbd className="w3-kbd">⌘K</kbd>
      </button>
    </>
  ) : (
    <>
      <span className="w3-st-mark">
        <Icon name="spark" size="sm" />
        Co-Creator
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
  );

  const backLabel = controller.active ? 'Back to chat' : 'Home';
  const islandMode: IslandMode = mode ?? 'rest';

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
        className="wc3 w3-studio w3-co"
        data-overlay-root
        data-screen={session ? 'desk' : 'sessions'}
        style={firstAura as CSSProperties}
      >
        <div className="w3-aura" aria-hidden="true" />
        <div className="w3-wash" ref={washRef} aria-hidden="true" />

        <header className="w3-studio__top">
          <div className="w3-studio__side">
            {session ? (
              <button type="button" className="w3-st-topbtn" onClick={() => void toSessions()}>
                <Icon name="chevronLeft" size="sm" />
                Sessions
              </button>
            ) : (
              <button
                type="button"
                className="w3-st-topbtn"
                onClick={() => void controller.exitCoCreator()}
              >
                <Icon name="chevronLeft" size="sm" />
                {backLabel}
              </button>
            )}
          </div>
          <div className="w3-studio__side w3-studio__side--right">
            {session ? (
              <button
                type="button"
                className="w3-st-topbtn"
                onClick={() => void controller.exitCoCreator()}
              >
                <Icon name="home" size="sm" />
                {backLabel}
              </button>
            ) : null}
          </div>
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
            rest: restPane,
            search: (
              <SearchPane
                active={islandMode === 'search'}
                items={searchItems}
                placeholder="Find a session"
                onRun={(item) => {
                  setMode(null);
                  item.run();
                }}
              />
            ),
            model: session ? (
              <ModelPane
                active={islandMode === 'model'}
                value={modelFor === 'main' ? report?.model : report?.sideModel}
                emptyLabel={modelFor === 'main' ? 'The Co-Creator’s' : 'The side chat’s'}
                emptyFollows={
                  modelFor === 'main' ? slotRef(models.slots, 'cocreator') : models.slots.sideChat
                }
                head={
                  report?.sideReady ? (
                    <div className="w3-co-mpfor">
                      <button
                        type="button"
                        aria-pressed={modelFor === 'main'}
                        onClick={() => setModelFor('main')}
                      >
                        The conversation
                        <small>{modelLabel(report.modelName) ?? 'None'}</small>
                      </button>
                      <button
                        type="button"
                        aria-pressed={modelFor === 'side'}
                        onClick={() => setModelFor('side')}
                      >
                        The side chat
                        <small>{modelLabel(report.sideModelName) ?? 'None'}</small>
                      </button>
                    </div>
                  ) : null
                }
                onPick={(ref) => {
                  deskRef.current?.setModel(modelFor, ref);
                  setMode(null);
                }}
              />
            ) : null,
          }}
        />

        <div className="w3-studio__body">
          <ErrorBoundary where="Co-Creator" resetKeys={[session?.id ?? null]}>
            {session ? (
              <CoCreatorDesk
                key={session.id}
                session={session}
                seed={seed}
                seedName={seedName}
                defaults={prefs.coCreator}
                connections={settings?.connections ?? []}
                models={models.slots}
                onModelSlotChange={app.setModelSlot}
                presets={library.presets}
                activePresetId={library.presetId}
                activePreset={library.preset}
                tokenizerEncoding={settings?.tokenizerEncoding}
                onDefaultsChange={(patch) => void app.patchSettings({ coCreator: patch })}
                characters={library.characters}
                streamingFps={prefs.streamingFps}
                registerPersistence={register}
                handle={deskRef}
                onReport={setReport}
                onFinished={controller.finishCoCreator}
                onError={fail}
              />
            ) : loading ? null : (
              <Sessions
                sessions={sessions}
                characters={library.characters}
                onOpen={(id) => void open(id)}
                onCreate={(from) => void create(from)}
                onDelete={(id) => void remove(id)}
                onPreset={() => controller.setCoCreatorMode('preset')}
              />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </ModelsProvider>
  );
}

// ---------- Sessions, laid out like the Studio's desk ----------

function SessionFace({ session, size }: { session: CocreatorSessionSummary; size: 'big' | 'row' }) {
  const initial = [...(session.title.trim() || '?')][0]?.toUpperCase();
  return (
    <span className={`w3-co-face w3-co-face--${size}`}>
      {session.avatar ? (
        <img src={cocreatorApi.avatarUrl(session.id, session.modified)} alt="" draggable={false} />
      ) : (
        initial
      )}
    </span>
  );
}

function Sessions({
  sessions,
  characters,
  onOpen,
  onCreate,
  onDelete,
  onPreset,
}: {
  sessions: readonly CocreatorSessionSummary[];
  characters: readonly CharacterSummary[];
  onOpen: (id: string) => void;
  onCreate: (from?: CharacterSummary) => void;
  onDelete: (id: string) => void;
  onPreset: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [armed, setArmed] = useState<string | null>(null);
  const now = Date.now();
  const sorted = [...sessions].sort((a, b) => b.modified - a.modified);
  const desk = sorted[0] ?? null;
  const rest = sorted.slice(1);
  const nameOf = (avatar: string) =>
    characters.find((c) => c.avatar === avatar)?.name ?? avatar.replace(/\.png$/i, '');
  const matches = characters
    .filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 40);

  return (
    <div className="w3-desk">
      <header className="w3-desk__head">
        <h1>
          Character Co-Creator
          <small>
            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
          </small>
        </h1>
        <div className="w3-desk__acts">
          <button type="button" className="w3-st-pill" onClick={() => onCreate()}>
            <Icon name="plus" size="sm" />
            New card
          </button>
          <Popover
            label="Start from a card"
            icon={null}
            open={picking}
            onOpenChange={setPicking}
            placement="bottom-end"
            role="dialog"
            popupClassName="w3-co-expop"
            renderTrigger={(props) => (
              <button
                {...props}
                type="button"
                className="w3-st-ghost"
                onClick={() => setPicking(!picking)}
              >
                <Icon name="studio" size="sm" />
                Start from a card
              </button>
            )}
          >
            <div className="w3-co-expop__body">
              <label className="w3-st-search">
                <Icon name="search" size="sm" />
                <input
                  value={query}
                  placeholder="Which card?"
                  aria-label="Find a card to start from"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="w3-co-expick">
                {matches.map((c) => (
                  <button
                    key={c.avatar}
                    type="button"
                    onClick={() => {
                      setPicking(false);
                      onCreate(c);
                    }}
                  >
                    <img
                      src={characterApi.imageUrl(c.avatar, c.modified)}
                      alt=""
                      loading="lazy"
                      draggable={false}
                    />
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          </Popover>
          <button type="button" className="w3-st-ghost" onClick={onPreset}>
            <Icon name="sliders" size="sm" />
            Preset Co-Creator
          </button>
        </div>
      </header>

      {desk ? (
        <div className="w3-desk__desk w3-co-deskcard">
          <button
            type="button"
            className="w3-desk__art w3-co-deskart"
            aria-label={`Open ${desk.title}`}
            onClick={() => onOpen(desk.id)}
          >
            <SessionFace session={desk} size="big" />
          </button>
          <div className="w3-desk__body">
            <span className="w3-desk__eyebrow">
              Where you left off · {editedWhen(desk.modified, now)}
            </span>
            <h2>{desk.title || 'Untitled session'}</h2>
            {desk.lastMessage ? <p className="w3-desk__quote">{desk.lastMessage}</p> : null}
            <div className="w3-desk__facts">
              <span>
                <b>{desk.messageCount}</b> messages
              </span>
              <span>
                <b>{desk.stashedSlots}</b> in the card
              </span>
              {desk.finishedAvatar ? <span>Finished as {nameOf(desk.finishedAvatar)}</span> : null}
            </div>
            <button
              type="button"
              className="w3-st-pill w3-desk__go"
              onClick={() => onOpen(desk.id)}
            >
              Keep going
              <Icon name="chevronRight" size="sm" />
            </button>
          </div>
        </div>
      ) : null}

      {rest.length ? <p className="w3-desk__label">Earlier</p> : null}
      <div className="w3-co-rows">
        {rest.map((s) => (
          <div key={s.id} className="w3-co-row">
            <button type="button" className="w3-co-row__open" onClick={() => onOpen(s.id)}>
              <SessionFace session={s} size="row" />
              <span className="w3-co-row__text">
                <b>{s.title || 'Untitled session'}</b>
                <small>{s.lastMessage || 'No messages yet'}</small>
              </span>
              <span className="w3-co-row__state" data-done={s.finishedAvatar ? true : undefined}>
                {s.finishedAvatar
                  ? `Finished · ${nameOf(s.finishedAvatar)}`
                  : `${s.stashedSlots} in the card`}
              </span>
              <span className="w3-co-row__when">{editedWhen(s.modified, now)}</span>
            </button>
            <button
              type="button"
              className="w3-co-row__del"
              data-armed={armed === s.id || undefined}
              aria-label={
                armed === s.id ? 'Click again to delete the session' : `Delete ${s.title}`
              }
              title={armed === s.id ? 'Click again to delete' : 'Delete the session'}
              onClick={() => (armed === s.id ? onDelete(s.id) : setArmed(s.id))}
              onBlur={() => setArmed(null)}
            >
              <Icon name="trash" size="xs" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
