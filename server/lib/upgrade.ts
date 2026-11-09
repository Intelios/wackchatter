/**
 * The one library conversion 3.0 carries: 2.3 to 3.0.
 *
 * 2.3 rewrote everything older on first open, but some values it only ever repaired as they
 * were read, and 3.0 reshapes a few of its own. 3.0 reads neither old form, so this writes
 * them out once, in steps (`STEPS`). The meta row `conversion_step` records how many have
 * run; a library 2.3 left has none. Every step is idempotent — it is marked done only after
 * it returns, so a crash in between reruns it — and none touches `modified`: a conversion is
 * not the user opening every chat, and recency drives the recents list and Stats. Revisions
 * move, so a tab holding a pre-conversion snapshot cannot write it back.
 *
 *   1. Chats. `memoryMode: 'memories'` (pre-Nexus) becomes `'nexus'`, in settings.json and
 *      per chat; a chat with no frozen `memoryMode` gets the app default; a chat with no
 *      recorded `persona` gets the current one, and user messages with no recorded speaker
 *      get the chat's persona — what 2.x stamped when a chat was opened. Only direct chats:
 *      the group scenes 3.0 removed stay exactly as 2.x left them.
 *   2. Models. A connection no longer carries a model; every feature holds a `ModelRef`.
 *      Each old connection/model pair becomes the ref it meant at the time, in settings.json
 *      (the app slots, the Arena's contenders) and in the Co-Creator sessions and Preset
 *      Co-Creator documents that kept their own.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankCardData } from '../../shared/card/blank.ts';
import type { ModelRef } from '../../shared/models/slots.ts';
import { getCharacterImage, getCharacterRecord } from './characters.ts';
import { atomicWriteSync } from './fs.ts';
import { PATHS } from './paths.ts';

const MARKER = 'conversion_step';

/** The parts of settings.json the conversion reads, taken raw: the cache normalises them. */
function readStoredSettings(): Record<string, unknown> | null {
  if (!existsSync(PATHS.settings)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PATHS.settings, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeStoredSettings(settings: Record<string, unknown>): void {
  atomicWriteSync(PATHS.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Step 1. Returns whether settings.json was rewritten. */
function convertChats(database: Database): boolean {
  const stored = readStoredSettings();
  const settingsChanged = stored?.memoryMode === 'memories';
  const storedMode = settingsChanged ? 'nexus' : stored?.memoryMode;
  const defaultMode =
    storedMode === 'classic' || storedMode === 'nexus' || storedMode === 'off'
      ? storedMode
      : 'classic';
  const personaId = typeof stored?.personaId === 'string' ? stored.personaId : null;

  // Settings first, so a failed write cannot hide behind a converted database. Rewriting
  // `nexus` over `nexus` on a rerun is harmless.
  if (settingsChanged && stored) writeStoredSettings({ ...stored, memoryMode: 'nexus' });

  database.transaction(() => {
    // Malformed metadata (the JSON literal null, say) reads as {} everywhere else, so it is
    // converted as {} here rather than left for json_set to return NULL on.
    const object = "CASE WHEN json_type(metadata) = 'object' THEN metadata ELSE '{}' END";
    database
      .query(
        `UPDATE chats
            SET metadata = json_set(${object}, '$.memoryMode',
                  CASE WHEN json_extract(${object}, '$.memoryMode') = 'memories'
                       THEN 'nexus' ELSE ? END),
                revision = revision + 1, save_token = NULL
          WHERE kind = 'direct'
            AND (json_extract(${object}, '$.memoryMode') IS NULL
                 OR json_extract(${object}, '$.memoryMode') = 'memories')`,
      )
      .run(defaultMode);
    database
      .query(
        `UPDATE chats
            SET metadata = json_set(${object}, '$.persona', json(?)),
                revision = revision + 1, save_token = NULL
          WHERE kind = 'direct' AND json_type(${object}, '$.persona') IS NULL`,
      )
      .run(JSON.stringify(personaId));
    // The chat's persona is now always recorded; JSON null (no persona) becomes the empty
    // string the column uses for "sent with no persona".
    const stamped = database
      .query<{ chat_id: string }, []>(
        `UPDATE messages
            SET persona_id = COALESCE(
                  (SELECT json_extract(c.metadata, '$.persona') FROM chats c WHERE c.id = messages.chat_id),
                  '')
          WHERE is_user = 1 AND persona_id IS NULL
            AND chat_id IN (SELECT id FROM chats WHERE kind = 'direct')
          RETURNING chat_id`,
      )
      .all();
    const chatIds = [...new Set(stamped.map((row) => row.chat_id))];
    const bump = database.query(
      'UPDATE chats SET revision = revision + 1, save_token = NULL WHERE id = ?',
    );
    for (const id of chatIds) bump.run(id);
  })();
  return settingsChanged;
}

/** Each stored connection's own model, which 2.3 kept on the connection. */
type ConnectionModels = Map<string, string>;

function connectionModels(stored: Record<string, unknown> | null): ConnectionModels {
  const models: ConnectionModels = new Map();
  const list = stored?.connections;
  if (!Array.isArray(list)) return models;
  for (const entry of list) {
    if (isRecord(entry) && typeof entry.id === 'string') {
      models.set(entry.id, typeof entry.model === 'string' ? entry.model : '');
    }
  }
  return models;
}

function ref(connectionId: unknown, modelId: unknown): ModelRef | null {
  if (typeof connectionId !== 'string' || !connectionId) return null;
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  return { connectionId, modelId: modelId.trim() };
}

/** A pair on a connection: its own model when given, else the connection's. */
function pairRef(connectionId: unknown, model: unknown, models: ConnectionModels) {
  const own = typeof model === 'string' ? model.trim() : '';
  return ref(connectionId, own || models.get(connectionId as string));
}

/**
 * A Co-Creator session's (or its side chat's) overrides: `connectionId` plus an optional
 * `modelOverride` become one `model`. A null or absent connection meant "follow the app",
 * which is what an absent `model` means now. Null when there is nothing to convert.
 */
export function convertSessionSettings(
  settings: Record<string, unknown>,
  models: ConnectionModels,
): Record<string, unknown> | null {
  if (!('connectionId' in settings) && !('modelOverride' in settings)) return null;
  const { connectionId, modelOverride, ...rest } = settings;
  const override = isRecord(modelOverride)
    ? ref(modelOverride.connectionId, modelOverride.model)
    : null;
  const model = override ?? pairRef(connectionId, '', models);
  return model ? { ...rest, model } : rest;
}

function convertDocumentModel(
  value: unknown,
  models: ConnectionModels,
): Record<string, unknown> | unknown {
  if (!isRecord(value) || !('connectionId' in value)) return value;
  const { connectionId, model, ...rest } = value;
  return { ...rest, model: pairRef(connectionId, model, models) };
}

/** A Preset Co-Creator document: the assistant, the tester, and each test's frozen copy. */
export function convertPresetDocument(
  document: Record<string, unknown>,
  models: ConnectionModels,
): Record<string, unknown> | null {
  const before = JSON.stringify(document);
  const settings = isRecord(document.settings)
    ? {
        ...document.settings,
        assistant: convertDocumentModel(document.settings.assistant, models),
        testing: convertDocumentModel(document.settings.testing, models),
      }
    : document.settings;
  const tests = Array.isArray(document.tests)
    ? document.tests.map((test) =>
        isRecord(test)
          ? { ...test, testingSettings: convertDocumentModel(test.testingSettings, models) }
          : test,
      )
    : document.tests;
  const next = { ...document, settings, tests };
  return JSON.stringify(next) === before ? null : next;
}

/**
 * settings.json's model choices as slots. Pure. Each slot gets the ref its feature ran on
 * under 2.3: the selected connection's model for chat; the named connection's model for the
 * summary and Co-Creator (no connection meant "follow chat", which an empty slot still
 * means); Nexus's own pair; the side chat's override when it matched its connection.
 */
export function convertSettingsModels(stored: Record<string, unknown>): Record<string, unknown> {
  const models = connectionModels(stored);
  const ids = [...models.keys()];
  const chatId =
    typeof stored.connectionId === 'string' && models.has(stored.connectionId)
      ? stored.connectionId
      : ids[0];
  const summary = isRecord(stored.summary) ? stored.summary : {};
  const nexus = isRecord(stored.nexus) ? stored.nexus : {};
  const coCreator = isRecord(stored.coCreator) ? stored.coCreator : {};
  const side = isRecord(coCreator.sideChat) ? coCreator.sideChat : {};
  const sideOverride = isRecord(side.modelOverride) ? side.modelOverride : null;

  const slots = {
    chat: pairRef(chatId, '', models),
    summary: pairRef(summary.connectionId, '', models),
    nexus: ref(nexus.connectionId, nexus.model),
    cocreator: pairRef(coCreator.connectionId, '', models),
    sideChat:
      sideOverride && sideOverride.connectionId === side.connectionId
        ? ref(side.connectionId, sideOverride.model)
        : pairRef(side.connectionId, '', models),
  };

  const { connectionId: _chat, ...summaryRest } = summary;
  const { connectionId: _nexus, model: _nexusModel, ...nexusRest } = nexus;
  const { connectionId: _side, modelOverride: _override, ...sideRest } = side;
  const { connectionId: _cocreator, ...coCreatorRest } = coCreator;
  const { connectionId: _selected, ...rest } = stored;

  const arena = isRecord(stored.arena) ? stored.arena : null;
  const recent: ModelRef[] = [];
  for (const slot of Object.values(slots)) {
    if (
      slot &&
      !recent.some((r) => r.connectionId === slot.connectionId && r.modelId === slot.modelId)
    ) {
      recent.push(slot);
    }
  }

  return {
    ...rest,
    ...(Array.isArray(stored.connections)
      ? {
          connections: stored.connections.map((entry) => {
            if (!isRecord(entry)) return entry;
            const { model: _model, ...connection } = entry;
            return connection;
          }),
        }
      : {}),
    models: slots,
    recentModels: recent,
    ...(isRecord(stored.summary) ? { summary: summaryRest } : {}),
    ...(isRecord(stored.nexus) ? { nexus: nexusRest } : {}),
    ...(isRecord(stored.coCreator)
      ? {
          coCreator: {
            ...coCreatorRest,
            ...(isRecord(coCreator.sideChat) ? { sideChat: sideRest } : {}),
          },
        }
      : {}),
    ...(arena && Array.isArray(arena.contenders)
      ? {
          arena: {
            ...arena,
            contenders: arena.contenders.map((entry) => {
              if (!isRecord(entry) || !('connectionId' in entry)) return entry;
              const { connectionId, model, ...contender } = entry;
              return { ...contender, model: pairRef(connectionId, model, models) };
            }),
          },
        }
      : {}),
  };
}

/**
 * Step 2. Rows first, settings.json second: the rows need each connection's old model to
 * say what they meant, and settings.json is where that model lives until this step drops
 * it. A rerun finds the rows already converted (they no longer carry the old keys) and
 * settings.json already holding `models`, so it changes nothing twice.
 */
function convertModels(database: Database): boolean {
  const stored = readStoredSettings();
  const models = connectionModels(stored);

  database.transaction(() => {
    const sessions = database
      .query<{ id: string; settings: string; side_chat: string | null }, []>(
        'SELECT id, settings, side_chat FROM cocreator_sessions',
      )
      .all();
    const updateSession = database.query(
      `UPDATE cocreator_sessions
          SET settings = ?, side_chat = ?, revision = revision + 1
        WHERE id = ?`,
    );
    for (const row of sessions) {
      const settings = parseObject(row.settings);
      const side = parseObject(row.side_chat);
      const sideSettings = isRecord(side?.settings) ? side.settings : null;
      const nextSettings = settings ? convertSessionSettings(settings, models) : null;
      const nextSide = sideSettings ? convertSessionSettings(sideSettings, models) : null;
      if (!nextSettings && !nextSide) continue;
      updateSession.run(
        JSON.stringify(nextSettings ?? settings ?? {}),
        nextSide ? JSON.stringify({ ...side, settings: nextSide }) : row.side_chat,
        row.id,
      );
    }

    const documents = database
      .query<{ id: string; document: string }, []>(
        'SELECT id, document FROM preset_cocreator_sessions',
      )
      .all();
    const updateDocument = database.query(
      `UPDATE preset_cocreator_sessions
          SET document = ?, document_revision = document_revision + 1
        WHERE id = ?`,
    );
    for (const row of documents) {
      const document = parseObject(row.document);
      const next = document ? convertPresetDocument(document, models) : null;
      if (next) updateDocument.run(JSON.stringify(next), row.id);
    }
  })();

  if (!stored || 'models' in stored) return false;
  writeStoredSettings(convertSettingsModels(stored));
  return true;
}

/** In order. Append only: a library records how many of these it has run. */
function convertWorkingCards(database: Database): boolean {
  const columns = new Set(
    database
      .query<{ name: string }, []>('PRAGMA table_info(cocreator_sessions)')
      .all()
      .map((c) => c.name),
  );
  for (const [name, declaration] of [
    ['baseline', 'TEXT'],
    ['target_avatar', 'TEXT'],
    ['portrait_changed', 'INTEGER NOT NULL DEFAULT 0'],
    ['publication_id', 'TEXT'],
  ]) {
    if (!columns.has(name!))
      database.exec(`ALTER TABLE cocreator_sessions ADD COLUMN ${name} ${declaration}`);
  }
  const rows = database
    .query<
      {
        id: string;
        seed_avatar: string | null;
        finished_avatar: string | null;
        avatar: string | null;
      },
      []
    >(
      'SELECT id, seed_avatar, finished_avatar, avatar FROM cocreator_sessions WHERE baseline IS NULL AND (seed_avatar IS NOT NULL OR finished_avatar IS NOT NULL)',
    )
    .all();
  const update = database.query(
    'UPDATE cocreator_sessions SET baseline = ?, target_avatar = ?, avatar = ?, portrait_changed = ?, revision = revision + 1 WHERE id = ? AND baseline IS NULL',
  );
  for (const row of rows) {
    const target = row.finished_avatar ?? row.seed_avatar!;
    const record = getCharacterRecord(target);
    const baseline = {
      card: record?.detail.card ?? {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: blankCardData(''),
      },
      portraitVersion: record?.portraitVersion ?? null,
      legacy: true,
    };
    let avatar = row.avatar;
    if (!avatar && record) {
      const bytes = getCharacterImage(target);
      if (bytes) {
        mkdirSync(PATHS.cocreatorAvatars, { recursive: true });
        avatar = `${row.id}.png`;
        atomicWriteSync(join(PATHS.cocreatorAvatars, avatar), bytes);
      }
    }
    update.run(JSON.stringify(baseline), target, avatar, Number(Boolean(row.avatar)), row.id);
  }
  return false;
}

const STEPS: ReadonlyArray<(database: Database) => boolean> = [
  convertChats,
  convertModels,
  convertWorkingCards,
  (database) => {
    database.transaction(() => {
      const columns = database
        .query<{ name: string }, []>('PRAGMA table_info(cocreator_sessions)')
        .all();
      if (columns.some((column) => column.name === 'compaction')) return;
      database.exec(
        "ALTER TABLE cocreator_sessions ADD COLUMN compaction TEXT NOT NULL DEFAULT '{}'",
      );
      database.exec('UPDATE cocreator_sessions SET revision = revision + 1');
    })();
    return false;
  },
];

/**
 * Run whatever steps the open library has not run yet. Returns whether settings.json was
 * rewritten, so the caller can drop a settings cache read before it.
 */
export function upgradeLibrary(database: Database): boolean {
  const row = database
    .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
    .get(MARKER);
  const done = Number(row?.value ?? 0);
  let settingsChanged = false;
  for (let step = Number.isSafeInteger(done) ? done : 0; step < STEPS.length; step += 1) {
    settingsChanged = STEPS[step]!(database) || settingsChanged;
    database
      .query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(MARKER, String(step + 1));
  }
  return settingsChanged;
}
