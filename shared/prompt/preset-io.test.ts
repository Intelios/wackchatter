import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PROMPT_ORDER_LEGACY_ID, PROMPT_ORDER_LIVE_ID } from '../types/preset.ts';
import {
  addCustomPrompt,
  deleteCustomPrompt,
  getPromptOrder,
  migratePreset,
  normalizePreset,
  serializePreset,
  setPromptOrder,
  updatePrompt,
} from './preset-io.ts';

/** SillyTavern's own shipped chat-completion preset. */
const ST_DEFAULT_PRESET =
  '/Users/jack/Documents/GitHub/SillyTavernSource/default/content/presets/openai/Default.json';

function loadStDefault(): unknown {
  return JSON.parse(readFileSync(ST_DEFAULT_PRESET, 'utf8'));
}

describe('SillyTavern default preset', () => {
  test('loads without loss', () => {
    const preset = normalizePreset(loadStDefault());

    expect(preset.prompts).toHaveLength(12);
    expect(preset.temperature).toBe(1);
    expect(preset.openai_max_context).toBe(4095);
    expect(preset.openai_max_tokens).toBe(300);
    expect(preset.stream_openai).toBe(true);
  });

  test('reads the live prompt order from character_id 100001, not 100000', () => {
    const preset = normalizePreset(loadStDefault());
    const order = getPromptOrder(preset);

    // The 100001 order is the one that includes personaDescription; 100000 predates it.
    expect(order.map((e) => e.identifier)).toContain('personaDescription');
    expect(order).toHaveLength(12);
  });

  test('preserves the legacy 100000 entry untouched', () => {
    const preset = normalizePreset(loadStDefault());
    const legacy = preset.prompt_order?.find(
      (o) => Number(o.character_id) === PROMPT_ORDER_LEGACY_ID,
    );

    expect(legacy).toBeDefined();
    // It is the older order and must not be "repaired" into the modern one.
    expect(legacy?.order.map((e) => e.identifier)).not.toContain('personaDescription');
  });

  test('enhanceDefinitions ships disabled', () => {
    const order = getPromptOrder(normalizePreset(loadStDefault()));
    expect(order.find((e) => e.identifier === 'enhanceDefinitions')?.enabled).toBe(false);
  });

  test('marker prompts carry no content', () => {
    const preset = normalizePreset(loadStDefault());
    for (const identifier of ['chatHistory', 'charDescription', 'worldInfoBefore']) {
      const prompt = preset.prompts?.find((p) => p.identifier === identifier);
      expect(prompt?.marker).toBe(true);
      expect(prompt?.content).toBeUndefined();
    }
  });

  test('unknown provider fields survive a load/save round trip', () => {
    const raw = loadStDefault() as Record<string, unknown>;
    const written = JSON.parse(serializePreset(normalizePreset(raw)));

    // Fields for providers we don't implement must not be dropped — a user may be
    // sharing this preset back into SillyTavern.
    expect(written.minimax_model).toBe(raw.minimax_model);
    expect(written.electronhub_model).toBe(raw.electronhub_model);
    expect(written.vertexai_model).toBe(raw.vertexai_model);
    expect(written.assistant_prefill).toBe(raw.assistant_prefill);
  });

  test('the impersonation prompt survives a load/save round trip', () => {
    // The Impersonate action reads this field like any other ST setting, and the user edits
    // it from the Generation panel — so what ST wrote has to come back unchanged.
    const raw = loadStDefault() as Record<string, unknown>;
    const written = JSON.parse(serializePreset(normalizePreset(raw)));

    expect(written.impersonation_prompt).toBe(raw.impersonation_prompt);
    expect(written.impersonation_prompt).toContain('{{user}}');
  });
});

describe('serialization format', () => {
  test('uses 4-space indent and no trailing newline', () => {
    const text = serializePreset(normalizePreset(loadStDefault()));

    expect(text.startsWith('{\n    "')).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
    expect(text.endsWith('}')).toBe(true);
  });
});

