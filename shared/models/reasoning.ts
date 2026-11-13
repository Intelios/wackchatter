/** Chat-only reasoning preferences, keyed by a model's connection and opaque model id. */

import type { Connection } from '../providers/types.ts';
import type { Preset, ReasoningEffort } from '../types/preset.ts';
import { type ModelRef, normalizeModelRef } from './slots.ts';

/** An absent leaf follows the preset; `auto` is an explicit override, not an absence. */
export type ChatReasoningEfforts = Record<string, Record<string, ReasoningEffort>>;

/** Only a model-level null removes a preference and resumes following the preset. */
export type ChatReasoningEffortPatch = Record<string, Record<string, ReasoningEffort | null>>;

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
