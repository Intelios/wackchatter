import { diffPreset } from '@shared/preset-cocreator/patch.ts';
import { getPromptOrder } from '@shared/prompt/preset-io.ts';
import type { Preset, Prompt } from '@shared/types/preset.ts';
import { INJECTION_POSITION } from '@shared/types/preset.ts';
import type { PresetComparisonSource } from '@shared/types/preset-cocreator.ts';
import { describeOrderChange, promptName, SHORT_TEXT, settingLabel } from './presetChanges.ts';
import type { DiffPart, TextDiff } from './textDiff.ts';

/**
 * Two presets side by side: the Compare tab's model.
 *
 * History says what one revision changed. This lines any two presets up, whatever they
 * are: the draft, an earlier revision, a library preset, a reference. Prompts are matched
 * by identifier, the same way `describePresetChanges` does it, so an inserted prompt is one
 * new row rather than a shift of every row below it.
 */

export type CompareSource = { kind: 'draft' } | PresetComparisonSource;

/** The string a `Select` option carries for a source. The id is kept whole after the colon. */
export function encodeSource(source: CompareSource): string {
  if (source.kind === 'draft') return 'draft';
  if (source.kind === 'revision') return `revision:${source.revision}`;
  return `${source.kind}:${source.id}`;
}

export function decodeSource(value: string): CompareSource | null {
  if (value === 'draft') return { kind: 'draft' };
  const colon = value.indexOf(':');
  if (colon < 0) return null;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === 'revision') {
    return /^\d+$/.test(rest) ? { kind: 'revision', revision: Number(rest) } : null;
  }
  if ((kind === 'library' || kind === 'reference') && rest) return { kind, id: rest };
  return null;
}

/**
 * What the tab opens on: what Save to preset would overwrite against the draft or, with no
 * linked preset, where the session started against where it is now.
 */
export function defaultCompareSources(session: {
  targetPresetId: string | null;
  history: readonly { revision: number }[];
}): { left: CompareSource; right: CompareSource } {
  return {
    left: session.targetPresetId
      ? { kind: 'library', id: session.targetPresetId }
      : { kind: 'revision', revision: session.history[0]?.revision ?? 0 },
    right: { kind: 'draft' },
  };
}

export type CompareStatus = 'same' | 'changed' | 'added' | 'removed';

export interface PromptSide {
  name: string;
  content: string;
  /** Filled in by the app at generation time, so it has no text of its own to compare. */
  marker: boolean;
  /** On or off in the live order; null when the prompt is not in the order at all. */
  enabled: boolean | null;
  /** Role and placement, in words. */
  meta: string;
}

export interface PromptRow {
  key: string;
  label: string;
  status: CompareStatus;
  left: PromptSide | null;
  right: PromptSide | null;
}

export type SettingRow =
  | {
      key: string;
      label: string;
      status: CompareStatus;
      kind: 'text';
      left: string | null;
      right: string | null;
    }
  | {
      key: string;
      label: string;
      status: CompareStatus;
      kind: 'value';
      left: unknown;
      right: unknown;
    };

export interface SideBySide {
  prompts: PromptRow[];
  settings: SettingRow[];
  /** The live order's changes as sentences — moves are only visible here. */
  order: string[];
  /** Rows that differ, plus moves. Zero means the two presets read the same. */
  differences: number;
}

const promptsOf = (preset: Preset): Prompt[] =>
  Array.isArray(preset.prompts) ? (preset.prompts as Prompt[]) : [];

const same = (a: unknown, b: unknown) => diffPreset(a, b).length === 0;

function placement(prompt: Prompt): string {
  const parts: string[] = [prompt.role ?? 'system'];
  if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
    parts.push(
      `in chat at depth ${prompt.injection_depth ?? 4}, order ${prompt.injection_order ?? 100}`,
    );
  } else {
    parts.push('relative');
  }
  if (prompt.injection_trigger?.length)
    parts.push(`only on ${prompt.injection_trigger.join(', ')}`);
  if (prompt.forbid_overrides) parts.push('forbids card overrides');
  return parts.join(' · ');
}

function promptSide(prompt: Prompt, enabled: boolean | null): PromptSide {
  return {
    name: promptName(prompt),
    content: prompt.content ?? '',
    marker: prompt.marker === true,
    enabled,
    meta: placement(prompt),
  };
}

