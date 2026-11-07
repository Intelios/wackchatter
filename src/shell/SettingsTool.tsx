/**
 * Settings, in five chapters: Connections first, then Look, Text, Library and Under the hood.
 * One chapter at a time, so each gets the whole margin and a feel of its own: connections
 * with a pulse and a Test, the look tuned live (the margin steps aside while a slider is
 * held), your library as a card, and the sign-off at the end.
 *
 * The island's search opens a chapter on a setting (`SettingsPage.focus`), which lights up
 * for a moment. Saving is shared with 2.x: the connection editor, the background list, the
 * regex list and the data-location flow are the same components and hooks.
 */

import type { Connection } from '@shared/providers/types.ts';
import type { LocationInfo } from '@shared/types/location.ts';
import { DEFAULT_DIALOGUE_COLORS, type SettingsResponse } from '@shared/types/settings.ts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { UiChoice } from '../app/uiChoice.ts';
import type { AppController, SettingsChapter } from '../app/useAppController.ts';
import { EFFECTS, type EffectId } from '../features/backgrounds/effects.ts';
import { ParticleLayer } from '../features/backgrounds/ParticleLayer.tsx';
import { pairBackgroundEffect } from '../features/backgrounds/resolve.ts';
import { ConnectionEditor } from '../features/connection/ConnectionPanel.tsx';
import { RegexScriptList } from '../features/regex/RegexScriptList.tsx';
import { BUILTIN_BACKGROUNDS } from '../features/settings/backgrounds.ts';
import { DataLocationSection } from '../features/settings/DataLocationSection.tsx';
import { formatBytes } from '../features/settings/dataLocation.ts';
import { useBackgrounds } from '../features/settings/useBackgrounds.ts';
import {
  backgroundApi,
  characterApi,
  libraryApi,
  locationApi,
  settingsApi,
  type VersionInfo,
  versionApi,
} from '../lib/api.ts';
import { downloadUrl } from '../lib/download.ts';
import { Icon } from './icons.tsx';
import {
  backupAge,
  backupIsStale,
  type ConnectionTest,
  connectionHealth,
  connectionUses,
  endpointLabel,
  SETTINGS_CHAPTERS,
} from './settings.ts';
import './settings.css';

