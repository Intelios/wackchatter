import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '../../shared/providers/types.ts';
import type { AppSettings } from '../../shared/types/settings.ts';
import {
  DEFAULT_CONNECTION_ID,
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_SETTINGS,
} from '../../shared/types/settings.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import { DEFAULT_DATA_DIR, PATHS, setDataDir } from './paths.ts';
import { getApiKey } from './secrets.ts';
import {
  applyConnectionPatch,
  dropConnection,
  getSettings,
  MIGRATION_CONNECTION_ID,
  mergeSettings,
  migrateLegacyConnection,
  nextConnectionName,
  reassignCharacterDialogueColor,
  reassignGlobalLorebooks,
  removePersonaDialogueColor,
  resetSettingsCache,
  sameEndpoint,
} from './settings.ts';

function connection(id: string, name: string, overrides?: Partial<Connection>): Connection {
  return {
    id,
    name,
    provider: 'custom',
    baseUrl: `http://${id}`,
    model: '',
    showReasoning: true,
    ...overrides,
  };
}

function base(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

describe('mergeSettings', () => {
  test('a partial worldInfo patch keeps every untouched field', () => {
    // The bug a shallow spread would cause: changing the scan depth in the UI silently
    // resets the budget, recursion and both match settings.
    const next = mergeSettings(base(), { worldInfo: { depth: 7 } as never });

    expect(next.worldInfo.depth).toBe(7);
    expect(next.worldInfo.budget).toBe(DEFAULT_WI_SETTINGS.budget);
    expect(next.worldInfo.recursive).toBe(DEFAULT_WI_SETTINGS.recursive);
    expect(next.worldInfo.matchWholeWords).toBe(DEFAULT_WI_SETTINGS.matchWholeWords);
  });

  test('false is a real value, not an absence', () => {
    const next = mergeSettings(base(), { worldInfo: { recursive: false } as never });
    expect(next.worldInfo.recursive).toBe(false);
  });

  test('zero is a real value, so a cap can be cleared', () => {
    const capped = mergeSettings(base(), { worldInfo: { budgetCap: 500 } as never });
    expect(
      mergeSettings(capped, { worldInfo: { budgetCap: 0 } as never }).worldInfo.budgetCap,
    ).toBe(0);
  });

  test('a wrong-typed field falls back to its default rather than poisoning the file', () => {
    const next = mergeSettings(base(), { worldInfo: { depth: 'lots' } as never });
    expect(next.worldInfo.depth).toBe(DEFAULT_WI_SETTINGS.depth);
  });

  test('omitting worldInfo leaves it untouched', () => {
    const current = mergeSettings(base(), { worldInfo: { depth: 9 } as never });
    expect(mergeSettings(current, { streamingFps: 15 }).worldInfo.depth).toBe(9);
  });

  test('a connections patch is ignored — the list mutates only per-connection', () => {
    // The wholesale array was how a stale tab (or a body like `{"connections": null}`)
    // could delete every connection, and the key pruning that follows a deletion made
    // that irreversible. Pinning the list is what the per-connection endpoints rely on.
    const current = base();
    for (const patch of [
      { connections: [] },
      { connections: null },
      { connections: [{ id: 'intruder', name: 'X' }] },
    ]) {
      const next = mergeSettings(current, patch as never);
      expect(next.connections).toEqual(current.connections);
    }
  });

  test('an unknown connectionId falls back to the first connection', () => {
    const next = mergeSettings(base(), { connectionId: 'missing' });
    expect(next.connectionId).toBe(DEFAULT_CONNECTION_ID);
  });

  test('a known connectionId is kept and revalidated against the pinned list', () => {
    const next = mergeSettings(base(), { connectionId: DEFAULT_CONNECTION_ID });
    expect(next.connectionId).toBe(DEFAULT_CONNECTION_ID);
  });

  test('unknown keys survive, so a newer build cannot be downgraded into data loss', () => {
    const current = { ...base(), futureKey: 'kept' };
    expect(mergeSettings(current, { streamingFps: 60 }).futureKey).toBe('kept');
  });

  test('personaId can be set and cleared', () => {
    const set = mergeSettings(base(), { personaId: 'abc' });
    expect(set.personaId).toBe('abc');
    expect(mergeSettings(set, { personaId: null }).personaId).toBeNull();
  });

  test('global variables replace atomically and discard unsupported values', () => {
    const current = mergeSettings(base(), { variables: { kept: 1, removed: 'old' } });
    const next = mergeSettings(current, {
      variables: { text: 'yes', number: 3, bad: { nested: true } } as never,
    });

    expect(next.variables).toEqual({ text: 'yes', number: 3 });
  });

  test('an empty global-variable map clears all globals', () => {
    const current = mergeSettings(base(), { variables: { score: 10 } });
    expect(mergeSettings(current, { variables: {} }).variables).toEqual({});
  });

  test('a partial guidance patch keeps every untouched field', () => {
    const next = mergeSettings(base(), { guidance: { template: 'Do: {{input}}' } as never });

    expect(next.guidance.template).toBe('Do: {{input}}');
    expect(next.guidance.role).toBe(DEFAULT_GUIDANCE.role);
    expect(next.guidance.guideDepth).toBe(DEFAULT_GUIDANCE.guideDepth);
    expect(next.guidance.guideRole).toBe(DEFAULT_GUIDANCE.guideRole);
  });

  test('guidance depth zero survives, because zero is where guidance belongs', () => {
    // The default already is 0, so set it away and back — a truthiness guard would pass
    // the first assertion and fail this one.
    const moved = mergeSettings(base(), { guidance: { depth: 4 } as never });
    expect(moved.guidance.depth).toBe(4);
    expect(mergeSettings(moved, { guidance: { depth: 0 } as never }).guidance.depth).toBe(0);
  });

  test('an unknown injection role falls back rather than reaching the provider', () => {
    // Roles are a union, so a typeof check would wave any string through and the request
    // would 400 at the provider with nothing pointing back here.
    const next = mergeSettings(base(), { guidance: { role: 'narrator' } as never });
    expect(next.guidance.role).toBe(DEFAULT_GUIDANCE.role);
  });

  test('omitting guidance leaves it untouched', () => {
    const current = mergeSettings(base(), { guidance: { guideDepth: 3 } as never });
    expect(mergeSettings(current, { streamingFps: 15 }).guidance.guideDepth).toBe(3);
  });

  test('dialogue colours default on and a partial patch keeps both override maps', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { 'Alice.png': '#AABBCC' },
        personas: { jack: null },
      },
    });
    const next = mergeSettings(current, { dialogueColors: { enabled: false } as never });

    expect(next.dialogueColors.enabled).toBeFalse();
    expect(next.dialogueColors.characters).toEqual({ 'Alice.png': '#aabbcc' });
    expect(next.dialogueColors.personas).toEqual({ jack: null });
  });

  test('dialogue colour maps replace independently and discard malformed values', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        ...DEFAULT_DIALOGUE_COLORS,
        characters: { kept: '#123456' },
        personas: { old: '#abcdef' },
      },
    });
    const next = mergeSettings(current, {
      dialogueColors: {
        characters: { good: '#ABCDEF', off: null, bad: 'red' },
      } as never,
    });

    expect(next.dialogueColors.characters).toEqual({ good: '#abcdef', off: null });
    expect(next.dialogueColors.personas).toEqual({ old: '#abcdef' });
  });
});

