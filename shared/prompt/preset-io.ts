/**
 * Preset normalisation: reading a SillyTavern preset into a shape we can rely on,
 * and writing one back that SillyTavern will read without complaint.
 *
 * Read side is permissive (migrate renames, fill defaults, never reject on unknown keys).
 * Write side preserves everything we didn't touch — SillyTavern itself discards unknown
 * keys on save, but that loses provider settings a user configured in ST, so we don't.
 */

import type { Preset, Prompt, PromptOrderEntry, PromptOrderList } from '../types/preset.ts';
import { PROMPT_ORDER_LIVE_ID } from '../types/preset.ts';
import { DEFAULT_PROMPTS, DEFAULT_PROMPT_ORDER, PRESET_DEFAULTS } from './defaults.ts';

/**
 * Field renames applied on load, mirroring SillyTavern's migrateChatCompletionSettings.
 * `match` narrows the rule to a specific old value; omit it to migrate any value.
 */
interface MigrationRule {
  from: string;
  to: string;
  match?: unknown | RegExp;
  value?: unknown;
}

const MIGRATIONS: MigrationRule[] = [
  { from: 'names_in_completion', to: 'names_behavior', match: true, value: 1 },
  {
    from: 'chat_completion_source',
    to: 'chat_completion_source',
    match: 'palm',
    value: 'makersuite',
  },
  {
    from: 'custom_prompt_post_processing',
    to: 'custom_prompt_post_processing',
    match: 'claude',
    value: 'merge',
  },
  { from: 'image_inlining', to: 'media_inlining', match: false, value: false },
  { from: 'image_inlining', to: 'media_inlining', match: true, value: true },
  { from: 'video_inlining', to: 'media_inlining', match: true, value: true },
  { from: 'audio_inlining', to: 'media_inlining', match: true, value: true },
  { from: 'claude_use_sysprompt', to: 'use_sysprompt', match: true, value: true },
  { from: 'use_makersuite_sysprompt', to: 'use_sysprompt', match: true, value: true },
  { from: 'openrouter_sort_models', to: 'sort_models' },
  { from: 'openrouter_group_models', to: 'group_models', match: true, value: true },
  { from: 'ai21_model', to: 'ai21_model', match: /^j2-/, value: 'jamba-large' },
];

/**
 * Apply the rename table. Old keys are removed whether or not their value matched.
 *
 * Note on a deliberate divergence: SillyTavern's own loop deletes the old key as soon as
 * it processes the first rule mentioning it, so any later rule for that same key never
 * runs (openai.js:4199-4210). That silently drops `image_inlining: true` and every
 * `openrouter_sort_models` value except 'alphabetically'. We evaluate all rules for a key
 * before removing it, which produces the intended result. This cannot hurt compatibility —
 * we write the modern key either way, and ST ignores the legacy one.
 */
export function migratePreset(raw: Record<string, unknown>): Record<string, unknown> {
  const preset = { ...raw };
  const consumed = new Set<string>();

  for (const rule of MIGRATIONS) {
    if (!Object.hasOwn(preset, rule.from)) continue;

    const current = preset[rule.from];
    const matches =
      rule.match === undefined
        ? true
        : rule.match instanceof RegExp
          ? typeof current === 'string' && rule.match.test(current)
          : current === rule.match;

    if (matches) {
      preset[rule.to] = rule.value !== undefined ? rule.value : current;
    }
    if (rule.from !== rule.to) consumed.add(rule.from);
  }

  for (const key of consumed) delete preset[key];
  return preset;
}

/**
 * Ensure every built-in prompt exists. SillyTavern re-injects missing built-ins on load,
 * so a preset without them would change the moment it was opened there.
 */
function withMissingPrompts(prompts: Prompt[]): Prompt[] {
  const seen = new Set(prompts.map((p) => p.identifier));
  const missing = DEFAULT_PROMPTS.filter((p) => !seen.has(p.identifier));
  return missing.length ? [...prompts, ...structuredClone(missing)] : prompts;
}

/**
 * Repair the prompt order: seed it if absent, drop entries with no matching prompt, and
 * append any prompt that has no order entry (otherwise a newly added prompt is invisible).
 */
function normalizeOrder(orders: PromptOrderList[], prompts: Prompt[]): PromptOrderList[] {
  const known = new Set(prompts.map((p) => p.identifier));
  const result = orders.length ? [...orders] : [];

  let liveIndex = result.findIndex((o) => Number(o.character_id) === PROMPT_ORDER_LIVE_ID);
  if (liveIndex === -1) {
    result.push({
      character_id: PROMPT_ORDER_LIVE_ID,
      order: structuredClone(DEFAULT_PROMPT_ORDER),
    });
    liveIndex = result.length - 1;
  }

  const live = result[liveIndex]!;
  const kept = live.order.filter((entry) => known.has(entry.identifier));
  const listed = new Set(kept.map((e) => e.identifier));

  const appended: PromptOrderEntry[] = prompts
    .filter((p) => !listed.has(p.identifier))
    .map((p) => ({ identifier: p.identifier, enabled: true }));

  result[liveIndex] = { ...live, order: [...kept, ...appended] };
  return result;
}

/** Read an arbitrary preset JSON into a usable Preset. Never throws on unknown fields. */
export function normalizePreset(raw: unknown): Preset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Preset must be a JSON object.');
  }

  const migrated = migratePreset(raw as Record<string, unknown>);

  const prompts = withMissingPrompts(
    Array.isArray(migrated.prompts)
      ? (migrated.prompts as Prompt[])
      : structuredClone(DEFAULT_PROMPTS),
  );

  const promptOrder = normalizeOrder(
    Array.isArray(migrated.prompt_order) ? (migrated.prompt_order as PromptOrderList[]) : [],
    prompts,
  );

  return {
    ...PRESET_DEFAULTS,
    ...migrated,
    prompts,
    prompt_order: promptOrder,
  };
}

/**
 * Serialise a preset the way SillyTavern writes them: 4-space indent, no trailing newline.
 * The byte format matters — users diff these files and share them.
 */
export function serializePreset(preset: Preset): string {
  return JSON.stringify(preset, null, 4);
}

// --- Accessors -------------------------------------------------------------

/** The live prompt order (character_id 100001), creating it if somehow absent. */
export function getPromptOrder(preset: Preset): PromptOrderEntry[] {
  const list = preset.prompt_order?.find((o) => Number(o.character_id) === PROMPT_ORDER_LIVE_ID);
  return list?.order ?? [];
}

/**
 * Replace the live prompt order, leaving any legacy 100000 entry untouched.
 * Returns a new preset — callers treat presets as immutable.
 */
export function setPromptOrder(preset: Preset, order: PromptOrderEntry[]): Preset {
  const existing = preset.prompt_order ?? [];
  const index = existing.findIndex((o) => Number(o.character_id) === PROMPT_ORDER_LIVE_ID);

  const next = [...existing];
  if (index === -1) {
    next.push({ character_id: PROMPT_ORDER_LIVE_ID, order });
  } else {
    next[index] = { ...next[index]!, order };
  }

  return { ...preset, prompt_order: next };
}

export function getPromptById(preset: Preset, identifier: string): Prompt | undefined {
  return preset.prompts?.find((p) => p.identifier === identifier);
}

/** Replace one prompt by identifier, returning a new preset. */
export function updatePrompt(preset: Preset, identifier: string, changes: Partial<Prompt>): Preset {
  const prompts = (preset.prompts ?? []).map((p) =>
    p.identifier === identifier ? { ...p, ...changes } : p,
  );
  return { ...preset, prompts };
}