describe('migrations', () => {
  test('names_in_completion becomes names_behavior COMPLETION', () => {
    const migrated = migratePreset({ names_in_completion: true });
    expect(migrated.names_behavior).toBe(1);
    expect(migrated).not.toHaveProperty('names_in_completion');
  });

  test('image_inlining becomes media_inlining, both polarities', () => {
    expect(migratePreset({ image_inlining: true }).media_inlining).toBe(true);
    expect(migratePreset({ image_inlining: false }).media_inlining).toBe(false);
  });

  test('claude_use_sysprompt and use_makersuite_sysprompt both become use_sysprompt', () => {
    expect(migratePreset({ claude_use_sysprompt: true }).use_sysprompt).toBe(true);
    expect(migratePreset({ use_makersuite_sysprompt: true }).use_sysprompt).toBe(true);
  });

  test('openrouter_sort_models becomes sort_models, carrying its value', () => {
    const migrated = migratePreset({ openrouter_sort_models: 'pricing.prompt' });
    expect(migrated.sort_models).toBe('pricing.prompt');
    expect(migrated).not.toHaveProperty('openrouter_sort_models');
  });

  test('palm becomes makersuite', () => {
    expect(migratePreset({ chat_completion_source: 'palm' }).chat_completion_source).toBe(
      'makersuite',
    );
  });

  test('legacy ai21 j2 models are replaced', () => {
    expect(migratePreset({ ai21_model: 'j2-ultra' }).ai21_model).toBe('jamba-large');
    // A current model must not be rewritten.
    expect(migratePreset({ ai21_model: 'jamba-mini' }).ai21_model).toBe('jamba-mini');
  });

  test('the old key is removed even when its value did not match', () => {
    const migrated = migratePreset({ claude_use_sysprompt: false });
    expect(migrated).not.toHaveProperty('claude_use_sysprompt');
  });
});

describe('repairing incomplete presets', () => {
  test('missing built-in prompts are restored', () => {
    const preset = normalizePreset({ prompts: [{ identifier: 'main', name: 'Main' }] });
    const identifiers = preset.prompts!.map((p) => p.identifier);

    expect(preset.prompts).toHaveLength(12);
    expect(identifiers).toContain('chatHistory');
    expect(identifiers).toContain('personaDescription');
  });

  test('an empty preset gets the full defaults', () => {
    const preset = normalizePreset({});
    expect(preset.prompts).toHaveLength(12);
    expect(getPromptOrder(preset)).toHaveLength(12);
    expect(preset.prompt_order![0]!.character_id).toBe(PROMPT_ORDER_LIVE_ID);
  });

  test('order entries with no matching prompt are dropped', () => {
    const preset = normalizePreset({
      prompt_order: [
        {
          character_id: PROMPT_ORDER_LIVE_ID,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'ghostPrompt', enabled: true },
          ],
        },
      ],
    });

    expect(getPromptOrder(preset).map((e) => e.identifier)).not.toContain('ghostPrompt');
  });

  test('a prompt with no order entry is appended so it stays visible', () => {
    const preset = normalizePreset({
      prompts: [{ identifier: 'custom', name: 'My Prompt', content: 'hi' }],
      prompt_order: [
        { character_id: PROMPT_ORDER_LIVE_ID, order: [{ identifier: 'main', enabled: true }] },
      ],
    });

    expect(getPromptOrder(preset).map((e) => e.identifier)).toContain('custom');
  });
});

/**
 * The Prompt Manager's export button, as opposed to the preset dropdown's. Same word
 * ("export") in the ST UI, different file, and users import both here.
 */
