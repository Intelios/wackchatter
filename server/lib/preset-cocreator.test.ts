import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import type { PresetCocreatorDocument } from '../../shared/types/preset-cocreator.ts';
import { createSchema } from './db.ts';
import {
  createPresetCocreatorStore,
  defaultPresetCocreatorDocument,
  type PresetCocreatorStore,
} from './preset-cocreator.ts';

let database: Database;
let store: PresetCocreatorStore;

beforeEach(() => {
  database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createSchema(database);
  store = createPresetCocreatorStore(database);
});

function create() {
  return store.createSession({
    presetId: 'Default',
    presetVersion: 'version-1',
    preset: createDefaultPreset(),
  });
}

describe('Preset Co-Creator session store', () => {
  test('creates an immutable initial revision and a separate session document', () => {
    const session = create();

    expect(session.documentRevision).toBe(0);
    expect(session.draftRevision).toBe(0);
    expect(session.current.preset.temperature).toBe(1);
    expect(session.history).toHaveLength(1);
    expect(session.sourcePresetId).toBe('Default');
    expect(session.targetPresetVersion).toBe('version-1');
    expect(session.document).toEqual(defaultPresetCocreatorDocument());
  });

  test('applies a valid JSON patch as a new revision', () => {
    const session = create();
    const result = store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'operation-1',
      source: 'assistant',
      summary: 'Make prose more vivid',
      turnId: 'turn-1',
      operations: [{ op: 'replace', path: '/prompts/0/content', value: 'Write vivid prose.' }],
    });

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.revision.revision).toBe(1);
    expect(result.revision.preset.prompts?.[0]?.content).toBe('Write vivid prose.');
    expect(result.revision.diff).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/prompts/0/content' })]),
    );
    expect(store.getSession(session.id)?.history).toHaveLength(2);
  });

  test('rejects stale patch revisions without changing the draft', () => {
    const session = create();
    store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'one',
      source: 'manual',
      summary: 'First',
      operations: [{ op: 'replace', path: '/temperature', value: 0.5 }],
    });
    const stale = store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'two',
      source: 'assistant',
      summary: 'Stale',
      operations: [{ op: 'replace', path: '/temperature', value: 1.5 }],
    });

    expect(stale).toEqual({ kind: 'stale', currentRevision: 1 });
    expect(store.getSession(session.id)?.current.preset.temperature).toBe(0.5);
  });

  test('repeating an operation id is idempotent', () => {
    const session = create();
    const request = {
      expectedRevision: 0,
      operationId: 'same-operation',
      source: 'assistant' as const,
      summary: 'Once',
      operations: [{ op: 'replace' as const, path: '/temperature', value: 0.6 }],
    };

    const first = store.patchDraft(session.id, request);
    const second = store.patchDraft(session.id, { ...request, expectedRevision: 1 });
    expect(second).toEqual(first);
    expect(store.getSession(session.id)?.history).toHaveLength(2);
  });

  test('manual whole-JSON replacement uses the same validator', () => {
    const session = create();
    const invalid = structuredClone(session.current.preset);
    invalid.prompts = invalid.prompts?.filter((prompt) => prompt.identifier !== 'chatHistory');

    expect(() =>
      store.replaceDraft(session.id, {
        expectedRevision: 0,
        operationId: 'manual-invalid',
        summary: 'Broken',
        preset: invalid,
      }),
    ).toThrow('built-in');
    expect(store.getSession(session.id)?.draftRevision).toBe(0);
  });

  test('restore creates another revision and keeps the audit trail', () => {
    const session = create();
    store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'edit',
      source: 'manual',
      summary: 'Change temperature',
      operations: [{ op: 'replace', path: '/temperature', value: 0.25 }],
    });

    const restored = store.restoreDraft(session.id, {
      expectedRevision: 1,
      operationId: 'restore',
      revision: 0,
    });
    expect(restored.kind).toBe('saved');
    expect(store.getSession(session.id)?.current.preset.temperature).toBe(1);
    expect(store.getSession(session.id)?.history.map((item) => item.revision)).toEqual([0, 1, 2]);
    expect(store.getSession(session.id)?.current.restoredFrom).toBe(0);
  });

  test('the server owns document revisions and stale writes are rejected', () => {
    const session = create();
    const document: PresetCocreatorDocument = {
      ...session.document,
      messages: [{ id: 'm1', role: 'user', content: 'Help me.', created: 1 }],
    };
    const saved = store.saveDocument(session.id, {
      expectedRevision: 0,
      operationId: 'document-1',
      document,
    });
    expect(saved.kind).toBe('saved');
    if (saved.kind === 'saved') expect(saved.value.documentRevision).toBe(1);

    expect(
      store.saveDocument(session.id, {
        expectedRevision: 0,
        operationId: 'document-stale',
        document: session.document,
      }),
    ).toEqual({ kind: 'stale', currentRevision: 1 });
  });

  test('preset rename/delete references never discard the draft', () => {
    const session = create();
    expect(store.reassignPreset('Default', 'Renamed')).toBe(1);
    expect(store.getSession(session.id)).toMatchObject({
      sourcePresetId: 'Renamed',
      targetPresetId: 'Renamed',
    });

    expect(store.reassignPreset('Renamed', null)).toBe(1);
    expect(store.getSession(session.id)).toMatchObject({
      sourcePresetId: null,
      targetPresetId: null,
      draftRevision: 0,
    });
  });

  test('deleting a session cascades immutable revisions and operation records', () => {
    const session = create();
    store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'edit',
      source: 'manual',
      summary: 'Edit',
      operations: [{ op: 'replace', path: '/temperature', value: 0.9 }],
    });
    expect(store.deleteSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeNull();
    expect(
      database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM preset_cocreator_revisions')
        .get()!.count,
    ).toBe(0);
  });
});
