import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PROMPT_ORDER_LEGACY_ID, PROMPT_ORDER_LIVE_ID } from '../types/preset.ts';
import {
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
});