describe('Prompt Manager export format', () => {
  const promptManagerExport = {
    version: 1,
    type: 'full',
    data: {
      prompts: [
        { identifier: 'custom-a', name: 'Main Prompt V4', role: 'system', content: 'the good bit' },
        { identifier: 'custom-b', name: 'Summary', role: 'system', content: 'summarise' },
      ],
      // Bare order array, not the preset's [{character_id, order}] list.
      prompt_order: [
        { identifier: 'main', enabled: false },
        { identifier: 'custom-a', enabled: true },
        { identifier: 'custom-b', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'deleted-prompt', enabled: false },
      ],
    },
  };

  test('prompts are read from data.prompts, not silently defaulted', () => {
    const preset = normalizePreset(promptManagerExport);
    const main = preset.prompts?.find((p) => p.identifier === 'custom-a');

    expect(main?.name).toBe('Main Prompt V4');
    expect(main?.content).toBe('the good bit');
  });

  test('built-ins the export omits are restored alongside the custom prompts', () => {
    const preset = normalizePreset(promptManagerExport);
    const identifiers = preset.prompts!.map((p) => p.identifier);

    expect(preset.prompts).toHaveLength(14); // 12 built-ins + 2 custom
    expect(identifiers).toContain('main');
    expect(identifiers).toContain('personaDescription');
    expect(identifiers).toContain('custom-a');
  });

  test('the bare order array is lifted onto the live character_id', () => {
    const preset = normalizePreset(promptManagerExport);

    expect(preset.prompt_order).toHaveLength(1);
    expect(preset.prompt_order![0]!.character_id).toBe(PROMPT_ORDER_LIVE_ID);

    const order = getPromptOrder(preset);
    // Author's order is preserved, and the dangling entry is dropped as usual.
    expect(order.slice(0, 4).map((e) => e.identifier)).toEqual([
      'main',
      'custom-a',
      'custom-b',
      'chatHistory',
    ]);
    expect(order.map((e) => e.identifier)).not.toContain('deleted-prompt');
  });

  test('a disabled built-in stays disabled — these presets replace main with their own', () => {
    const order = getPromptOrder(normalizePreset(promptManagerExport));
    expect(order.find((e) => e.identifier === 'main')?.enabled).toBe(false);
    expect(order.find((e) => e.identifier === 'custom-a')?.enabled).toBe(true);
  });

  test('the version/type envelope is not written into the preset', () => {
    const written = JSON.parse(serializePreset(normalizePreset(promptManagerExport)));

    expect(written).not.toHaveProperty('data');
    expect(written).not.toHaveProperty('type');
    expect(written).not.toHaveProperty('version');
  });

  test('a character-scoped export applies as the live order — we keep only one', () => {
    const preset = normalizePreset({ ...promptManagerExport, type: 'character' });
    expect(getPromptOrder(preset).map((e) => e.identifier)).toContain('custom-a');
  });

  test('an export carrying only prompts still loads', () => {
    const preset = normalizePreset({
      version: 1,
      type: 'full',
      data: { prompts: [{ identifier: 'custom-a', name: 'Solo', content: 'x' }] },
    });

    expect(preset.prompts?.find((p) => p.identifier === 'custom-a')?.content).toBe('x');
    // No order came with it, so the prompt is appended rather than lost.
    expect(getPromptOrder(preset).map((e) => e.identifier)).toContain('custom-a');
  });

  test('a plain preset with an unrelated data key is not mistaken for an export', () => {
    const preset = normalizePreset({
      temperature: 0.85,
      data: { something: 'else' },
      prompts: [{ identifier: 'main', name: 'Main', content: 'real main' }],
    });

    expect(preset.temperature).toBe(0.85);
    expect(preset.prompts?.find((p) => p.identifier === 'main')?.content).toBe('real main');
  });

  test('an extension blob holding its own prompts array is not mistaken for an export', () => {
    const preset = normalizePreset({
      data: { prompts: [{ identifier: 'x', name: 'X' }], someExtensionKey: true },
      prompts: [{ identifier: 'main', name: 'Main', content: 'real main' }],
    });

    expect(preset.prompts?.find((p) => p.identifier === 'main')?.content).toBe('real main');
    expect(preset.prompts?.find((p) => p.identifier === 'x')).toBeUndefined();
  });

  /**
   * Presets written before the export format was recognised kept the whole `data` payload
   * alongside a set of default prompts, so the real prompts are still recoverable on read.
   */
  test('a preset mis-imported before the fix recovers its prompts on read', () => {
    const misImported = {
      ...promptManagerExport,
      temperature: 0.7,
      openai_max_context: 200000,
      prompts: [{ identifier: 'main', name: 'Main Prompt', content: 'the stock default' }],
      prompt_order: [
        { character_id: PROMPT_ORDER_LIVE_ID, order: [{ identifier: 'main', enabled: true }] },
      ],
    };

    const preset = normalizePreset(misImported);

    expect(preset.prompts?.find((p) => p.identifier === 'custom-a')?.content).toBe('the good bit');
    expect(getPromptOrder(preset).map((e) => e.identifier)).toContain('custom-a');
    // Settings edited on the broken preset since the bad import must survive the recovery.
    expect(preset.temperature).toBe(0.7);
    expect(preset.openai_max_context).toBe(200000);
  });
});

