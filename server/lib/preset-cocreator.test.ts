import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { blankCardData } from '../../shared/card/blank.ts';
import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import type { PresetCocreatorDocument } from '../../shared/types/preset-cocreator.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import { createSchema } from './db.ts';
import {
  createPresetCocreatorStore,
  defaultPresetCocreatorDocument,
  normalizePresetCocreatorDocument,
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
  test('older test chats gain per-chat defaults and an empty saved batch', () => {
    const legacy = defaultPresetCocreatorDocument() as unknown as Record<string, unknown>;
    delete legacy.batchQueue;
    legacy.tests = [{ id: 'old-test', title: 'Old test', messages: [], evidence: [] }];
    legacy.activeTestId = 'old-test';

    const document = normalizePresetCocreatorDocument(legacy);
    expect(document.tests[0]?.presetSource).toEqual({ kind: 'draft' });
    expect(document.tests[0]?.testingSettings).toEqual(document.settings.testing);
    expect(document.tests[0]?.composerDraft).toBe('');
    expect(document.batchQueue).toEqual({
      items: [],
      note: '',
      includeTranscript: true,
      includePrompt: true,
      includeDiagnostics: true,
    });
  });

  test('per-chat choices, unsent text and frozen batch reports survive a document save', () => {
    const session = create();
    const testChat: PresetCocreatorDocument['tests'][number] = {
      id: 'chat-1',
      title: 'Comparison chat',
      created: 1,
      modified: 1,
      scenario: {
        characterId: null,
        character: blankCardData('Assistant'),
        greetingIndex: 0,
        persona: null,
        worldInfoSources: [],
        worldInfoSettings: DEFAULT_WI_SETTINGS,
        regexScripts: [],
        variables: { local: {}, global: {} },
      },
      presetSource: { kind: 'reference', id: 'Example' },
      testingSettings: {
        ...session.document.settings.testing,
        connectionId: 'connection-1',
        model: 'model-one',
      },
      composerDraft: 'Unsent question',
      localVariables: {},
      globalVariables: {},
      messages: [],
      evidence: [],
    };
    const document: PresetCocreatorDocument = {
      ...session.document,
      tests: [testChat],
      activeTestId: testChat.id,
      batchQueue: {
        ...session.document.batchQueue,
        note: 'Compare the results',
        includePrompt: false,
        items: [
          {
            id: 'report-1',
            created: 2,
            testId: testChat.id,
            testTitle: testChat.title,
            throughMessageId: 'reply-1',
            replyText: 'Frozen reply',
            note: 'Look at the tone',
            includeTranscript: true,
            includePrompt: true,
            includeDiagnostics: true,
            presetUsed: {
              source: testChat.presetSource,
              label: 'Example',
              version: 'content-version',
            },
          },
        ],
      },
    };
    const saved = store.saveDocument(session.id, {
      expectedRevision: 0,
      operationId: 'save-test-chats',
      document,
    });

    expect(saved.kind).toBe('saved');
    const loaded = store.getSession(session.id)!.document;
    expect(loaded.tests[0]?.presetSource).toEqual({ kind: 'reference', id: 'Example' });
    expect(loaded.tests[0]?.testingSettings.model).toBe('model-one');
    expect(loaded.tests[0]?.composerDraft).toBe('Unsent question');
    expect(loaded.batchQueue.note).toBe('Compare the results');
    expect(loaded.batchQueue.includePrompt).toBe(false);
    expect(loaded.batchQueue.items[0]?.replyText).toBe('Frozen reply');
    expect(loaded.batchQueue.items[0]?.presetUsed?.version).toBe('content-version');
  });

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

  test('comparison snapshots survive document save and later draft changes', () => {
    const session = create();
    const frozenDraft = structuredClone(session.current.preset);
    const frozenOther = structuredClone(session.current.preset);
    frozenOther.temperature = 0.35;
    const saved = store.saveDocument(session.id, {
      expectedRevision: 0,
      operationId: 'comparison-save',
      document: {
        ...session.document,
        messages: [
          {
            id: 'comparison',
            role: 'user',
            content: 'Style',
            created: 1,
            comparison: {
              draft: { label: 'Mine', revision: 0, preset: frozenDraft },
              other: {
                label: 'Old',
                source: { kind: 'revision', revision: 0 },
                preset: frozenOther,
              },
              focus: 'Style',
            },
          },
        ],
      },
    });
    expect(saved.kind).toBe('saved');
    store.patchDraft(session.id, {
      expectedRevision: 0,
      operationId: 'later-edit',
      source: 'manual',
      summary: 'Later',
      operations: [{ op: 'replace', path: '/temperature', value: 1.8 }],
    });
    const reloaded = store.getSession(session.id);
    expect(reloaded?.document.messages[0]?.comparison?.draft.preset.temperature).toBe(1);
    expect(reloaded?.document.messages[0]?.comparison?.other.preset.temperature).toBe(0.35);
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
