import { describe, expect, test } from 'bun:test';
import type { Connection } from '@shared/providers/types.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import { DEFAULT_COCREATOR } from '@shared/types/settings.ts';
import { connectionPatch, modelPatch, resolveCocreatorSettings } from './settings.ts';

const connections: Connection[] = [
  { id: 'active', name: 'Active', provider: 'custom', baseUrl: 'http://active/v1', model: 'a' },
  { id: 'design', name: 'Design', provider: 'openrouter', baseUrl: 'http://design/v1', model: 'b' },
];
const presets: PresetSummary[] = [
  { id: 'chat', name: 'Chat', modified: 1 },
  { id: 'design-preset', name: 'Design', modified: 1 },
];

function resolve(session: Parameters<typeof resolveCocreatorSettings>[0]['session']) {
  return resolveCocreatorSettings({
    session,
    defaults: {
      ...DEFAULT_COCREATOR,
      connectionId: 'design',
      presetId: 'design-preset',
      systemPrompt: 'Default system.',
      analysisPrompt: 'Default analysis.',
    },
    connections,
    activeConnectionId: 'active',
    presets,
    activePresetId: 'chat',
  });
}

describe('resolving Co-Creator settings', () => {
  test('an empty session follows the Co-Creator defaults', () => {
    const result = resolve({});
    expect(result.connection?.id).toBe('design');
    expect(result.presetId).toBe('design-preset');
    expect(result.systemPrompt).toBe('Default system.');
    expect(result.analysisPrompt).toBe('Default analysis.');
  });

  test('explicit null follows the active app selections', () => {
    const result = resolve({ connectionId: null, presetId: null });
    expect(result.connection?.id).toBe('active');
    expect(result.presetId).toBe('chat');
  });

  test('missing saved selections fall back through the defaults', () => {
    const result = resolve({ connectionId: 'deleted', presetId: 'deleted' });
    expect(result.connection?.id).toBe('design');
    expect(result.presetId).toBe('design-preset');
  });

  test('a model override applies only to the connection it names', () => {
    expect(
      resolve({ modelOverride: { connectionId: 'design', model: 'session-model' } }).connection
        ?.model,
    ).toBe('session-model');
    expect(
      resolve({
        connectionId: null,
        modelOverride: { connectionId: 'design', model: 'session-model' },
      }).connection?.model,
    ).toBe('a');
  });
});

describe('session patches', () => {
  test('switching connection clears a bound model override', () => {
    expect(
      connectionPatch('active', {
        modelOverride: { connectionId: 'design', model: 'session-model' },
      }),
    ).toEqual({ connectionId: 'active', modelOverride: undefined });
  });

  test('the saved connection model is represented by inheritance', () => {
    expect(modelPatch(connections[1]!, 'b')).toEqual({ modelOverride: undefined });
    expect(modelPatch(connections[1]!, 'other')).toEqual({
      modelOverride: { connectionId: 'design', model: 'other' },
    });
  });
});
