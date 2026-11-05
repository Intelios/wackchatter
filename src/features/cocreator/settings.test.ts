import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODEL_SLOTS, type ModelSlots } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { PresetSummary } from '@shared/types/preset.ts';
import { DEFAULT_COCREATOR } from '@shared/types/settings.ts';
import { resolveCocreatorSettings } from './settings.ts';

const connections: Connection[] = [
  { id: 'active', name: 'Active', provider: 'custom', baseUrl: 'http://active/v1' },
  { id: 'design', name: 'Design', provider: 'openrouter', baseUrl: 'http://design/v1' },
];
const presets: PresetSummary[] = [
  { id: 'chat', name: 'Chat', modified: 1 },
  { id: 'design-preset', name: 'Design', modified: 1 },
];
const chat = { connectionId: 'active', modelId: 'chat-model' };
const design = { connectionId: 'design', modelId: 'design-model' };

function resolve(
  session: Parameters<typeof resolveCocreatorSettings>[0]['session'],
  models: ModelSlots = { ...DEFAULT_MODEL_SLOTS, chat, cocreator: design },
  streaming = true,
) {
  return resolveCocreatorSettings({
    session,
    defaults: {
      ...DEFAULT_COCREATOR,
      presetId: 'design-preset',
      systemPrompt: 'Default system.',
      analysisPrompt: 'Default analysis.',
      streaming,
    },
    connections,
    models,
    presets,
    activePresetId: 'chat',
  });
}

describe('resolving Co-Creator settings', () => {
  test('an empty session follows the Co-Creator defaults', () => {
    const result = resolve({});
    expect(result.connection).toMatchObject({ id: 'design', model: 'design-model' });
    expect(result.presetId).toBe('design-preset');
    expect(result.systemPrompt).toBe('Default system.');
    expect(result.analysisPrompt).toBe('Default analysis.');
    expect(result.streaming).toBe(true);
  });

  test('an unset Co-Creator slot follows the chat model', () => {
    const result = resolve({}, { ...DEFAULT_MODEL_SLOTS, chat });
    expect(result.connection).toMatchObject({ id: 'active', model: 'chat-model' });
  });

  test('a session’s own model wins, pair and all', () => {
    const own = { connectionId: 'active', modelId: 'session-model' };
    expect(resolve({ model: own }).connection).toMatchObject({
      id: 'active',
      model: 'session-model',
    });
  });

  test('a session model on a deleted connection blocks rather than switching model', () => {
    const result = resolve({ model: { connectionId: 'deleted', modelId: 'm' } });
    expect(result.connection).toBeNull();
    expect(!result.model.ok && result.model.reason).toContain('was deleted');
  });

  test('explicit null follows the active preset; a missing one falls back to the default', () => {
    expect(resolve({ presetId: null }).presetId).toBe('chat');
    expect(resolve({ presetId: 'deleted' }).presetId).toBe('design-preset');
  });

  test('streaming follows the Co-Creator defaults even when toggled off', () => {
    expect(resolve({}, undefined, false).streaming).toBe(false);
  });
});
