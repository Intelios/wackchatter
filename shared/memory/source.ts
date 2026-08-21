/**
 * Memories as a World Info source, and the recall pass that selects them.
 *
 * `SOURCE_ORDER` has always begun with `'chat'` — a source kind the activation engine
 * implements and tests but which nothing in the app ever produced. This is what fills it.
 * Everything recall needs already exists there: keyword matching with regex literals,
 * `constant` entries that always fire, budget enforcement, recursion, and the inspector
 * reporting that answers "why didn't it remember the cellar?".
 *
 * The pass is deliberately its own, over the memory source alone, rather than adding
 * memories to the lorebook sources:
 *
 *  - **Its own budget.** Memories accumulate for as long as a chat runs. Sharing the World
 *    Info pool would let them gradually crowd out lorebook entries, and the symptom — lore
 *    quietly no longer firing — is close to undiagnosable.
 *  - **No cross-triggering.** A memory can wake another memory, but cannot wake a lorebook
 *    entry and vice versa, because neither is in the other's pass.
 *
 * Only the *selection* is taken from the result. Placement is the story-memory slot in
 * `assemblePrompt`, which is where the template, position, depth and role live.
 */

import type { ChatMessage, Memory } from '../types/chat.ts';
import type { WorldInfoBook, WorldInfoSettings } from '../types/worldinfo.ts';
import { createWorldInfoEntry, WI_POSITION } from '../types/worldinfo.ts';
import type { ActivationResult, WorldInfoSource } from '../worldinfo/activate.ts';
import { activateWorldInfo } from '../worldinfo/activate.ts';
import { renderMemories, renderMemory } from './render.ts';

/** Pinned memories outrank recalled ones when the budget runs short. */
const PINNED_ORDER_BASE = 1000;

export const MEMORY_SOURCE_NAME = 'Memories';

/**
 * One entry per memory, `uid` being its index — which is how an activated entry is mapped
 * back to the memory that produced it.
 *
 * A memory that is neither pinned nor keyed can never activate. That is left as-is rather
 * than papered over with a fallback key: it is a real state with a real fix (pin it, or
 * give it a keyword), and the panel flags it. Inventing keys from the title would produce
 * an entry that looks recallable and never is.
 */
export function memoryWorldInfoSource(memories: Memory[]): WorldInfoSource {
  const entries: WorldInfoBook['entries'] = {};

  memories.forEach((memory, index) => {
    if (!memory.enabled) return;
    const content = renderMemory(memory);
    if (!content.trim()) return;

    entries[String(index)] = {
      ...createWorldInfoEntry(index),
      key: memory.pinned ? [] : memory.keywords,
      comment: memory.title,
      content,
      constant: memory.pinned,
      position: WI_POSITION.before,
      order: memory.pinned ? PINNED_ORDER_BASE + index : index,
    };
  });

  return { kind: 'chat', name: MEMORY_SOURCE_NAME, book: { name: MEMORY_SOURCE_NAME, entries } };
}

export interface RecallMemoriesOptions {
  memories: Memory[];
  /** The transcript, oldest first, including the just-typed user message. */
  messages: ChatMessage[];
  /** Global scan settings — depth, case sensitivity, whole words. Shared with lore. */
  settings: WorldInfoSettings;
  /** `MemorySettings.budgetTokens`, not the World Info budget. */
  budget: number;
  countTokens: (text: string) => number;
  includeNames?: boolean;
  seed?: string;
}

export interface MemoryRecall {
  /** The selected memories, rendered oldest-first, ready for the story-memory slot. */
  text: string;
  /** Which memories fired, in chat order. */
  recalled: Memory[];
  /** The raw pass, so the World Info Report can show what fired and what was skipped. */
  activation: ActivationResult;
}

/**
 * Run the recall pass. Null when there is nothing to recall at all.
 *
 * The result is re-sorted into chat order rather than kept in activation order. These are
 * events in a story: a model shown "The Bargain" above "First Meeting" will read the
 * ordering as meaningful and write the relationship backwards.
 */
export function recallMemories(options: RecallMemoriesOptions): MemoryRecall | null {
  const { memories, messages, settings, budget, countTokens, includeNames, seed } = options;
  if (!memories.some((memory) => memory.enabled)) return null;

  const source = memoryWorldInfoSource(memories);
  const activation = activateWorldInfo({
    sources: [source],
    messages,
    settings,
    budget,
    countTokens,
    includeNames,
    seed,
  });

  const fired = new Set(activation.activated.map((entry) => entry.uid));
  const recalled = memories.filter((_, index) => fired.has(index));

  return { text: renderMemories(recalled), recalled, activation };
}
