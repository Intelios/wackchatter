import { describe, expect, test } from 'bun:test';
import { emptyCoCreatorReasoningEfforts } from '@shared/models/reasoning.ts';
import { DEFAULT_MODEL_SLOTS } from '@shared/models/slots.ts';
import { DEFAULT_SETTINGS } from '@shared/types/settings.ts';
import { appSettingsView, resolveAppModels } from './settingsView.ts';

const settings = (patch: Partial<typeof DEFAULT_SETTINGS> = {}) => ({
  ...DEFAULT_SETTINGS,
  connections: [{ id: 'c', name: 'C', provider: 'custom' as const, baseUrl: 'http://c/v1' }],
  ...patch,
});

describe('resolveAppModels', () => {
  test('before settings load, nothing runs and nothing is blocked yet', () => {
    const models = resolveAppModels(null);
    expect(models.slots).toEqual(DEFAULT_MODEL_SLOTS);
    expect(models.chat).toEqual({ model: null, blockedReason: null });
  });

  test('summary follows chat; Nexus runs without reasoning text', () => {
    const chat = { connectionId: 'c', modelId: 'chat-model' };
    const nexus = { connectionId: 'c', modelId: 'memory-model' };
    const models = resolveAppModels(settings({ models: { ...DEFAULT_MODEL_SLOTS, chat, nexus } }));
    expect(models.chat.model?.model).toBe('chat-model');
    expect(models.summary.model?.model).toBe('chat-model');
    expect(models.nexus.model).toMatchObject({ model: 'memory-model', showReasoning: false });
  });

  test('an unpicked slot says why it cannot run', () => {
    const models = resolveAppModels(settings());
    expect(models.chat).toEqual({ model: null, blockedReason: 'Choose a chat model.' });
    expect(models.nexus.blockedReason).toBe('Choose a Nexus model.');
  });
});

describe('appSettingsView', () => {
  test('fills every default before settings load', () => {
    const view = appSettingsView(null);
    expect(view.memoryMode).toBe('classic');
    expect(view.characterListSort).toBe('name');
    expect(view.backdrop).toEqual({
      url: null,
      blur: 8,
      dim: 0.55,
      effect: null,
      effectLayer: 'behind',
    });
    expect(view.regexScripts).toEqual([]);
    expect(view.chatReasoningEfforts).toEqual({});
    expect(view.coCreatorReasoningEfforts).toEqual(emptyCoCreatorReasoningEfforts());
  });

  test('chat and Co-Creator reasoning preferences keep their identity and never alter model resolution', () => {
    const chatReasoningEfforts = { c: { 'chat-model': 'low' as const } };
    const coCreatorReasoningEfforts = {
      ...emptyCoCreatorReasoningEfforts(),
      character: { c: { 'chat-model': 'high' as const } },
    };
    const stored = settings({
      chatReasoningEfforts,
      coCreatorReasoningEfforts,
      models: {
        ...DEFAULT_MODEL_SLOTS,
        chat: { connectionId: 'c', modelId: 'chat-model' },
      },
    });
    expect(appSettingsView(stored).chatReasoningEfforts).toBe(chatReasoningEfforts);
    expect(appSettingsView(stored).coCreatorReasoningEfforts).toBe(coCreatorReasoningEfforts);
    expect(resolveAppModels(stored).chat.model).not.toHaveProperty('reasoning_effort');
    expect(resolveAppModels(stored).summary.model).not.toHaveProperty('reasoning_effort');
  });

  test('only enabled regex scripts leave, and junk list entries are dropped', () => {
    const view = appSettingsView(
      settings({
        regexScripts: [
          { id: 'on', scriptName: 'On', findRegex: 'a', disabled: false },
          { id: 'off', scriptName: 'Off', findRegex: 'b', disabled: true },
        ] as never,
        hiddenTags: ['nsfw', 3 as never],
        globalLorebooks: ['World'],
      }),
    );
    expect(view.regexScripts.map((s) => s.id)).toEqual(['on']);
    expect(view.hiddenTags).toEqual(['nsfw']);
    expect(view.globalBookIds).toEqual(['World']);
  });
});
