/**
 * The Preset tool's rules, pure so they are pinned by tests: what changed since the last
 * save, how one change is put back, and how the request divides up for the context bar.
 */

import { getPromptOrder, setPromptOrder } from '@shared/prompt/preset-io.ts';
import type { Preset, Prompt, PromptOrderEntry } from '@shared/types/preset.ts';
import { sameValue } from '../lib/sameValue.ts';

export { sameValue };

export interface PresetChanges {
  /** Top-level settings that differ, by key. Prompts and their order are counted apart. */
  fields: string[];
  /** Prompts whose text, settings or on/off differ, by identifier; added and deleted included. */
  prompts: string[];
  /** Whether the prompts that exist in both were moved around. */
  reordered: boolean;
  count: number;
}

const PROMPT_KEYS = new Set(['prompts', 'prompt_order']);

/** Everything that differs between the saved preset and the working copy. */
export function presetChanges(saved: Preset | null, current: Preset | null): PresetChanges {
  if (!saved || !current || saved === current) {
    return { fields: [], prompts: [], reordered: false, count: 0 };
  }
  const fields: string[] = [];
  const keys = new Set([...Object.keys(saved), ...Object.keys(current)]);
  for (const key of keys) {
    if (PROMPT_KEYS.has(key)) continue;
    if (!sameValue(saved[key as keyof Preset], current[key as keyof Preset])) fields.push(key);
  }

  const savedPrompts = new Map((saved.prompts ?? []).map((p) => [p.identifier, p]));
  const currentPrompts = new Map((current.prompts ?? []).map((p) => [p.identifier, p]));
  const savedOrder = new Map(getPromptOrder(saved).map((e) => [e.identifier, e]));
  const currentOrder = new Map(getPromptOrder(current).map((e) => [e.identifier, e]));
  const prompts: string[] = [];
  const ids = new Set([...savedPrompts.keys(), ...currentPrompts.keys()]);
  for (const id of ids) {
    const promptDiffers = !sameValue(savedPrompts.get(id), currentPrompts.get(id));
    const switchDiffers =
      (savedOrder.get(id)?.enabled ?? null) !== (currentOrder.get(id)?.enabled ?? null);
    if (promptDiffers || switchDiffers) prompts.push(id);
  }

  const both = (order: PromptOrderEntry[], other: Map<string, PromptOrderEntry>) =>
    order.map((e) => e.identifier).filter((id) => other.has(id));
  const before = both(getPromptOrder(saved), currentOrder);
  const after = both(getPromptOrder(current), savedOrder);
  const reordered = !sameValue(before, after);

  return {
    fields,
    prompts,
    reordered,
    count: fields.length + prompts.length + (reordered ? 1 : 0),
  };
}

/** Put one setting back as it was saved. */
export function revertField(current: Preset, saved: Preset, key: string): Preset {
  const next = { ...current } as Record<string, unknown>;
  const was = (saved as Record<string, unknown>)[key];
  if (was === undefined) delete next[key];
  else next[key] = was;
  return next as Preset;
}

/**
 * Put one prompt back as it was saved: its text and settings, and whether it is switched
 * on. Its place in the order stays where you moved it. A prompt that did not exist at the
 * save is removed; one deleted since comes back at the end.
 */
export function revertPrompt(current: Preset, saved: Preset, identifier: string): Preset {
  const was = saved.prompts?.find((p) => p.identifier === identifier);
  const wasEntry = getPromptOrder(saved).find((e) => e.identifier === identifier);
  let prompts = current.prompts ?? [];
  if (!was) prompts = prompts.filter((p) => p.identifier !== identifier);
  else if (prompts.some((p) => p.identifier === identifier)) {
    prompts = prompts.map((p) => (p.identifier === identifier ? was : p));
  } else prompts = [...prompts, was];

  let order = getPromptOrder(current);
  if (!wasEntry) order = order.filter((e) => e.identifier !== identifier);
  else if (order.some((e) => e.identifier === identifier)) {
    order = order.map((e) =>
      e.identifier === identifier ? { ...e, enabled: wasEntry.enabled } : e,
    );
  } else order = [...order, wasEntry];

  return setPromptOrder({ ...current, prompts }, order);
}

/** Put the order back as saved, keeping every prompt's own changes. */
export function revertOrder(current: Preset, saved: Preset): Preset {
  const currentOrder = getPromptOrder(current);
  const byId = new Map(currentOrder.map((e) => [e.identifier, e]));
  const restored = getPromptOrder(saved)
    .filter((e) => byId.has(e.identifier))
    .map((e) => byId.get(e.identifier)!);
  const added = currentOrder.filter(
    (e) => !getPromptOrder(saved).some((s) => s.identifier === e.identifier),
  );
  return setPromptOrder(current, [...restored, ...added]);
}

export type SegmentKind = 'mine' | 'card' | 'lore' | 'history';

/** What a prompt draws on, for its colour in the context bar. */
export function segmentKind(identifier: string): SegmentKind {
  switch (identifier) {
    case 'chatHistory':
      return 'history';
    case 'worldInfoBefore':
    case 'worldInfoAfter':
      return 'lore';
    case 'charDescription':
    case 'charPersonality':
    case 'scenario':
    case 'personaDescription':
    case 'dialogueExamples':
      return 'card';
    default:
      return 'mine';
  }
}

export interface ContextSegment {
  identifier: string;
  name: string;
  kind: SegmentKind;
  tokens: number;
}

/**
 * The request, part by part, in the order it is sent: each switched-on prompt that costs
 * something. Documentation never reaches a request, so it is never a part.
 */
export function contextSegments(
  preset: Preset,
  tokensOf: (prompt: Prompt | undefined, identifier: string) => number,
): ContextSegment[] {
  const prompts = new Map((preset.prompts ?? []).map((p) => [p.identifier, p]));
  const segments: ContextSegment[] = [];
  for (const entry of getPromptOrder(preset)) {
    if (!entry.enabled) continue;
    const prompt = prompts.get(entry.identifier);
    if (prompt?.role === 'documentation') continue;
    const tokens = tokensOf(prompt, entry.identifier);
    if (tokens <= 0) continue;
    segments.push({
      identifier: entry.identifier,
      name: prompt?.name ?? entry.identifier,
      kind: segmentKind(entry.identifier),
      tokens,
    });
  }
  return segments;
}