describe('editing', () => {
  test('setPromptOrder replaces the live order and leaves the legacy one alone', () => {
    const preset = normalizePreset(loadStDefault());
    const reordered = setPromptOrder(preset, [{ identifier: 'main', enabled: false }]);

    expect(getPromptOrder(reordered)).toEqual([{ identifier: 'main', enabled: false }]);

    const legacy = reordered.prompt_order?.find(
      (o) => Number(o.character_id) === PROMPT_ORDER_LEGACY_ID,
    );
    expect(legacy?.order.length).toBeGreaterThan(1);
  });

  test('updatePrompt changes one prompt without touching the rest', () => {
    const preset = normalizePreset(loadStDefault());
    const updated = updatePrompt(preset, 'main', { content: 'New instructions.' });

    expect(updated.prompts?.find((p) => p.identifier === 'main')?.content).toBe(
      'New instructions.',
    );
    expect(updated.prompts?.find((p) => p.identifier === 'nsfw')).toEqual(
      preset.prompts!.find((p) => p.identifier === 'nsfw')!,
    );
  });

  test('editing does not mutate the original preset', () => {
    const preset = normalizePreset(loadStDefault());
    const before = preset.prompts!.find((p) => p.identifier === 'main')!.content;

    updatePrompt(preset, 'main', { content: 'Changed.' });
    expect(preset.prompts!.find((p) => p.identifier === 'main')!.content).toBe(before);
  });

  test('creates an enabled, empty, relative system prompt at the end of the live order', () => {
    const preset = normalizePreset(loadStDefault());
    const created = addCustomPrompt(preset, 'custom-test-id');
    const prompt = created.preset.prompts?.find((item) => item.identifier === created.identifier);

    expect(prompt).toMatchObject({
      identifier: 'custom-test-id',
      role: 'system',
      content: '',
      injection_position: 0,
    });
    expect(getPromptOrder(created.preset).at(-1)).toEqual({
      identifier: 'custom-test-id',
      enabled: true,
    });
    expect(preset.prompts?.some((item) => item.identifier === 'custom-test-id')).toBe(false);
  });

  test('deletes a custom prompt from prompts and every order list', () => {
    const created = addCustomPrompt(normalizePreset(loadStDefault()), 'custom-delete');
    const withExtraOrder = {
      ...created.preset,
      prompt_order: [
        ...(created.preset.prompt_order ?? []),
        {
          character_id: 42,
          order: [{ identifier: 'custom-delete', enabled: false }],
        },
      ],
    };
    const deleted = deleteCustomPrompt(withExtraOrder, 'custom-delete');

    expect(deleted.prompts?.some((prompt) => prompt.identifier === 'custom-delete')).toBe(false);
    expect(
      deleted.prompt_order?.every((list) =>
        list.order.every((entry) => entry.identifier !== 'custom-delete'),
      ),
    ).toBe(true);
  });

  test('built-ins and markers are protected from deletion', () => {
    const preset = normalizePreset(loadStDefault());
    expect(deleteCustomPrompt(preset, 'main')).toBe(preset);
    expect(deleteCustomPrompt(preset, 'chatHistory')).toBe(preset);
  });
});
