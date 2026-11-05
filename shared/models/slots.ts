/**
 * Models are picked, connections are not.
 *
 * A `ModelRef` names one model on one saved connection, and every feature that generates
 * holds one: the app-wide slots below, a Co-Creator session's own pick, a Preset Co-Creator
 * document's assistant and tester, each Arena contender. Picking a model sets the pair at
 * once, so nothing can drift apart — the 2.x friction this replaces was a connection that
 * remembered one model for everybody, so switching connection brought back whatever model
 * some other screen had left on it.
 *
 * Pure: the server normalises with it and the client resolves with it.
 */

import type { Connection, ResolvedModel } from '../providers/types.ts';

export interface ModelRef {
  connectionId: string;
  modelId: string;
}

/**
 * The app-wide slots. Per-session and per-document picks (Co-Creator sessions, the Preset
 * Co-Creator's assistant and tester) and the Arena's contenders hold their own refs.
 */
export const MODEL_SLOTS = ['chat', 'summary', 'nexus', 'cocreator', 'sideChat'] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];
export type ModelSlots = Record<ModelSlot, ModelRef | null>;

export const DEFAULT_MODEL_SLOTS: Readonly<ModelSlots> = {
  chat: null,
  summary: null,
  nexus: null,
  cocreator: null,
  sideChat: null,
};

/**
 * Slots whose empty value means "same as chat". The others stay unconfigured until picked:
 * Nexus spends in the background, and the side chat never borrows another model, so neither
 * may quietly start paying for the chat's.
 */
export const FOLLOWS_CHAT: ReadonlySet<ModelSlot> = new Set<ModelSlot>(['summary', 'cocreator']);

/** What each slot is called mid-sentence ("Choose a … model"). */
export const SLOT_NOUNS: Readonly<Record<ModelSlot, string>> = {
  chat: 'chat',
  summary: 'summary',
  nexus: 'Nexus',
  cocreator: 'Co-Creator',
  sideChat: 'side chat',
};

/** How many entries `AppSettings.recentModels` keeps. */
export const MAX_RECENT_MODELS = 8 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A well-formed ref, or null. With `connections`, a ref to a connection that no longer
 * exists is null too — for app settings, where a deleted connection must not leave a slot
 * pointing nowhere. Per-session refs are normalised without it and report the missing
 * connection when resolved instead, so a session does not silently change model.
 */
export function normalizeModelRef(
  value: unknown,
  connections?: readonly Pick<Connection, 'id'>[],
): ModelRef | null {
  if (!isRecord(value)) return null;
  const { connectionId, modelId } = value;
  if (typeof connectionId !== 'string' || !connectionId) return null;
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  if (connections && !connections.some((connection) => connection.id === connectionId)) {
    return null;
  }
  return { connectionId, modelId: modelId.trim() };
}

export function normalizeModelSlots(
  value: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): ModelSlots {
  const stored = isRecord(value) ? value : {};
  const slots = { ...DEFAULT_MODEL_SLOTS };
  for (const slot of MODEL_SLOTS) slots[slot] = normalizeModelRef(stored[slot], connections);
  return slots;
}

export function sameModelRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined) {
  if (!a || !b) return a === b || (!a && !b);
  return a.connectionId === b.connectionId && a.modelId === b.modelId;
}

/** Deduplicated, newest first, capped, and only refs to connections that still exist. */
export function normalizeRecentModels(
  value: unknown,
  connections: readonly Pick<Connection, 'id'>[],
): ModelRef[] {
  if (!Array.isArray(value)) return [];
  const recent: ModelRef[] = [];
  for (const entry of value) {
    const ref = normalizeModelRef(entry, connections);
    if (!ref || recent.some((seen) => sameModelRef(seen, ref))) continue;
    recent.push(ref);
    if (recent.length === MAX_RECENT_MODELS) break;
  }
  return recent;
}

/** `ref` moved to the front of the recents. */
export function pushRecentModel(recent: readonly ModelRef[], ref: ModelRef): ModelRef[] {
  return [ref, ...recent.filter((entry) => !sameModelRef(entry, ref))].slice(0, MAX_RECENT_MODELS);
}

/** The connection a ref names, bound to its model — or null when the connection is gone. */
export function resolveModel(
  connections: readonly Connection[],
  ref: ModelRef | null | undefined,
): ResolvedModel | null {
  if (!ref) return null;
  const connection = connections.find((entry) => entry.id === ref.connectionId);
  return connection ? { ...connection, model: ref.modelId } : null;
}

export type ModelResolution =
  | { ok: true; ref: ModelRef; model: ResolvedModel }
  | { ok: false; ref: ModelRef | null; reason: string };

/**
 * Resolve a ref to something a generation can run on, or say why not. The reason is
 * written for a `disabledReason` title: what is missing and where to fix it.
 */
export function resolveModelRef(
  connections: readonly Connection[],
  ref: ModelRef | null | undefined,
  label: string,
): ModelResolution {
  if (!ref) return { ok: false, ref: null, reason: `Choose a ${label} model.` };
  const model = resolveModel(connections, ref);
  if (!model) {
    return {
      ok: false,
      ref,
      reason: `The connection for the ${label} model was deleted. Choose another model.`,
    };
  }
  if (!model.baseUrl) {
    return {
      ok: false,
      ref,
      reason: `The ${model.name} connection has no endpoint. Set one in Connections.`,
    };
  }
  return { ok: true, ref, model };
}

/** The ref a slot runs on: its own, or the chat's for a slot that follows chat. */
export function slotRef(slots: ModelSlots, slot: ModelSlot): ModelRef | null {
  return slots[slot] ?? (FOLLOWS_CHAT.has(slot) ? slots.chat : null);
}

export function resolveSlot(
  settings: { connections: readonly Connection[]; models: ModelSlots },
  slot: ModelSlot,
): ModelResolution {
  return resolveModelRef(settings.connections, slotRef(settings.models, slot), SLOT_NOUNS[slot]);
}
