import type { Preset, Prompt, PromptOrderList } from '../types/preset.ts';
import {
  BUILTIN_IDENTIFIERS,
  MARKER_IDENTIFIERS,
  PROMPT_ORDER_LEGACY_ID,
  PROMPT_ORDER_LIVE_ID,
} from '../types/preset.ts';

export type JsonPatchOperation =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export interface PresetDiffEntry {
  path: string;
  kind: 'add' | 'remove' | 'replace';
  before?: unknown;
  after?: unknown;
}

export interface AppliedPresetPatch {
  preset: Preset;
  diff: PresetDiffEntry[];
}

/** Preset fields that describe an endpoint/model in SillyTavern, never this app's runtime. */
export const PROTECTED_PRESET_FIELDS = new Set([
  'api_key',
  'api_url',
  'chat_completion_source',
  'claude_model',
  'cohere_model',
  'custom_model',
  'custom_url',
  'google_model',
  'groq_model',
  'makersuite_model',
  'mistralai_model',
  'openai_model',
  'openrouter_model',
  'perplexity_model',
  'proxy_password',
  'reverse_proxy',
  'windowai_model',
]);

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerSegments(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`JSON patch path "${path}" must start with /.`);
  return path
    .slice(1)
    .split('/')
    .map((raw) => {
      if (/~(?:[^01]|$)/.test(raw))
        throw new Error(`JSON patch path "${path}" has invalid escaping.`);
      const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (UNSAFE_SEGMENTS.has(segment)) {
        throw new Error(`JSON patch path "${path}" contains an unsafe property.`);
      }
      return segment;
    });
}

/**
 * The reference the assistant reads nests the preset under a `preset` key, so models
 * naturally write `/preset/temperature` when they mean `/temperature`. Accept that root —
 * but only when the document has no *real* top-level `preset` key to address.
 */
function normalizeRoot(path: string, base: Preset): string {
  if (path !== '/preset' && !path.startsWith('/preset/')) return path;
  if (isRecord(base) && Object.hasOwn(base, 'preset')) return path;
  return path === '/preset' ? '' : path.slice('/preset'.length);
}

function arrayIndex(segment: string, length: number, allowEnd: boolean): number {
  if (allowEnd && segment === '-') return length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`"${segment}" is not an array index.`);
  const index = Number(segment);
  const ceiling = allowEnd ? length : length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index > ceiling) {
    throw new Error(`Array index ${segment} is out of bounds.`);
  }
  return index;
}

function readAt(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[arrayIndex(segment, current.length, false)];
    else if (isRecord(current) && Object.hasOwn(current, segment)) current = current[segment];
    else
      throw new Error(`JSON patch path /${segments.map(escapePointer).join('/')} does not exist.`);
  }
  return current;
}

function parentAt(root: unknown, segments: readonly string[]): { parent: unknown; key: string } {
  if (segments.length === 0) throw new Error('The document root has no parent.');
  return { parent: readAt(root, segments.slice(0, -1)), key: segments.at(-1)! };
}

function setAt(root: unknown, segments: readonly string[], value: unknown, add: boolean): unknown {
  if (segments.length === 0) return structuredClone(value);
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, add);
    if (add) parent.splice(index, 0, structuredClone(value));
    else parent[index] = structuredClone(value);
    return root;
  }
  if (!isRecord(parent)) throw new Error('JSON patch target parent is not an object or array.');
  if (!add && !Object.hasOwn(parent, key))
    throw new Error(`JSON patch replace target "${key}" is missing.`);
  parent[key] = structuredClone(value);
  return root;
}

function removeAt(root: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) throw new Error('A preset document cannot be removed.');
  const { parent, key } = parentAt(root, segments);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(key, parent.length, false), 1);
    return root;
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, key)) {
    throw new Error(`JSON patch remove target "${key}" is missing.`);
  }
  delete parent[key];
  return root;
}

function assertFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function validatePrompt(prompt: unknown, index: number): asserts prompt is Prompt {
  if (!isRecord(prompt)) throw new Error(`Prompt ${index + 1} must be an object.`);
  if (typeof prompt.identifier !== 'string' || !prompt.identifier.trim()) {
    throw new Error(`Prompt ${index + 1} needs a non-empty identifier.`);
  }
  if (typeof prompt.name !== 'string') throw new Error(`Prompt ${prompt.identifier} needs a name.`);
  if (prompt.role !== undefined && !['system', 'user', 'assistant'].includes(String(prompt.role))) {
    throw new Error(`Prompt ${prompt.identifier} has an invalid role.`);
  }
  if (prompt.content !== undefined && typeof prompt.content !== 'string') {
    throw new Error(`Prompt ${prompt.identifier} content must be text.`);
  }
  for (const key of ['marker', 'system_prompt', 'forbid_overrides', 'extension'] as const) {
    if (prompt[key] !== undefined && typeof prompt[key] !== 'boolean') {
      throw new Error(`Prompt ${prompt.identifier} ${key} must be boolean.`);
    }
  }
  for (const key of ['injection_depth', 'injection_order'] as const) {
    assertFiniteNumber(prompt[key], `Prompt ${prompt.identifier} ${key}`);
  }
  if (
    prompt.injection_position !== undefined &&
    prompt.injection_position !== 0 &&
    prompt.injection_position !== 1
  ) {
    throw new Error(`Prompt ${prompt.identifier} has an invalid injection position.`);
  }
  if (
    prompt.injection_trigger !== undefined &&
    (!Array.isArray(prompt.injection_trigger) ||
      prompt.injection_trigger.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error(`Prompt ${prompt.identifier} has invalid injection triggers.`);
  }
}

function validateOrderList(
  value: unknown,
  prompts: Set<string>,
): asserts value is PromptOrderList[] {
  if (!Array.isArray(value)) throw new Error('prompt_order must be an array.');
  const live = value.filter(
    (entry) => isRecord(entry) && Number(entry.character_id) === PROMPT_ORDER_LIVE_ID,
  );
  if (live.length !== 1)
    throw new Error('The preset must contain exactly one live 100001 prompt order.');
  for (const [listIndex, rawList] of value.entries()) {
    if (!isRecord(rawList) || !Array.isArray(rawList.order)) {
      throw new Error(`Prompt order ${listIndex + 1} must contain an order array.`);
    }
    if (typeof rawList.character_id !== 'number' || !Number.isFinite(rawList.character_id)) {
      throw new Error(`Prompt order ${listIndex + 1} has an invalid character_id.`);
    }
    const seen = new Set<string>();
    for (const [entryIndex, rawEntry] of rawList.order.entries()) {
      if (!isRecord(rawEntry) || typeof rawEntry.identifier !== 'string') {
        throw new Error(`Prompt order entry ${entryIndex + 1} is invalid.`);
      }
      if (typeof rawEntry.enabled !== 'boolean') {
        throw new Error(`Prompt order entry ${rawEntry.identifier} needs a boolean enabled value.`);
      }
      if (Number(rawList.character_id) === PROMPT_ORDER_LIVE_ID) {
        if (!prompts.has(rawEntry.identifier)) {
          throw new Error(`Live prompt order references unknown prompt "${rawEntry.identifier}".`);
        }
        if (seen.has(rawEntry.identifier)) {
          throw new Error(`Live prompt order contains duplicate prompt "${rawEntry.identifier}".`);
        }
        seen.add(rawEntry.identifier);
      }
    }
    if (Number(rawList.character_id) === PROMPT_ORDER_LIVE_ID && seen.size !== prompts.size) {
      throw new Error('Every prompt must appear exactly once in the live prompt order.');
    }
  }
}

/** Validate a complete draft and ensure fields outside the assistant boundary did not move. */
export function validatePresetDraft(candidate: unknown, previous?: Preset): Preset {
  if (!isRecord(candidate)) throw new Error('Preset draft must be a JSON object.');
  if (!Array.isArray(candidate.prompts)) throw new Error('Preset draft needs a prompts array.');

  const seen = new Set<string>();
  for (const [index, prompt] of candidate.prompts.entries()) {
    validatePrompt(prompt, index);
    if (seen.has(prompt.identifier))
      throw new Error(`Preset contains duplicate prompt "${prompt.identifier}".`);
    seen.add(prompt.identifier);
  }
  for (const identifier of BUILTIN_IDENTIFIERS) {
    if (!seen.has(identifier))
      throw new Error(`Preset is missing built-in prompt "${identifier}".`);
  }
  for (const identifier of MARKER_IDENTIFIERS) {
    const marker = candidate.prompts.find((prompt) => prompt.identifier === identifier)!;
    if (marker.marker !== true || Object.hasOwn(marker, 'content')) {
      throw new Error(
        `Built-in marker prompt "${identifier}" must remain a marker with no content.`,
      );
    }
  }

  validateOrderList(candidate.prompt_order, seen);

  const numeric = [
    'temperature',
    'frequency_penalty',
    'presence_penalty',
    'top_p',
    'top_k',
    'top_a',
    'min_p',
    'repetition_penalty',
    'seed',
    'n',
    'openai_max_context',
    'openai_max_tokens',
    'names_behavior',
  ];
  for (const key of numeric) assertFiniteNumber(candidate[key], key);
  const maxContext = candidate.openai_max_context;
  if (
    maxContext !== undefined &&
    (typeof maxContext !== 'number' || !Number.isSafeInteger(maxContext) || maxContext <= 0)
  ) {
    throw new Error('openai_max_context must be a positive integer.');
  }
  const maxTokens = candidate.openai_max_tokens;
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw new Error('openai_max_tokens must be a positive integer.');
  }
  const completions = candidate.n;
  if (
    completions !== undefined &&
    (typeof completions !== 'number' ||
      !Number.isSafeInteger(completions) ||
      completions < 1 ||
      completions > 8)
  ) {
    throw new Error('n must be an integer from 1 to 8.');
  }
  if (
    candidate.reasoning_effort !== undefined &&
    !['auto', 'min', 'low', 'medium', 'high', 'max'].includes(String(candidate.reasoning_effort))
  ) {
    throw new Error('reasoning_effort is invalid.');
  }

  if (previous) {
    for (const key of PROTECTED_PRESET_FIELDS) {
      if (!deepEqual(previous[key], candidate[key])) {
        throw new Error(`Preset field "${key}" is read-only in the Co-Creator.`);
      }
    }
    const previousLegacy = previous.prompt_order?.filter(
      (entry) => Number(entry.character_id) === PROMPT_ORDER_LEGACY_ID,
    );
    const candidateLegacy = (candidate.prompt_order as PromptOrderList[]).filter(
      (entry) => Number(entry.character_id) === PROMPT_ORDER_LEGACY_ID,
    );
    if (!deepEqual(previousLegacy, candidateLegacy)) {
      throw new Error('The legacy 100000 prompt order is read-only and must remain untouched.');
    }
  }

  return structuredClone(candidate) as Preset;
}

