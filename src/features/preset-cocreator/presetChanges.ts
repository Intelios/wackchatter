import { diffPreset, type PresetDiffEntry } from '@shared/preset-cocreator/patch.ts';
import type { Preset, Prompt, PromptOrderEntry, PromptOrderList } from '@shared/types/preset.ts';
import { PROMPT_ORDER_LEGACY_ID, PROMPT_ORDER_LIVE_ID } from '@shared/types/preset.ts';

/**
 * What changed between two preset revisions, in words a person reads.
 *
 * Built from the two presets rather than from the stored diff. The stored diff is keyed by
 * array index, so inserting one prompt shifted every later prompt-order entry and the old
 * view listed each as a replaced identifier — sixteen rows for one insertion. Matching
 * prompts by identifier turns that into one "added" row and one line about the order.
 */
export type PresetChange =
  | { kind: 'text'; key: string; label: string; before: string; after: string }
  | { kind: 'value'; key: string; label: string; before: unknown; after: unknown }
  | { kind: 'prompt'; key: string; label: string; change: 'added' | 'removed'; content: string }
  | { kind: 'order'; key: string; label: string; lines: string[] };

const SETTING_LABELS: Record<string, string> = {
  temperature: 'Temperature',
  top_p: 'Top P',
  top_k: 'Top K',
  top_a: 'Top A',
  min_p: 'Min P',
  frequency_penalty: 'Frequency penalty',
  presence_penalty: 'Presence penalty',
  repetition_penalty: 'Repetition penalty',
  openai_max_tokens: 'Max response tokens',
  openai_max_context: 'Context size',
  reasoning_effort: 'Reasoning effort',
  stream_openai: 'Streaming',
  n: 'Completions',
  seed: 'Seed',
  impersonation_prompt: 'Impersonation prompt',
  new_chat_prompt: 'New chat prompt',
  new_group_chat_prompt: 'New group chat prompt',
  new_example_chat_prompt: 'New example chat prompt',
  continue_nudge_prompt: 'Continue nudge',
  continue_prefill: 'Continue prefill',
  continue_postfix: 'Continue postfix',
  wi_format: 'World Info format',
  scenario_format: 'Scenario format',
  personality_format: 'Personality format',
  assistant_prefill: 'Assistant prefill',
  squash_system_messages: 'Squash system messages',
  names_behavior: 'Character names',
};

const PROMPT_FIELD_LABELS: Record<string, string> = {
  injection_position: 'position',
  injection_depth: 'depth',
  injection_order: 'order',
  injection_trigger: 'triggers',
  system_prompt: 'system prompt',
  forbid_overrides: 'forbid overrides',
};

