/** Durable Preset Co-Creator sessions, immutable draft revisions, and publication records. */

import type { Database } from 'bun:sqlite';
import {
  applyPresetPatch,
  diffPreset,
  validatePresetDraft,
} from '../../shared/preset-cocreator/patch.ts';
import type { Preset } from '../../shared/types/preset.ts';
import type {
  PatchPresetDraftRequest,
  PresetCocreatorDocument,
  PresetCocreatorModelSettings,
  PresetCocreatorSession,
  PresetCocreatorSessionSummary,
  PresetDraftRevision,
  PresetTestSource,
  PublishPresetDraftResult,
  ReplacePresetDraftRequest,
  RestorePresetDraftRequest,
  SavePresetCocreatorDocument,
} from '../../shared/types/preset-cocreator.ts';
import { getDb } from './db.ts';

interface SessionRow {
  id: string;
  title: string;
  created: number;
  modified: number;
  document_revision: number;
  document: string;
  source_preset_id: string | null;
  target_preset_id: string | null;
  target_preset_version: string | null;
  draft_revision: number;
}

interface RevisionRow {
  session_id: string;
  revision: number;
  created: number;
  source: PresetDraftRevision['source'];
  summary: string;
  turn_id: string | null;
  operation_id: string;
  preset: string;
  diff: string;
  restored_from: number | null;
}

interface PublicationRow {
  revision: number;
  preset_id: string;
  preset_version: string;
  created_file: number;
}

interface PublicationAttemptRow {
  revision: number;
  preset_id: string;
}

export type PresetCocreatorSaveResult<T> =
  | { kind: 'saved'; value: T }
  | { kind: 'stale'; currentRevision: number }
  | { kind: 'notFound' };

export type PresetDraftSaveResult =
  | { kind: 'saved'; revision: PresetDraftRevision }
  | { kind: 'stale'; currentRevision: number }
  | { kind: 'notFound' };

const DEFAULT_MODEL_SETTINGS: PresetCocreatorModelSettings = {
  connectionId: null,
  model: '',
  maxTokens: 4096,
  temperature: 0.2,
  reasoningEffort: 'medium',
};