function promptRows(left: Preset, right: Preset): PromptRow[] {
  const leftPrompts = new Map(promptsOf(left).map((prompt) => [prompt.identifier, prompt]));
  const rightPrompts = new Map(promptsOf(right).map((prompt) => [prompt.identifier, prompt]));
  const leftOrder = new Map(getPromptOrder(left).map((entry) => [entry.identifier, entry.enabled]));
  const rightOrder = new Map(
    getPromptOrder(right).map((entry) => [entry.identifier, entry.enabled]),
  );

  // The new side's order first — that is how it will run — then anything only the old
  // side has, where it would read as "this went away".
  const identifiers = new Set([
    ...rightOrder.keys(),
    ...rightPrompts.keys(),
    ...leftOrder.keys(),
    ...leftPrompts.keys(),
  ]);

  const rows: PromptRow[] = [];
  for (const identifier of identifiers) {
    const a = leftPrompts.get(identifier);
    const b = rightPrompts.get(identifier);
    // An order entry with no prompt behind it is a dangling reference, not a prompt.
    if (!a && !b) continue;
    const leftSide = a ? promptSide(a, leftOrder.get(identifier) ?? null) : null;
    const rightSide = b ? promptSide(b, rightOrder.get(identifier) ?? null) : null;
    const status: CompareStatus = !a
      ? 'added'
      : !b
        ? 'removed'
        : same(a, b) && leftSide!.enabled === rightSide!.enabled
          ? 'same'
          : 'changed';
    rows.push({
      key: `prompt:${identifier}`,
      label: (rightSide ?? leftSide)!.name,
      status,
      left: leftSide,
      right: rightSide,
    });
  }
  return rows;
}

const isLongText = (value: unknown) =>
  typeof value === 'string' && (value.length > SHORT_TEXT || value.includes('\n'));

function settingRows(left: Preset, right: Preset): SettingRow[] {
  const keys = [...new Set([...Object.keys(right), ...Object.keys(left)])].filter(
    (key) => key !== 'prompts' && key !== 'prompt_order',
  );
  return keys.map((key): SettingRow => {
    const a = left[key];
    const b = right[key];
    const status: CompareStatus =
      a === undefined ? 'added' : b === undefined ? 'removed' : same(a, b) ? 'same' : 'changed';
    const base = { key: `setting:${key}`, label: settingLabel(key), status };
    const isObject = (value: unknown) => value !== null && typeof value === 'object';
    if (isLongText(a) || isLongText(b) || isObject(a) || isObject(b)) {
      const asText = (value: unknown) =>
        value === undefined
          ? null
          : typeof value === 'string'
            ? value
            : JSON.stringify(value, null, 2);
      return { ...base, kind: 'text', left: asText(a), right: asText(b) };
    }
    return { ...base, kind: 'value', left: a, right: b };
  });
}

export function buildSideBySide(left: Preset, right: Preset): SideBySide {
  const prompts = promptRows(left, right);
  const settings = settingRows(left, right);
  const names = new Map<string, string>();
  for (const prompt of [...promptsOf(left), ...promptsOf(right)]) {
    names.set(prompt.identifier, promptName(prompt));
  }
  const order = describeOrderChange(
    getPromptOrder(left),
    getPromptOrder(right),
    (identifier) => names.get(identifier) ?? identifier,
  );
  const moves = order.filter((line) => line.startsWith('Moved ')).length;
  const differing = (row: { status: CompareStatus }) => row.status !== 'same';
  return {
    prompts,
    settings,
    order,
    differences: prompts.filter(differing).length + settings.filter(differing).length + moves,
  };
}

/**
 * One word diff drawn as two columns: the old side shows what was removed, the new side
 * what was added, and both show what they share. A rewrite — too changed for a word diff
 * to be readable — is each whole text marked as that side's change.
 */
export function splitSides(diff: TextDiff): { left: DiffPart[]; right: DiffPart[] } {
  if (diff.mode === 'rewritten') {
    return {
      left: diff.before ? [{ kind: 'removed', text: diff.before }] : [],
      right: diff.after ? [{ kind: 'added', text: diff.after }] : [],
    };
  }
  return {
    left: diff.parts.filter((part) => part.kind !== 'added'),
    right: diff.parts.filter((part) => part.kind !== 'removed'),
  };
}
