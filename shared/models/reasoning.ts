/** Per-model reasoning preferences, keyed by a model's connection and opaque model id. */

import type { Connection } from '../providers/types.ts';
import type { Preset, ReasoningEffort } from '../types/preset.ts';
import { type ModelRef, normalizeModelRef } from './slots.ts';

/** An absent leaf follows the fallback; `auto` is an explicit override, not an absence. */
export type ModelReasoningEfforts = Record<string, Record<string, ReasoningEffort>>;

/** Only a model-level null removes a preference and resumes following the fallback. */
export type ModelReasoningEffortPatch = Record<string, Record<string, ReasoningEffort | null>>;

export type ChatReasoningEfforts = ModelReasoningEfforts;
export type ChatReasoningEffortPatch = ModelReasoningEffortPatch;

export const COCREATOR_REASONING_TARGETS = [
  'character',
  'sideChat',
  'presetAssistant',
  'presetBench',
] as const;
export type CoCreatorReasoningTarget = (typeof COCREATOR_REASONING_TARGETS)[number];

export type CoCreatorReasoningEfforts = Record<CoCreatorReasoningTarget, ModelReasoningEfforts>;
export type CoCreatorReasoningEffortPatch = Partial<
  Record<CoCreatorReasoningTarget, ModelReasoningEffortPatch>
>;

export function emptyCoCreatorReasoningEfforts(): CoCreatorReasoningEfforts {
  return {
    character: {},
    sideChat: {},
    presetAssistant: {},
    presetBench: {},
  };
}

export const REASONING_EFFORT_OPTIONS: readonly [ReasoningEffort, string][] = [
  ['auto', 'Auto'],
  ['min', 'Min'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['max', 'Max'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORT_OPTIONS.some(([effort]) => effort === value);
}

export function chatReasoningEffort(
  efforts: ChatReasoningEfforts,
  ref: ModelRef | null | undefined,
): ReasoningEffort | undefined {
  const model = normalizeModelRef(ref);
  if (!model || !Object.hasOwn(efforts, model.connectionId)) return undefined;
  const models = efforts[model.connectionId];
  if (!isRecord(models) || !Object.hasOwn(models, model.modelId)) return undefined;
  const effort = models[model.modelId];
  return isReasoningEffort(effort) ? effort : undefined;
}

export function coCreatorReasoningEffort(
  efforts: Partial<CoCreatorReasoningEfforts> | undefined,
  target: CoCreatorReasoningTarget,
  ref: ModelRef | null | undefined,
): ReasoningEffort | undefined {
  if (!efforts || !Object.hasOwn(efforts, target)) return undefined;
  const map = efforts[target];
  return isRecord(map) ? chatReasoningEffort(map as ModelReasoningEfforts, ref) : undefined;
}

/** Request-local only: never edit the preset or collapse an explicit equal-value pin. */
export function withReasoningEffort(preset: Preset, effort: ReasoningEffort | undefined): Preset {
  return effort === undefined ? preset : { ...preset, reasoning_effort: effort };
}

/** Read-time normalization drops malformed leaves, empty maps and deleted connections. */
export function normalizeChatReasoningEfforts(
  value: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): ChatReasoningEfforts {
  if (!isRecord(value)) return {};
  const connectionIds = new Set(connections.map((connection) => connection.id));
  const entries: [string, Record<string, ReasoningEffort>][] = [];
  for (const [connectionId, models] of Object.entries(value)) {
    if (!connectionIds.has(connectionId) || !isRecord(models)) continue;
    const modelEntries: [string, ReasoningEffort][] = [];
    for (const [modelId, effort] of Object.entries(models)) {
      if (!isReasoningEffort(effort)) continue;
      const ref = normalizeModelRef({ connectionId, modelId });
      if (ref) modelEntries.push([ref.modelId, effort]);
    }
    if (modelEntries.length) entries.push([connectionId, Object.fromEntries(modelEntries)]);
  }
  // fromEntries creates own data properties even for __proto__ and constructor ids.
  return Object.fromEntries(entries);
}

/** Two-level partial merge. Invalid patches never erase valid saved preferences. */
export function mergeChatReasoningEfforts(
  current: ChatReasoningEfforts,
  patch: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): ChatReasoningEfforts {
  let next = normalizeChatReasoningEfforts(current, connections);
  if (!isRecord(patch)) return next;
  const connectionIds = new Set(connections.map((connection) => connection.id));
  for (const [connectionId, models] of Object.entries(patch)) {
    if (!connectionIds.has(connectionId) || !isRecord(models)) continue;
    const changes: [string, ReasoningEffort | null][] = [];
    for (const [modelId, effort] of Object.entries(models)) {
      if (effort !== null && !isReasoningEffort(effort)) continue;
      const ref = normalizeModelRef({ connectionId, modelId });
      if (ref) changes.push([ref.modelId, effort]);
    }
    if (!changes.length) continue;
    const existing = Object.hasOwn(next, connectionId) ? next[connectionId] : {};
    const merged = { ...existing, ...Object.fromEntries(changes) };
    const kept = Object.fromEntries(
      Object.entries(merged).filter(
        (entry): entry is [string, ReasoningEffort] => entry[1] !== null,
      ),
    );
    if (Object.keys(kept).length) next = { ...next, [connectionId]: kept };
    else delete next[connectionId];
  }
  return next;
}

export function normalizeCoCreatorReasoningEfforts(
  value: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): CoCreatorReasoningEfforts {
  const record = isRecord(value) ? value : {};
  return {
    character: normalizeChatReasoningEfforts(
      Object.hasOwn(record, 'character') ? record.character : undefined,
      connections,
    ),
    sideChat: normalizeChatReasoningEfforts(
      Object.hasOwn(record, 'sideChat') ? record.sideChat : undefined,
      connections,
    ),
    presetAssistant: normalizeChatReasoningEfforts(
      Object.hasOwn(record, 'presetAssistant') ? record.presetAssistant : undefined,
      connections,
    ),
    presetBench: normalizeChatReasoningEfforts(
      Object.hasOwn(record, 'presetBench') ? record.presetBench : undefined,
      connections,
    ),
  };
}

export function mergeCoCreatorReasoningEfforts(
  current: CoCreatorReasoningEfforts | undefined,
  patch: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): CoCreatorReasoningEfforts {
  const next = normalizeCoCreatorReasoningEfforts(current, connections);
  if (!isRecord(patch)) return next;
  for (const target of COCREATOR_REASONING_TARGETS) {
    if (!Object.hasOwn(patch, target)) continue;
    next[target] = mergeChatReasoningEfforts(next[target], patch[target], connections);
  }
  return next;
}