export function diffPreset(before: unknown, after: unknown, path = ''): PresetDiffEntry[] {
  if (deepEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: PresetDiffEntry[] = [];
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      const nextPath = `${path}/${index}`;
      if (index >= before.length)
        changes.push({ path: nextPath, kind: 'add', after: structuredClone(after[index]) });
      else if (index >= after.length)
        changes.push({ path: nextPath, kind: 'remove', before: structuredClone(before[index]) });
      else changes.push(...diffPreset(before[index], after[index], nextPath));
    }
    return changes;
  }
  if (isRecord(before) && isRecord(after)) {
    const changes: PresetDiffEntry[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const nextPath = `${path}/${escapePointer(key)}`;
      if (!Object.hasOwn(before, key))
        changes.push({ path: nextPath, kind: 'add', after: structuredClone(after[key]) });
      else if (!Object.hasOwn(after, key))
        changes.push({ path: nextPath, kind: 'remove', before: structuredClone(before[key]) });
      else changes.push(...diffPreset(before[key], after[key], nextPath));
    }
    return changes;
  }
  return [
    {
      path: path || '',
      kind: before === undefined ? 'add' : after === undefined ? 'remove' : 'replace',
      ...(before !== undefined ? { before: structuredClone(before) } : {}),
      ...(after !== undefined ? { after: structuredClone(after) } : {}),
    },
  ];
}

/** Apply a whole JSON Patch batch on a clone, then validate before returning any mutation. */
export function applyPresetPatch(
  base: Preset,
  operations: readonly JsonPatchOperation[],
): AppliedPresetPatch {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('At least one JSON patch operation is required.');
  }
  let next: unknown = structuredClone(base);
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== 'object' || typeof operation.path !== 'string') {
      throw new Error(`JSON patch operation ${index + 1} is invalid.`);
    }
    const allowed = operation.op === 'remove' ? ['op', 'path'] : ['op', 'path', 'value'];
    const unexpected = Object.keys(operation).find((key) => !allowed.includes(key));
    if (unexpected) {
      throw new Error(
        `JSON patch operation ${index + 1} contains unexpected field "${unexpected}".`,
      );
    }
    const segments = pointerSegments(normalizeRoot(operation.path, base));
    if (operation.op === 'test') {
      if (!deepEqual(readAt(next, segments), operation.value)) {
        throw new Error(`JSON patch test failed at ${operation.path || '/'}; the draft changed.`);
      }
    } else if (operation.op === 'add') {
      next = setAt(next, segments, operation.value, true);
    } else if (operation.op === 'replace') {
      if (segments.length > 0) readAt(next, segments);
      next = setAt(next, segments, operation.value, false);
    } else if (operation.op === 'remove') {
      next = removeAt(next, segments);
    } else {
      throw new Error(
        `JSON patch operation ${index + 1} uses unsupported op "${String((operation as { op?: unknown }).op)}".`,
      );
    }
  }

  const preset = validatePresetDraft(next, base);
  const diff = diffPreset(base, preset);
  if (diff.length === 0) throw new Error('The patch did not change the preset.');
  return { preset, diff };
}