function humanize(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

export const settingLabel = (key: string) => SETTING_LABELS[key] ?? humanize(key);
const promptFieldLabel = (key: string) => PROMPT_FIELD_LABELS[key] ?? key.replace(/_/g, ' ');

function unionKeys(before: object, after: object): string[] {
  return [...new Set([...Object.keys(after), ...Object.keys(before)])];
}

const unchanged = (before: unknown, after: unknown) => diffPreset(before, after).length === 0;
const isPlain = (value: unknown) => value === null || typeof value !== 'object';

/** A one-line string this short reads better as "high → medium" than as a word diff. */
export const SHORT_TEXT = 80;

function leafChange(key: string, label: string, before: unknown, after: unknown): PresetChange {
  const isText = (value: unknown) => typeof value === 'string' || value === undefined;
  const short = `${before ?? ''}${after ?? ''}`;
  if (
    (typeof before === 'string' || typeof after === 'string') &&
    isText(before) &&
    isText(after) &&
    (short.length > SHORT_TEXT || short.includes('\n'))
  ) {
    return {
      kind: 'text',
      key,
      label,
      before: (before as string | undefined) ?? '',
      after: (after as string | undefined) ?? '',
    };
  }
  return { kind: 'value', key, label, before, after };
}

/**
 * One field's change: a word diff for longer text, a value for anything plain, and for
 * nested objects one row per changed leaf, labelled by the path beneath `label`.
 */
function fieldChanges(key: string, label: string, before: unknown, after: unknown): PresetChange[] {
  if (unchanged(before, after)) return [];
  if (isPlain(before) && isPlain(after)) return [leafChange(key, label, before, after)];
  // diffPreset already recurses to the changed leaves; each becomes its own labelled row.
  return diffPreset(before, after).map((entry) => {
    const sub = entry.path
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    return leafChange(
      `${key}${entry.path}`,
      [label, ...sub].join(' › '),
      entry.before,
      entry.after,
    );
  });
}

function promptsOf(preset: Preset): Prompt[] {
  return Array.isArray(preset.prompts) ? (preset.prompts as Prompt[]) : [];
}

function ordersOf(preset: Preset): PromptOrderList[] {
  return Array.isArray(preset.prompt_order) ? (preset.prompt_order as PromptOrderList[]) : [];
}

const promptKey = (prompt: Prompt, index: number) => prompt.identifier || `#${index}`;
export const promptName = (prompt: Prompt) => prompt.name?.trim() || prompt.identifier;

function promptChanges(before: Preset, after: Preset): PresetChange[] {
  const changes: PresetChange[] = [];
  const beforePrompts = new Map(promptsOf(before).map((p, index) => [promptKey(p, index), p]));
  const afterKeys = new Set<string>();

  promptsOf(after).forEach((prompt, index) => {
    const key = promptKey(prompt, index);
    afterKeys.add(key);
    const old = beforePrompts.get(key);
    const name = promptName(prompt);
    if (!old) {
      changes.push({
        kind: 'prompt',
        key: `prompt:${key}`,
        label: name,
        change: 'added',
        content: prompt.content ?? '',
      });
      return;
    }
    for (const field of unionKeys(old, prompt)) {
      if (field === 'identifier') continue;
      changes.push(
        ...fieldChanges(
          `prompt:${key}/${field}`,
          `${name} › ${promptFieldLabel(field)}`,
          (old as unknown as Record<string, unknown>)[field],
          (prompt as unknown as Record<string, unknown>)[field],
        ),
      );
    }
  });

  for (const [key, prompt] of beforePrompts) {
    if (afterKeys.has(key)) continue;
    changes.push({
      kind: 'prompt',
      key: `prompt:${key}`,
      label: promptName(prompt),
      change: 'removed',
      content: prompt.content ?? '',
    });
  }
  return changes;
}

/** Identifiers kept in the same relative order: the longest common subsequence. */
function steadyIdentifiers(before: readonly string[], after: readonly string[]): Set<string> {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const steady = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      steady.add(before[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return steady;
}

/** The order list's change as sentences: added, removed, moved, enabled, disabled. */
export function describeOrderChange(
  before: readonly PromptOrderEntry[],
  after: readonly PromptOrderEntry[],
  nameOf: (identifier: string) => string,
): string[] {
  const lines: string[] = [];
  const beforeIds = before.map((entry) => entry.identifier);
  const afterIds = after.map((entry) => entry.identifier);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);

  after.forEach((entry, index) => {
    if (!beforeSet.has(entry.identifier)) {
      lines.push(
        `Added ${nameOf(entry.identifier)} at position ${index + 1}${entry.enabled ? '' : ', disabled'}`,
      );
    }
  });
  for (const entry of before) {
    if (!afterSet.has(entry.identifier)) lines.push(`Removed ${nameOf(entry.identifier)}`);
  }
  const steady = steadyIdentifiers(
    beforeIds.filter((id) => afterSet.has(id)),
    afterIds.filter((id) => beforeSet.has(id)),
  );
  afterIds.forEach((id, index) => {
    if (beforeSet.has(id) && !steady.has(id)) {
      lines.push(`Moved ${nameOf(id)} to position ${index + 1}`);
    }
  });
  for (const entry of after) {
    const old = before.find((candidate) => candidate.identifier === entry.identifier);
    if (old && old.enabled !== entry.enabled) {
      lines.push(`${entry.enabled ? 'Enabled' : 'Disabled'} ${nameOf(entry.identifier)}`);
    }
  }
  return lines;
}

function orderLabel(characterId: number): string {
  if (characterId === PROMPT_ORDER_LIVE_ID) return 'Prompt order';
  if (characterId === PROMPT_ORDER_LEGACY_ID) return 'Legacy prompt order';
  return `Prompt order (character ${characterId})`;
}

function orderChanges(before: Preset, after: Preset): PresetChange[] {
  const names = new Map<string, string>();
  for (const prompt of [...promptsOf(before), ...promptsOf(after)]) {
    names.set(prompt.identifier, promptName(prompt));
  }
  const nameOf = (identifier: string) => names.get(identifier) ?? identifier;

  const lists = new Map<number, { before?: PromptOrderList; after?: PromptOrderList }>();
  for (const list of ordersOf(before)) lists.set(list.character_id, { before: list });
  for (const list of ordersOf(after)) {
    lists.set(list.character_id, { ...lists.get(list.character_id), after: list });
  }

  const changes: PresetChange[] = [];
  for (const [characterId, pair] of lists) {
    if (pair.before && pair.after && unchanged(pair.before, pair.after)) continue;
    const lines = !pair.before
      ? ['Added this order list']
      : !pair.after
        ? ['Removed this order list']
        : describeOrderChange(pair.before.order ?? [], pair.after.order ?? [], nameOf);
    if (lines.length) {
      changes.push({
        kind: 'order',
        key: `order:${characterId}`,
        label: orderLabel(characterId),
        lines,
      });
    }
  }
  return changes;
}

/** Every change from `before` to `after`: prompts first, then the order, then settings. */
export function describePresetChanges(before: Preset, after: Preset): PresetChange[] {
  const settings = unionKeys(before, after)
    .filter((key) => key !== 'prompts' && key !== 'prompt_order')
    .flatMap((key) => fieldChanges(key, settingLabel(key), before[key], after[key]));
  return [...promptChanges(before, after), ...orderChanges(before, after), ...settings];
}

/**
 * The fallback when the two presets are not at hand: the stored diff, one row per entry,
 * with prompt indices resolved to names against `preset` when it is given.
 */
export function describeDiffEntries(
  diff: readonly PresetDiffEntry[],
  preset?: Preset,
): PresetChange[] {
  return diff.map((entry, index): PresetChange => {
    const segments = entry.path.split('/').filter(Boolean);
    let label = segments.map(humanize).join(' › ') || 'Preset';
    if (segments[0] === 'prompts' && segments[1] !== undefined && preset) {
      const prompt = promptsOf(preset)[Number(segments[1])];
      if (prompt) {
        label = [promptName(prompt), ...segments.slice(2).map(promptFieldLabel)].join(' › ');
      }
    } else if (segments.length === 1) {
      label = settingLabel(segments[0]!);
    }
    return leafChange(`${entry.path}:${index}`, label, entry.before, entry.after);
  });
}

/** A plain value as a reader wants it: on/off, numbers as written, objects compact. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number') return String(value);
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