export function defaultPresetCocreatorDocument(
  input?: Partial<PresetCocreatorDocument['settings']>,
): PresetCocreatorDocument {
  const document: PresetCocreatorDocument = {
    settings: {
      assistant: { ...DEFAULT_MODEL_SETTINGS },
      testing: { ...DEFAULT_MODEL_SETTINGS, maxTokens: 1024, reasoningEffort: 'auto' },
      assistantInstructions: '',
    },
    messages: [],
    tests: [],
    activeTestId: null,
    proposedTests: [],
    batchQueue: {
      items: [],
      note: '',
      includeTranscript: true,
      includePrompt: true,
      includeDiagnostics: true,
    },
  };
  if (input?.assistant) {
    document.settings.assistant = normalizeModelSettings(
      input.assistant,
      document.settings.assistant,
    );
  }
  if (input?.testing) {
    document.settings.testing = normalizeModelSettings(input.testing, document.settings.testing);
  }
  if (typeof input?.assistantInstructions === 'string') {
    document.settings.assistantInstructions = input.assistantInstructions;
  }
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeModelSettings(
  value: unknown,
  fallback: PresetCocreatorModelSettings,
): PresetCocreatorModelSettings {
  const record = isRecord(value) ? value : {};
  const effort = ['auto', 'min', 'low', 'medium', 'high', 'max'].includes(
    String(record.reasoningEffort),
  )
    ? (record.reasoningEffort as PresetCocreatorModelSettings['reasoningEffort'])
    : fallback.reasoningEffort;
  return {
    connectionId: typeof record.connectionId === 'string' ? record.connectionId : null,
    model: typeof record.model === 'string' ? record.model : fallback.model,
    maxTokens:
      typeof record.maxTokens === 'number' &&
      Number.isSafeInteger(record.maxTokens) &&
      record.maxTokens > 0 &&
      record.maxTokens <= 131072
        ? record.maxTokens
        : fallback.maxTokens,
    temperature:
      typeof record.temperature === 'number' &&
      Number.isFinite(record.temperature) &&
      record.temperature >= 0 &&
      record.temperature <= 2
        ? record.temperature
        : fallback.temperature,
    reasoningEffort: effort,
  };
}

function normalizeTestSource(value: unknown): PresetTestSource {
  if (!isRecord(value)) return { kind: 'draft' };
  if (
    value.kind === 'revision' &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0
  ) {
    return { kind: 'revision', revision: Number(value.revision) };
  }
  if (
    (value.kind === 'library' || value.kind === 'reference') &&
    typeof value.id === 'string' &&
    value.id
  ) {
    return { kind: value.kind, id: value.id };
  }
  return { kind: 'draft' };
}

/** Repair only the outer session shape; immutable reports/tests remain byte-for-byte JSON. */
export function normalizePresetCocreatorDocument(value: unknown): PresetCocreatorDocument {
  const defaults = defaultPresetCocreatorDocument();
  if (!isRecord(value)) return defaults;
  const settings = isRecord(value.settings) ? value.settings : {};
  const normalizedSettings = {
    assistant: normalizeModelSettings(settings.assistant, defaults.settings.assistant),
    testing: normalizeModelSettings(settings.testing, defaults.settings.testing),
    assistantInstructions:
      typeof settings.assistantInstructions === 'string' ? settings.assistantInstructions : '',
  };
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(
        (message) =>
          isRecord(message) &&
          typeof message.id === 'string' &&
          ['user', 'assistant', 'tool', 'report'].includes(String(message.role)) &&
          typeof message.content === 'string',
      )
    : [];
  const tests = Array.isArray(value.tests)
    ? value.tests
        .filter(
          (test) => isRecord(test) && typeof test.id === 'string' && Array.isArray(test.messages),
        )
        .map((test) => ({
          ...structuredClone(test),
          presetSource: normalizeTestSource(test.presetSource),
          testingSettings: normalizeModelSettings(test.testingSettings, normalizedSettings.testing),
          composerDraft: typeof test.composerDraft === 'string' ? test.composerDraft : '',
        }))
    : [];
  const proposedTests = Array.isArray(value.proposedTests)
    ? value.proposedTests.filter(
        (test) => isRecord(test) && typeof test.id === 'string' && typeof test.message === 'string',
      )
    : [];
  const active = typeof value.activeTestId === 'string' ? value.activeTestId : null;
  const queue = isRecord(value.batchQueue) ? value.batchQueue : {};
  const queuedItems = Array.isArray(queue.items)
    ? queue.items.filter(
        (item) => isRecord(item) && typeof item.id === 'string' && typeof item.testId === 'string',
      )
    : [];
  return {
    settings: normalizedSettings,
    messages: structuredClone(messages) as PresetCocreatorDocument['messages'],
    tests: tests as PresetCocreatorDocument['tests'],
    activeTestId: active && tests.some((test) => test.id === active) ? active : null,
    proposedTests: structuredClone(proposedTests) as PresetCocreatorDocument['proposedTests'],
    batchQueue: {
      items: structuredClone(queuedItems) as PresetCocreatorDocument['batchQueue']['items'],
      note: typeof queue.note === 'string' ? queue.note : '',
      includeTranscript:
        typeof queue.includeTranscript === 'boolean' ? queue.includeTranscript : true,
      includePrompt: typeof queue.includePrompt === 'boolean' ? queue.includePrompt : true,
      includeDiagnostics:
        typeof queue.includeDiagnostics === 'boolean' ? queue.includeDiagnostics : true,
    },
  };
}

function revisionFromRow(row: RevisionRow): PresetDraftRevision {
  const revision: PresetDraftRevision = {
    revision: row.revision,
    created: row.created,
    source: row.source,
    summary: row.summary,
    turnId: row.turn_id,
    operationId: row.operation_id,
    preset: parseJson(row.preset, {}) as Preset,
    diff: parseJson(row.diff, []) as PresetDraftRevision['diff'],
  };
  if (row.restored_from !== null) revision.restoredFrom = row.restored_from;
  return revision;
}

function summaryFrom(
  row: SessionRow,
  document: PresetCocreatorDocument,
): PresetCocreatorSessionSummary {
  const lastMessage = document.messages.at(-1)?.content ?? '';
  return {
    id: row.id,
    title: row.title,
    created: row.created,
    modified: row.modified,
    sourcePresetId: row.source_preset_id,
    targetPresetId: row.target_preset_id,
    draftRevision: row.draft_revision,
    testCount: document.tests.length,
    lastMessage,
  };
}

export interface PresetCocreatorStore {
  listSessions(): PresetCocreatorSessionSummary[];
  getSession(id: string): PresetCocreatorSession | null;
  createSession(input: {
    presetId: string | null;
    presetVersion: string | null;
    preset: Preset;
    title?: string;
    settings?: Partial<PresetCocreatorDocument['settings']>;
  }): PresetCocreatorSession;
  saveDocument(
    id: string,
    input: SavePresetCocreatorDocument,
  ): PresetCocreatorSaveResult<PresetCocreatorSession>;
  patchDraft(id: string, input: PatchPresetDraftRequest): PresetDraftSaveResult;
  replaceDraft(id: string, input: ReplacePresetDraftRequest): PresetDraftSaveResult;
  restoreDraft(id: string, input: RestorePresetDraftRequest): PresetDraftSaveResult;
  deleteSession(id: string): boolean;
  renameSession(id: string, title: string): PresetCocreatorSession | null;
  reassignPreset(oldId: string, newId: string | null): number;
  getPublication(id: string, operationId: string): PublishPresetDraftResult | null;
  beginPublication(
    id: string,
    operationId: string,
    revision: number,
    presetId: string,
  ): { repeated: boolean } | null;
  cancelPublication(id: string, operationId: string): void;
  recordPublication(
    id: string,
    input: PublishPresetDraftResult & { operationId: string },
  ): PublishPresetDraftResult | null;
}

export function createPresetCocreatorStore(database: Database): PresetCocreatorStore {
  const selectSession = database.query<SessionRow, [string]>(
    'SELECT * FROM preset_cocreator_sessions WHERE id = ?',
  );
  const selectSessions = database.query<SessionRow, []>(
    'SELECT * FROM preset_cocreator_sessions ORDER BY modified DESC, created DESC',
  );
  const selectRevisions = database.query<RevisionRow, [string]>(
    'SELECT * FROM preset_cocreator_revisions WHERE session_id = ? ORDER BY revision ASC',
  );
  const selectRevision = database.query<RevisionRow, [string, number]>(
    'SELECT * FROM preset_cocreator_revisions WHERE session_id = ? AND revision = ?',
  );
  const selectRevisionOperation = database.query<RevisionRow, [string, string]>(
    'SELECT * FROM preset_cocreator_revisions WHERE session_id = ? AND operation_id = ?',
  );
  const selectDocumentOperation = database.query<{ revision: number }, [string, string]>(
    'SELECT revision FROM preset_cocreator_document_operations WHERE session_id = ? AND operation_id = ?',
  );

  function getSession(id: string): PresetCocreatorSession | null {
    const row = selectSession.get(id);
    if (!row) return null;
    const document = normalizePresetCocreatorDocument(parseJson(row.document, {}));
    const history = selectRevisions.all(id).map(revisionFromRow);
    const current = history.find((revision) => revision.revision === row.draft_revision);
    if (!current) throw new Error(`Preset Co-Creator session "${id}" has no current draft.`);
    return {
      ...summaryFrom(row, document),
      documentRevision: row.document_revision,
      targetPresetVersion: row.target_preset_version,
      document,
      current,
      history,
    };
  }

  function insertRevision(sessionId: string, revision: PresetDraftRevision): PresetDraftRevision {
    database
      .query(
        `INSERT INTO preset_cocreator_revisions
          (session_id, revision, created, source, summary, turn_id, operation_id, preset, diff, restored_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        revision.revision,
        revision.created,
        revision.source,
        revision.summary,
        revision.turnId,
        revision.operationId,
        JSON.stringify(revision.preset),
        JSON.stringify(revision.diff),
        revision.restoredFrom ?? null,
      );
    database
      .query('UPDATE preset_cocreator_sessions SET draft_revision = ?, modified = ? WHERE id = ?')
      .run(revision.revision, revision.created, sessionId);
    return revision;
  }

  function mutateDraft(
    id: string,
    expectedRevision: number,
    operationId: string,
    build: (
      current: PresetDraftRevision,
    ) => Omit<PresetDraftRevision, 'revision' | 'created' | 'operationId'>,
  ): PresetDraftSaveResult {
    return database.transaction(() => {
      const repeated = selectRevisionOperation.get(id, operationId);
      if (repeated) return { kind: 'saved' as const, revision: revisionFromRow(repeated) };
      const row = selectSession.get(id);
      if (!row) return { kind: 'notFound' as const };
      if (row.draft_revision !== expectedRevision) {
        return { kind: 'stale' as const, currentRevision: row.draft_revision };
      }
      const currentRow = selectRevision.get(id, row.draft_revision);
      if (!currentRow) throw new Error('The current preset draft is missing.');
      const current = revisionFromRow(currentRow);
      const next = build(current);
      const revision: PresetDraftRevision = {
        ...next,
        revision: current.revision + 1,
        created: Date.now(),
        operationId,
      };
      insertRevision(id, revision);
      return { kind: 'saved' as const, revision };
    })();
  }

  return {
    listSessions() {
      return selectSessions
        .all()
        .map((row) =>
          summaryFrom(row, normalizePresetCocreatorDocument(parseJson(row.document, {}))),
        );
    },

    getSession,

    renameSession(id, title) {
      const clean = title.trim();
      if (!clean) throw new Error('A session name is required.');
      database
        .query('UPDATE preset_cocreator_sessions SET title = ?, modified = ? WHERE id = ?')
        .run(clean, Date.now(), id);
      return getSession(id);
    },

    createSession(input) {
      const id = crypto.randomUUID();
      const now = Date.now();
      const preset = validatePresetDraft(input.preset);
      const document = defaultPresetCocreatorDocument(input.settings);
      database.transaction(() => {
        database
          .query(
            `INSERT INTO preset_cocreator_sessions
              (id, title, created, modified, document_revision, document, source_preset_id,
               target_preset_id, target_preset_version, draft_revision)
             VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`,
          )
          .run(
            id,
            input.title?.trim() || `${input.presetId ?? 'Default preset'} workshop`,
            now,
            now,
            JSON.stringify(document),
            input.presetId,
            input.presetId,
            input.presetVersion,
          );
        insertRevision(id, {
          revision: 0,
          created: now,
          source: 'initial',
          summary: `Started from ${input.presetId ?? 'WackChatter default'}`,
          turnId: null,
          operationId: `initial:${id}`,
          preset,
          diff: [],
        });
      })();
      return getSession(id)!;
    },

    saveDocument(id, input) {
      return database.transaction(() => {
        const repeated = selectDocumentOperation.get(id, input.operationId);
        if (repeated) {
          const session = getSession(id);
          return session
            ? { kind: 'saved' as const, value: session }
            : { kind: 'notFound' as const };
        }
        const row = selectSession.get(id);
        if (!row) return { kind: 'notFound' as const };
        if (row.document_revision !== input.expectedRevision) {
          return { kind: 'stale' as const, currentRevision: row.document_revision };
        }
        const document = normalizePresetCocreatorDocument(input.document);
        const revision = row.document_revision + 1;
        const now = Date.now();
        database
          .query(
            `UPDATE preset_cocreator_sessions
             SET document_revision = ?, document = ?, modified = ? WHERE id = ?`,
          )
          .run(revision, JSON.stringify(document), now, id);
        database
          .query(
            `INSERT INTO preset_cocreator_document_operations
              (session_id, operation_id, revision) VALUES (?, ?, ?)`,
          )
          .run(id, input.operationId, revision);
        return { kind: 'saved' as const, value: getSession(id)! };
      })();
    },

    patchDraft(id, input) {
      return mutateDraft(id, input.expectedRevision, input.operationId, (current) => {
        const applied = applyPresetPatch(current.preset, input.operations);
        return {
          source: input.source,
          summary: input.summary.trim() || 'Updated preset',
          turnId: input.turnId ?? null,
          preset: applied.preset,
          diff: applied.diff,
        };
      });
    },

    replaceDraft(id, input) {
      return mutateDraft(id, input.expectedRevision, input.operationId, (current) => {
        const preset = validatePresetDraft(input.preset, current.preset);
        const diff = diffPreset(current.preset, preset);
        if (diff.length === 0) throw new Error('The manual edit did not change the preset.');
        return {
          source: 'manual',
          summary: input.summary.trim() || 'Edited preset JSON',
          turnId: null,
          preset,
          diff,
        };
      });
    },

    restoreDraft(id, input) {
      return mutateDraft(id, input.expectedRevision, input.operationId, (current) => {
        const targetRow = selectRevision.get(id, input.revision);
        if (!targetRow) throw new Error(`Preset revision ${input.revision} does not exist.`);
        const target = revisionFromRow(targetRow);
        const preset = validatePresetDraft(target.preset, current.preset);
        const diff = diffPreset(current.preset, preset);
        if (diff.length === 0) throw new Error('That revision is already the current draft.');
        return {
          source: 'restore',
          summary: input.summary?.trim() || `Restored revision ${input.revision}`,
          turnId: null,
          preset,
          diff,
          restoredFrom: input.revision,
        };
      });
    },

    deleteSession(id) {
      return (
        database.query('DELETE FROM preset_cocreator_sessions WHERE id = ?').run(id).changes > 0
      );
    },

    reassignPreset(oldId, newId) {
      return database
        .query(
          `UPDATE preset_cocreator_sessions
           SET source_preset_id = CASE WHEN source_preset_id = ? THEN ? ELSE source_preset_id END,
               target_preset_id = CASE WHEN target_preset_id = ? THEN ? ELSE target_preset_id END
           WHERE source_preset_id = ? OR target_preset_id = ?`,
        )
        .run(oldId, newId, oldId, newId, oldId, oldId).changes;
    },

    getPublication(id, operationId) {
      const row = database
        .query<PublicationRow, [string, string]>(
          `SELECT revision, preset_id, preset_version, created_file
           FROM preset_cocreator_publications WHERE session_id = ? AND operation_id = ?`,
        )
        .get(id, operationId);
      return row
        ? {
            presetId: row.preset_id,
            version: row.preset_version,
            revision: row.revision,
            created: Boolean(row.created_file),
          }
        : null;
    },

    beginPublication(id, operationId, revision, presetId) {
      return database.transaction(() => {
        if (!selectSession.get(id)) return null;
        const previous = database
          .query<PublicationAttemptRow, [string, string]>(
            `SELECT revision, preset_id FROM preset_cocreator_publication_attempts
             WHERE session_id = ? AND operation_id = ?`,
          )
          .get(id, operationId);
        if (previous) {
          if (previous.revision !== revision || previous.preset_id !== presetId) {
            throw new Error('A publication operation id cannot be reused for another target.');
          }
          return { repeated: true };
        }
        database
          .query(
            `INSERT INTO preset_cocreator_publication_attempts
              (session_id, operation_id, created, revision, preset_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, operationId, Date.now(), revision, presetId);
        return { repeated: false };
      })();
    },

    cancelPublication(id, operationId) {
      database
        .query(
          'DELETE FROM preset_cocreator_publication_attempts WHERE session_id = ? AND operation_id = ?',
        )
        .run(id, operationId);
    },

    recordPublication(id, input) {
      return database.transaction(() => {
        const session = selectSession.get(id);
        if (!session) return null;
        const repeated = database
          .query<PublicationRow, [string, string]>(
            `SELECT revision, preset_id, preset_version, created_file
             FROM preset_cocreator_publications WHERE session_id = ? AND operation_id = ?`,
          )
          .get(id, input.operationId);
        if (repeated) {
          return {
            presetId: repeated.preset_id,
            version: repeated.preset_version,
            revision: repeated.revision,
            created: Boolean(repeated.created_file),
          };
        }
        database
          .query(
            `INSERT INTO preset_cocreator_publications
              (session_id, operation_id, created, revision, preset_id, preset_version, created_file)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.operationId,
            Date.now(),
            input.revision,
            input.presetId,
            input.version,
            input.created ? 1 : 0,
          );
        database
          .query(
            'DELETE FROM preset_cocreator_publication_attempts WHERE session_id = ? AND operation_id = ?',
          )
          .run(id, input.operationId);
        database
          .query(
            `UPDATE preset_cocreator_sessions
             SET target_preset_id = ?, target_preset_version = ?, modified = ? WHERE id = ?`,
          )
          .run(input.presetId, input.version, Date.now(), id);
        return {
          presetId: input.presetId,
          version: input.version,
          revision: input.revision,
          created: input.created,
        };
      })();
    },
  };
}

let instance: PresetCocreatorStore | null = null;

export function presetCocreatorStore(): PresetCocreatorStore {
  if (!instance) instance = createPresetCocreatorStore(getDb());
  return instance;
}

export function resetPresetCocreatorStore(): void {
  instance = null;
}