export function SettingsTool({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  const page = controller.settingsPage ?? { chapter: 'connections' as const, focus: null };
  const { setSettingsPage } = controller;
  const rootRef = useRef<HTMLDivElement>(null);
  const chapter = SETTINGS_CHAPTERS.find((c) => c.id === page.chapter) ?? SETTINGS_CHAPTERS[0];

  // Opened onto one setting (from the island's search): bring it into view and light it up.
  useEffect(() => {
    const focus = page.focus;
    if (!focus) return;
    const target = rootRef.current?.querySelector<HTMLElement>(`[data-setting="${focus}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute('data-found', '');
    }
    const timer = window.setTimeout(() => {
      target?.removeAttribute('data-found');
      setSettingsPage({ chapter: page.chapter, focus: null });
    }, 1900);
    return () => window.clearTimeout(timer);
  }, [page.focus, page.chapter, setSettingsPage]);

  const go = (id: SettingsChapter) => setSettingsPage({ chapter: id, focus: null });

  return (
    <div className="w3-set" ref={rootRef}>
      <nav className="w3-set__chapters" aria-label="Chapters">
        {SETTINGS_CHAPTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={entry.id === chapter?.id}
            onClick={() => go(entry.id)}
          >
            <Icon name={entry.icon} />
            {entry.title}
          </button>
        ))}
      </nav>
      {/* Keyed by chapter, so only a new chapter slides in; a click inside one just updates. */}
      <section key={chapter?.id} className="w3-set__chapter" aria-label={chapter?.title}>
        <p className="w3-set__lede">{chapter?.lede}</p>
        {page.chapter === 'connections' ? <Connections controller={controller} /> : null}
        {page.chapter === 'look' ? <Look controller={controller} /> : null}
        {page.chapter === 'text' ? <Text controller={controller} /> : null}
        {page.chapter === 'library' ? <Library controller={controller} /> : null}
        {page.chapter === 'hood' ? <Hood controller={controller} onUiChoice={onUiChoice} /> : null}
      </section>
    </div>
  );
}

// ---------- Small pieces ----------

function Group({
  label,
  aside,
  setting,
  children,
}: {
  label?: string;
  aside?: ReactNode;
  setting?: string;
  children: ReactNode;
}) {
  return (
    <div className="w3-set__group" data-setting={setting}>
      {label ? (
        <h3 className="w3-set__label">
          {label}
          {aside ? <small>{aside}</small> : null}
        </h3>
      ) : null}
      {children}
    </div>
  );
}

function Row({
  title,
  hint,
  setting,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  setting?: string;
  children: ReactNode;
}) {
  return (
    <div className="w3-set__row" data-setting={setting}>
      <span className="w3-set__rowtext">
        {title}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </div>
  );
}

function Switch({
  on,
  label,
  onChange,
  disabled,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="w3-switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

function Segments<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: readonly [T, string][];
  label: string;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="w3-set__seg" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * A slider. With `peek`, holding it makes the margin step aside so the chat behind shows the
 * change: everything but this control fades until it is let go.
 */
function Range({
  label,
  value,
  min,
  max,
  step = 1,
  shown,
  setting,
  peek,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  shown: string;
  setting?: string;
  peek?: boolean;
  onChange: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hold = () => {
    if (!peek) return;
    const root = ref.current?.closest<HTMLElement>('.wc3');
    if (!root || !ref.current) return;
    const held = ref.current;
    root.setAttribute('data-peek', '');
    held.setAttribute('data-held', '');
    const release = () => {
      root.removeAttribute('data-peek');
      held.removeAttribute('data-held');
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="w3-set__range" ref={ref} data-setting={setting}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ '--fill': fill } as React.CSSProperties}
        onPointerDown={hold}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <b>{shown}</b>
    </div>
  );
}

/** Two clicks in place: the first arms it, the second does it, leaving disarms it. */
function useArm() {
  const [armed, setArmed] = useState<string | null>(null);
  return {
    armed,
    press: (key: string, act: () => void) => {
      if (armed === key) {
        setArmed(null);
        act();
      } else setArmed(key);
    },
    disarm: () => setArmed(null),
  };
}

// ---------- Connections ----------

function Connections({ controller }: { controller: AppController }) {
  const { settings, setSettings } = controller.app;
  const [open, setOpen] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionTest>>({});
  const [status, setStatus] = useState('');

  if (!settings) return <p className="w3-set__hint">Loading connections…</p>;

  const test = async (connection: Connection) => {
    const id = connection.id;
    setTests((current) => ({ ...current, [id]: { state: 'busy' } }));
    const started = performance.now();
    try {
      const result = await settingsApi.test(connection);
      const ms = Math.round(performance.now() - started);
      setTests((current) => ({
        ...current,
        [id]: result.ok
          ? { state: 'ok', ms, models: result.models }
          : { state: 'failed', error: result.error },
      }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [id]: { state: 'failed', error: (error as Error).message },
      }));
    }
  };

  const create = async () => {
    try {
      const next = await settingsApi.createConnection('custom');
      setSettings(next);
      setOpen(next.connections.at(-1)?.id ?? null);
      setStatus('');
    } catch (error) {
      setStatus((error as Error).message);
    }
  };

  return (
    <div className="w3-set__conns">
      {settings.connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          settings={settings}
          connection={connection}
          open={open === connection.id}
          test={tests[connection.id]}
          onToggle={() => setOpen((current) => (current === connection.id ? null : connection.id))}
          onTest={() => void test(connection)}
          onChange={(next) => {
            setSettings(next);
            // A change to the endpoint or key makes the last test result stale.
            setTests(({ [connection.id]: _, ...rest }) => rest);
          }}
        />
      ))}
      <button
        type="button"
        className="w3-set__add"
        data-setting="new-connection"
        onClick={() => void create()}
      >
        <Icon name="plus" size="sm" />
        New connection
      </button>
      {status ? <p className="w3-set__hint">{status}</p> : null}
      {settings.connections.length === 0 ? (
        <p className="w3-set__hint">No connections yet. Add one, then pick a model in Preset.</p>
      ) : null}
    </div>
  );
}

function ConnectionCard({
  settings,
  connection,
  open,
  test,
  onToggle,
  onTest,
  onChange,
}: {
  settings: SettingsResponse;
  connection: Connection;
  open: boolean;
  test: ConnectionTest | undefined;
  onToggle: () => void;
  onTest: () => void;
  onChange: (settings: SettingsResponse) => void;
}) {
  const key = settings.keys[connection.id];
  const health = connectionHealth(connection, key, test);
  const uses = connectionUses(settings.models, connection.id);
  const busy = test?.state === 'busy';
  return (
    <div className="w3-set__conn" data-open={open || undefined}>
      <div className="w3-set__connhead">
        <span className="w3-set__mark" data-provider={connection.provider}>
          {connection.provider === 'openrouter' ? 'OR' : '{ }'}
          <i data-health={health} title={HEALTH[health]} />
        </span>
        <button type="button" className="w3-set__conntext" aria-expanded={open} onClick={onToggle}>
          <b>{connection.name}</b>
          <span>
            {endpointLabel(connection.baseUrl)}
            {health === 'nokey' ? ' · no key' : ''}
          </span>
          <span className="w3-set__serves">
            {uses.length ? (
              uses.map((use) => <em key={use}>{use}</em>)
            ) : (
              <em data-none>not used yet</em>
            )}
          </span>
        </button>
        <button
          type="button"
          className="w3-set__test"
          data-busy={busy || undefined}
          disabled={busy}
          onClick={onTest}
        >
          <Icon name="bolt" size="xs" />
          {busy ? 'Testing…' : 'Test'}
        </button>
      </div>
      {test?.state === 'ok' ? (
        <p className="w3-set__result" data-ok>
          <b>{test.ms} ms</b> answered · {test.models.toLocaleString()} models on offer
        </p>
      ) : test?.state === 'failed' ? (
        <p className="w3-set__result" data-bad>
          {test.error}
        </p>
      ) : null}
      {open ? (
        <div className="w3-set__connedit">
          <ConnectionEditor
            key={connection.id}
            settings={settings}
            connection={connection}
            onChange={onChange}
          />
        </div>
      ) : null}
    </div>
  );
}

const HEALTH = {
  ok: 'Ready',
  nokey: 'No key saved, and this provider needs one',
  failed: 'The last test failed',
} as const;

// ---------- Look ----------

function Look({ controller }: { controller: AppController }) {
  const { settings, patchUserSettings: patch } = controller.app;
  const selected = typeof settings?.background === 'string' ? settings.background : null;
  const backgrounds = useBackgrounds({ selected, onPick: (background) => patch({ background }) });
  const fileInput = useRef<HTMLInputElement>(null);
  const arm = useArm();
  const effectMap: Record<string, string> = settings?.backgroundEffects ?? {};
  const effect = selected !== null ? (effectMap[selected] ?? null) : null;
  const selectedLabel =
    selected === null
      ? null
      : (BUILTIN_BACKGROUNDS.find((entry) => `builtin:${entry.id}` === selected)?.label ??
        selected.replace(/^user:/, ''));
  const dialogue = settings?.dialogueColors ?? DEFAULT_DIALOGUE_COLORS;
  const effectsOn = settings?.backgroundEffectEnabled !== false;

  return (
    <>
      <Group label="Background" aside={selectedLabel ?? 'None'} setting="background">
        <div className="w3-set__bgs">
          <button
            type="button"
            className="w3-set__bg"
            data-none
            aria-pressed={selected === null}
            onClick={() => patch({ background: null })}
          >
            <span>None</span>
          </button>
          {BUILTIN_BACKGROUNDS.map((background) => (
            <button
              key={background.id}
              type="button"
              className="w3-set__bg"
              aria-pressed={selected === `builtin:${background.id}`}
              data-effect={effectMap[`builtin:${background.id}`] || undefined}
              style={{ backgroundImage: `url("${background.url}")` }}
              title={background.label}
              onClick={() => patch({ background: `builtin:${background.id}` })}
            >
              <span>{background.label}</span>
            </button>
          ))}
          {backgrounds.uploads.map((upload) => (
            <div key={upload.name} className="w3-set__bgwrap">
              <button
                type="button"
                className="w3-set__bg"
                aria-pressed={selected === `user:${upload.name}`}
                data-effect={effectMap[`user:${upload.name}`] || undefined}
                style={{
                  backgroundImage: `url("${backgroundApi.url(upload.name, upload.modified)}")`,
                }}
                title={upload.name}
                onClick={() => patch({ background: `user:${upload.name}` })}
              >
                <span>{upload.name}</span>
              </button>
              <button
                type="button"
                className="w3-set__bgdel"
                data-armed={arm.armed === upload.name || undefined}
                title={arm.armed === upload.name ? 'Click again to delete' : 'Delete'}
                aria-label={
                  arm.armed === upload.name
                    ? `Click again to delete ${upload.name}`
                    : `Delete ${upload.name}`
                }
                onBlur={arm.disarm}
                onClick={() => arm.press(upload.name, () => void backgrounds.remove(upload.name))}
              >
                <Icon name="trash" size="xs" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="w3-set__bg"
            data-upload
            title="Add your own"
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="upload" size="sm" />
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="wc-visually-hidden"
          onChange={(event) => {
            void backgrounds.upload(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <div className="w3-set__actions">
          <button
            type="button"
            className="w3-set__ghost"
            onClick={() => void backgrounds.importFromSillyTavern()}
          >
            Import from SillyTavern
          </button>
          {backgrounds.status ? <span className="w3-set__hint">{backgrounds.status}</span> : null}
        </div>
      </Group>

      <Group>
        <Range
          label="Blur"
          setting="blur"
          peek
          value={Number(settings?.backgroundBlur ?? 8)}
          min={0}
          max={40}
          shown={`${Number(settings?.backgroundBlur ?? 8)}px`}
          onChange={(value) => patch({ backgroundBlur: Math.round(value) })}
        />
        <Range
          label="Dim"
          setting="dim"
          peek
          value={Number(settings?.backgroundDim ?? 0.55)}
          min={0}
          max={1}
          step={0.01}
          shown={`${Math.round(Number(settings?.backgroundDim ?? 0.55) * 100)}%`}
          onChange={(value) => patch({ backgroundDim: value })}
        />
        <Row
          title="Glass surfaces"
          hint="Bubbles and panels let the background through"
          setting="glass"
        >
          <Switch
            label="Glass surfaces"
            on={settings?.glass !== false}
            onChange={(glass) => patch({ glass })}
          />
        </Row>
      </Group>

      <Group
        label="Effect"
        aside={selectedLabel ? `paired with ${selectedLabel}` : 'pick a background first'}
        setting="effect"
      >
        <div className="w3-set__fx">
          <button
            type="button"
            aria-pressed={effect === null}
            disabled={selected === null}
            onClick={() =>
              selected !== null &&
              patch({ backgroundEffects: pairBackgroundEffect(effectMap, selected, null) })
            }
          >
            <span>None</span>
          </button>
          {EFFECTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={effect === entry.id}
              disabled={selected === null}
              onClick={() =>
                selected !== null &&
                patch({
                  backgroundEffects: pairBackgroundEffect(effectMap, selected, entry.id),
                })
              }
            >
              {effectsOn ? <ParticleLayer effect={entry.id as EffectId} layer="behind" /> : null}
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
        <Row
          title="Animated effects"
          hint="Paused while the window is hidden, and with reduced motion"
        >
          <Switch
            label="Animated effects"
            on={effectsOn}
            onChange={(backgroundEffectEnabled) => patch({ backgroundEffectEnabled })}
          />
        </Row>
        <Row title="Where it’s drawn" hint="Behind softens it under the chat; in front is busier">
          <Segments
            label="Where the effect is drawn"
            value={settings?.backgroundEffectLayer === 'front' ? 'front' : 'behind'}
            options={[
              ['behind', 'Behind'],
              ['front', 'In front'],
            ]}
            onChange={(backgroundEffectLayer) => patch({ backgroundEffectLayer })}
          />
        </Row>
      </Group>

      <Group label="Dialogue colour" setting="dialogue">
        <Row title="Colour quoted dialogue" hint="Each speaker in their own colour">
          <Switch
            label="Colour quoted dialogue"
            on={dialogue.enabled}
            onChange={(enabled) => patch({ dialogueColors: { ...dialogue, enabled } })}
          />
        </Row>
        <p className="w3-set__dialogue" data-on={dialogue.enabled || undefined}>
          <q data-you>Can we go to the tavern after?</q> you ask.{' '}
          <q data-them>Only if you’re buying,</q> comes the answer.
        </p>
      </Group>
    </>
  );
}

// ---------- Text ----------

function Text({ controller }: { controller: AppController }) {
  const { settings, patchUserSettings: patch } = controller.app;
  const scripts = settings?.regexScripts ?? [];
  const tags = settings?.hiddenTags ?? [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim();
    if (tag && !tags.includes(tag)) patch({ hiddenTags: [...tags, tag] });
    setDraft('');
  };
  return (
    <>
      <Group
        label="Regex scripts"
        aside={`${scripts.filter((s) => !s.disabled).length} of ${scripts.length} on`}
        setting="regex"
      >
        <div className="w3-set__legacy">
          <RegexScriptList scripts={scripts} onChange={(regexScripts) => patch({ regexScripts })} />
        </div>
      </Group>
      <Group label="Hidden tags" aside="kept off character cards" setting="hidden-tags">
        <div className="w3-set__chips">
          {tags.map((tag) => (
            <span key={tag} className="w3-set__chip">
              {tag}
              <button
                type="button"
                aria-label={`Stop hiding ${tag}`}
                onClick={() => patch({ hiddenTags: tags.filter((t) => t !== tag) })}
              >
                <Icon name="close" size="xs" />
              </button>
            </span>
          ))}
          <input
            value={draft}
            placeholder="Add a tag"
            aria-label="Add a tag to hide"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
            onBlur={add}
          />
        </div>
        <p className="w3-set__hint">
          These tags don’t show as chips on character cards. The cards themselves stay visible.
        </p>
      </Group>
    </>
  );
}

// ---------- Library ----------

function Library({ controller }: { controller: AppController }) {
  const { app, library, backups, presetDraft } = controller;
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [withKeys, setWithKeys] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const arm = useArm();
  const lastBackupAt = app.settings?.lastBackupAt ?? null;

  useEffect(() => {
    let live = true;
    // Sizing walks the whole library, so the card renders first and fills in after.
    void locationApi
      .get(true)
      .then((info) => live && setLocation(info))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The server notes the backup once the archive is built; watch for that, briefly.
  useEffect(() => {
    if (!preparing) return;
    const before = lastBackupAt;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      try {
        const fresh = await settingsApi.get();
        if (fresh.lastBackupAt !== before) {
          app.setSettings(fresh);
          setPreparing(false);
        }
      } catch {
        /* the next tick tries again */
      }
      if (tries > 60) setPreparing(false);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [preparing, lastBackupAt, app.setSettings]);

  const now = Date.now();
  const stale = backupIsStale(lastBackupAt, now);
  const byAvatar = new Map(library.characters.map((c) => [c.avatar, c]));

  return (
    <>
      <div className="w3-set__lib" data-setting="backup">
        <div className="w3-set__libpath">
          <Icon name="folder" size="sm" />
          <span title={location?.root}>{location?.root ?? 'Finding your library…'}</span>
        </div>
        <div className="w3-set__libstats">
          <div>
            <b>{library.characters.length.toLocaleString()}</b>
            <span>characters</span>
          </div>
          <div>
            <b>{library.personas.length.toLocaleString()}</b>
            <span>personas</span>
          </div>
          <div>
            <b>{location?.size ? formatBytes(location.size.bytes) : '…'}</b>
            <span>on disk</span>
          </div>
        </div>
        <div className="w3-set__libfoot" data-stale={stale || undefined}>
          <i />
          <span>{preparing ? 'Building your backup…' : backupAge(lastBackupAt, now)}</span>
          <button
            type="button"
            className="w3-set__pill"
            disabled={preparing}
            onClick={() => {
              setPreparing(true);
              downloadUrl(libraryApi.exportUrl(withKeys));
            }}
          >
            <Icon name="download" size="xs" />
            Back up now
          </button>
        </div>
      </div>
      <Row
        title="Include API keys in the backup"
        hint="Off by default: the zip isn’t protected, so anyone who opens it can read them"
      >
        <Switch label="Include API keys" on={withKeys} onChange={setWithKeys} />
      </Row>
      <p className="w3-set__hint">
        Everything goes in one zip: characters, chats, presets, personas, lorebooks, backgrounds and
        the bin. To restore, unzip it anywhere and point “Where it lives” below at the folder
        inside.
      </p>

      <Group
        label="Recently deleted"
        aside={backups.backups.length ? `${backups.backups.length} chats` : undefined}
        setting="deleted"
      >
        {backups.backups.length === 0 ? (
          <p className="w3-set__hint">Nothing here. Deleted chats wait in this bin.</p>
        ) : (
          <ul className="w3-set__bin">
            {backups.backups.map((backup) => {
              const character = byAvatar.get(backup.characterId);
              const key = `bin:${backup.backupId}`;
              return (
                <li key={backup.backupId}>
                  {character ? (
                    <img src={characterApi.imageUrl(backup.characterId)} alt="" />
                  ) : (
                    <i aria-hidden="true" />
                  )}
                  <div>
                    <b>{backup.title}</b>
                    <span>
                      {character?.name ?? backup.characterId.replace(/\.png$/i, '')} · deleted{' '}
                      {deletedWhen(backup.deleted, now)}
                      {backup.messageCount ? ` · ${backup.messageCount} messages` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="w3-set__icon"
                    disabled={!character}
                    title={
                      character
                        ? 'Restore this chat'
                        : `${backup.characterId} no longer exists — re-import the character, then restore.`
                    }
                    aria-label={`Restore ${backup.title}`}
                    onClick={() => void backups.restoreBackup(backup.backupId)}
                  >
                    <Icon name="restore" size="sm" />
                  </button>
                  <button
                    type="button"
                    className="w3-set__icon"
                    data-armed={arm.armed === key || undefined}
                    aria-label={
                      arm.armed === key
                        ? 'Click again to delete for good'
                        : `Delete ${backup.title} for good`
                    }
                    onBlur={arm.disarm}
                    onClick={() => arm.press(key, () => void backups.purgeBackup(backup.backupId))}
                  >
                    {arm.armed === key ? 'Delete for good?' : <Icon name="trash" size="sm" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {backups.backups.length > 1 ? (
          <button
            type="button"
            className="w3-set__ghost"
            data-armed={arm.armed === 'bin:all' || undefined}
            onBlur={arm.disarm}
            onClick={() => arm.press('bin:all', () => void backups.purgeAllBackups())}
          >
            {arm.armed === 'bin:all'
              ? `Click again to delete all ${backups.backups.length} for good`
              : 'Empty the bin'}
          </button>
        ) : null}
      </Group>

      <Group label="Where it lives" setting="location">
        <div className="w3-set__legacy">
          <DataLocationSection bare unsavedPreset={presetDraft.dirty} />
        </div>
      </Group>
    </>
  );
}

function deletedWhen(timestamp: number, now: number): string {
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------- Under the hood ----------

const WHATS_NEW = [
  'A new home for every chat: the island, the Aura and the Line',
  'Models are picked where they’re used; connections are set once',
  'Story memory with Nexus',
  'Inspect: every reply timed, and the prompt it sent',
  'Lorebooks that say why an entry fired',
  'Group chats are gone; the Arena and Tournament stay',
];

function Hood({
  controller,
  onUiChoice,
}: {
  controller: AppController;
  onUiChoice: (choice: UiChoice) => void;
}) {
  const { settings, patchUserSettings: patch } = controller.app;
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [news, setNews] = useState(false);
  const [power, setPower] = useState<'idle' | 'armed' | 'stopping' | 'stopped'>('idle');

  useEffect(() => {
    let live = true;
    void versionApi
      .get()
      .then((info) => live && setVersion(info))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const shutdown = async () => {
    if (power === 'idle') {
      setPower('armed');
      return;
    }
    if (power !== 'armed') return;
    setPower('stopping');
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      /* the server going away mid-request is the success case */
    }
    setPower('stopped');
  };

  const fps = Number(settings?.streamingFps ?? 30);
  const tokenizer = (settings?.tokenizerEncoding ?? 'auto') as
    | 'auto'
    | 'o200k_base'
    | 'cl100k_base';
  const behind = version?.commitsBehind ?? 0;

  return (
    <>
      <Group>
        <Range
          label="Streaming"
          setting="streaming"
          value={fps}
          min={5}
          max={120}
          shown={`${fps} fps`}
          onChange={(value) => patch({ streamingFps: Math.round(value) })}
        />
        <p className="w3-set__hint">
          How often a reply being written repaints. Lower is easier on a slow machine.
        </p>
        <Row
          title="Token counter"
          hint="Exact for OpenAI models, an estimate everywhere else"
          setting="tokenizer"
        >
          <Segments
            label="Token counter"
            value={tokenizer}
            options={[
              ['auto', 'Auto'],
              ['o200k_base', 'o200k'],
              ['cl100k_base', 'cl100k'],
            ]}
            onChange={(tokenizerEncoding) => patch({ tokenizerEncoding })}
          />
        </Row>
        <Row
          title="Record usage for TokenTrail"
          hint="Every reply’s tokens, kept on this machine in ~/.wackchatter/usage"
          setting="usage"
        >
          <Switch
            label="Record usage for TokenTrail"
            on={Boolean(settings?.usageLog)}
            onChange={(usageLog) => patch({ usageLog })}
          />
        </Row>
        <Row title="The 2.x interface" hint="While 3.0 is finished · Ctrl+Shift+U" setting="legacy">
          <button type="button" className="w3-set__ghost" onClick={() => onUiChoice('legacy')}>
            Switch
          </button>
        </Row>
      </Group>

      <div className="w3-set__signoff" data-setting="version">
        <div className="w3-set__version">
          <b>WackChatter {version?.version ?? ''}</b>
          {version?.branch && version.revision ? (
            <span>
              {version.branch} {version.revision}
            </span>
          ) : null}
        </div>
        {behind > 0 ? (
          <p className="w3-set__update">
            <i />
            Update ready: {behind} {behind === 1 ? 'commit' : 'commits'} behind. Run{' '}
            <code>./update.sh</code>
          </p>
        ) : null}
        <button
          type="button"
          className="w3-set__fold"
          aria-expanded={news}
          onClick={() => setNews((open) => !open)}
        >
          <Icon name="chevronDown" size="xs" />
          What’s new in 3.0
        </button>
        {news ? (
          <ul className="w3-set__news">
            {WHATS_NEW.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          className="w3-set__power"
          data-setting="shutdown"
          data-state={power}
          disabled={power === 'stopping' || power === 'stopped'}
          onBlur={() => power === 'armed' && setPower('idle')}
          onClick={() => void shutdown()}
        >
          <Icon name="power" size="sm" />
          {power === 'idle'
            ? 'Shut down WackChatter'
            : power === 'armed'
              ? 'Click again to shut down'
              : power === 'stopping'
                ? 'Shutting down…'
                : 'Stopped. You can close this tab.'}
        </button>
        <p className="w3-set__hint">
          Restart with <code>./start.sh</code> or <code>bun run start</code>.
        </p>
      </div>
    </>
  );
}