describe('dialogue colour identity changes', () => {
  test('a character rename re-keys its override without disturbing the rest', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { 'Old.png': '#123456', 'Other.png': null },
        personas: {},
      },
    });
    const next = reassignCharacterDialogueColor(current, 'Old.png', 'New.png');

    expect(next?.dialogueColors.characters).toEqual({
      'New.png': '#123456',
      'Other.png': null,
    });
    expect(reassignCharacterDialogueColor(current, 'Missing.png', 'New.png')).toBeNull();
  });

  test('deleting a character or persona removes only its override', () => {
    const current = mergeSettings(base(), {
      dialogueColors: {
        enabled: true,
        characters: { doomed: null, kept: '#123456' },
        personas: { doomed: '#abcdef', kept: null },
      },
    });

    expect(
      reassignCharacterDialogueColor(current, 'doomed', null)?.dialogueColors.characters,
    ).toEqual({
      kept: '#123456',
    });
    expect(removePersonaDialogueColor(current, 'doomed')?.dialogueColors.personas).toEqual({
      kept: null,
    });
  });
});

describe('applyConnectionPatch', () => {
  function list(): Connection[] {
    return [connection('a', 'Local'), connection('b', 'OpenRouter')];
  }

  test('merges into one entry, normalising per field', () => {
    const next = applyConnectionPatch(list(), 'b', { model: 'x/y', showReasoning: false });
    expect(next?.[1]).toMatchObject({ id: 'b', model: 'x/y', showReasoning: false });
    expect(next?.[0]).toEqual(list()[0]);
  });

  test('a bad provider falls back rather than reaching the wire', () => {
    const next = applyConnectionPatch(list(), 'a', { provider: 'nope' });
    expect(next?.[0]?.provider).toBe('custom');
  });

  test('clearing the baseUrl falls back to the provider default', () => {
    const next = applyConnectionPatch(list(), 'a', { baseUrl: '   ' });
    expect(next?.[0]?.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('reportUsage can be switched off', () => {
    const on = applyConnectionPatch(list(), 'a', { reportUsage: true });
    expect(on?.[0]?.reportUsage).toBe(true);
    const off = applyConnectionPatch(on!, 'a', { reportUsage: false });
    expect(off?.[0]?.reportUsage).toBeUndefined();
  });

  test('the id cannot be patched away — it keys the secret store', () => {
    const next = applyConnectionPatch(list(), 'a', { id: 'evil' });
    expect(next?.[0]?.id).toBe('a');
  });

  test('an unknown id changes nothing', () => {
    expect(applyConnectionPatch(list(), 'zzz', { model: 'x' })).toBeNull();
  });

  test('edits do not mutate the input', () => {
    const original = list();
    const snapshot = structuredClone(original);
    applyConnectionPatch(original, 'a', { name: 'changed' });
    expect(original).toEqual(snapshot);
  });
});

describe('dropConnection', () => {
  function list(): Connection[] {
    return [connection('a', 'A'), connection('b', 'B'), connection('c', 'C')];
  }

  test('dropping the selected entry falls back to the first remaining', () => {
    const next = dropConnection(list(), 'b', 'b');
    expect(next?.connections.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(next?.connectionId).toBe('a');
  });

  test('a selection pointing elsewhere survives the deletion', () => {
    expect(dropConnection(list(), 'c', 'a')?.connectionId).toBe('c');
  });

  test('dropping the only connection clears the selection', () => {
    const next = dropConnection([connection('a', 'Solo')], 'a', 'a');
    expect(next?.connections).toEqual([]);
    expect(next?.connectionId).toBeNull();
  });

  test('an unknown id changes nothing', () => {
    expect(dropConnection(list(), 'a', 'zzz')).toBeNull();
  });
});

describe('nextConnectionName', () => {
  test('the first connection takes the bare provider label', () => {
    expect(nextConnectionName([], 'custom')).toBe('OpenAI-compatible');
  });

  test('fills the lowest free slot rather than counting entries', () => {
    const connections = [
      connection('a', 'OpenAI-compatible'),
      connection('c', 'OpenAI-compatible 3'),
    ];
    expect(nextConnectionName(connections, 'custom')).toBe('OpenAI-compatible 2');
  });

  test('a user-chosen name never blocks a slot', () => {
    expect(nextConnectionName([connection('a', 'Groq')], 'custom')).toBe('OpenAI-compatible');
  });
});

describe('sameEndpoint', () => {
  test('same provider and base URL is the same endpoint', () => {
    expect(sameEndpoint(connection('a', 'A'), connection('b', 'B', { baseUrl: 'http://a' }))).toBe(
      true,
    );
  });

  test('trailing slashes and surrounding whitespace are not a move', () => {
    expect(
      sameEndpoint(connection('a', 'A', { baseUrl: 'http://a' }), {
        provider: 'custom',
        baseUrl: '  http://a/  ',
      }),
    ).toBe(true);
  });

  test('a different URL or provider is a different endpoint', () => {
    expect(
      sameEndpoint(connection('a', 'A'), connection('a', 'A', { baseUrl: 'http://elsewhere' })),
    ).toBe(false);
    expect(
      sameEndpoint(connection('a', 'A'), connection('a', 'A', { provider: 'openrouter' })),
    ).toBe(false);
  });
});

describe('migrateLegacyConnection', () => {
  function legacy() {
    return {
      connection: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude',
        showReasoning: false,
        reportUsage: true,
      },
      streamingFps: 30,
    };
  }

  test('wraps the legacy connection in a one-entry list and reports the key move', () => {
    const migration = migrateLegacyConnection(legacy(), 'new-id');
    expect(migration).not.toBeNull();
    if (!migration) return;

    const connections = migration.settings.connections as Connection[];
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: 'new-id',
      // No name existed in the old format; the provider label is the fallback.
      name: 'OpenRouter',
      provider: 'openrouter',
      model: 'anthropic/claude',
      showReasoning: false,
      reportUsage: true,
    });
    expect(migration.settings.connectionId).toBe('new-id');
    expect(migration.settings.connection).toBeUndefined();
    // Unrelated keys ride along untouched.
    expect(migration.settings.streamingFps).toBe(30);
    expect(migration.keyMove).toEqual({ from: 'openrouter', to: 'new-id' });
  });

  test('a file that already has connections is left alone', () => {
    expect(migrateLegacyConnection({ connections: [] }, 'new-id')).toBeNull();
  });

  test('a file without a legacy connection is left alone', () => {
    expect(migrateLegacyConnection({ streamingFps: 30 }, 'new-id')).toBeNull();
  });
});

/*
 * !! paths.ts and the settings cache are module state shared by every test file in the
 * process. !! These tests repoint both at a temp directory; the afterEach puts them
 * back, same rule as paths.test.ts.
 */
describe('legacy migration on disk', () => {
  afterEach(() => {
    setDataDir(DEFAULT_DATA_DIR);
    resetSettingsCache();
  });

  function seedLegacy(dir: string, secrets: Record<string, string>) {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        connection: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'anthropic/claude',
        },
        streamingFps: 30,
      }),
    );
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
  }

  test('migrates on first read, and the key moves with the connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      seedLegacy(dir, { openrouter: 'sk-or-1234', custom: 'sk-leftover' });

      const settings = getSettings();
      expect(settings.connections.map((connection) => connection.id)).toEqual([
        MIGRATION_CONNECTION_ID,
      ]);
      expect(settings.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(settings.streamingFps).toBe(30);

      expect(getApiKey(MIGRATION_CONNECTION_ID)).toBe('sk-or-1234');
      expect(getApiKey('openrouter')).toBeNull();
      // A key for a provider with no connection has nowhere to move and is left alone.
      expect(getApiKey('custom')).toBe('sk-leftover');

      // The file on disk caught up, so the migration never runs again.
      const stored = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
      expect(stored.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(stored.connection).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a crash between the re-key and the settings write converges on retry', () => {
    // The deterministic id is what makes this safe: the retry computes the same id, so
    // the key the first attempt already moved is exactly where the second looks. With a
    // fresh uuid per attempt, the key would sit under the first attempt's id while
    // settings pointed at the second's, and the next prune would delete it.
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    try {
      setDataDir(dir);
      resetSettingsCache();
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          connection: {
            provider: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'x',
          },
        }),
      );
      // Secrets already re-keyed by the interrupted first attempt.
      writeFileSync(
        join(dir, 'secrets.json'),
        JSON.stringify({ [MIGRATION_CONNECTION_ID]: 'sk-or-1234' }),
        { mode: 0o600 },
      );

      const settings = getSettings();
      expect(settings.connections[0]?.id).toBe(MIGRATION_CONNECTION_ID);
      expect(getApiKey(MIGRATION_CONNECTION_ID)).toBe('sk-or-1234');

      const stored = JSON.parse(readFileSync(PATHS.settings, 'utf8'));
      expect(stored.connectionId).toBe(MIGRATION_CONNECTION_ID);
      expect(stored.connection).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reassignGlobalLorebooks', () => {
  function withGlobals(ids: string[]): AppSettings {
    return { ...base(), globalLorebooks: ids };
  }

  test('a rename repoints the selection, keeping order and the rest', () => {
    const next = reassignGlobalLorebooks(withGlobals(['a', 'old', 'b']), 'old', 'new');
    expect(next?.globalLorebooks).toEqual(['a', 'new', 'b']);
  });

  test('a delete drops the entry', () => {
    const next = reassignGlobalLorebooks(withGlobals(['a', 'old', 'b']), 'old', null);
    expect(next?.globalLorebooks).toEqual(['a', 'b']);
  });

  test('nothing referencing the old id means nothing to persist', () => {
    expect(reassignGlobalLorebooks(withGlobals(['a', 'b']), 'old', 'new')).toBeNull();
  });

  test('an absent or malformed selection is left alone', () => {
    expect(reassignGlobalLorebooks(base(), 'old', 'new')).toBeNull();
    expect(
      reassignGlobalLorebooks({ ...base(), globalLorebooks: 'nope' }, 'old', 'new'),
    ).toBeNull();
  });
});
