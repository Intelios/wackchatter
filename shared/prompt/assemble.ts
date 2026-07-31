/**
 * Prompt assembly — turns a preset, a character, a persona and a chat log into the
 * message array sent to the provider.
 *
 * The semantics here are ported from SillyTavern deliberately, because presets encode
 * assumptions about them. The ones that matter:
 *
 *  - Iteration order is `prompt_order[].order`, filtered by that entry's `enabled` flag
 *    (NOT the prompt object's own `enabled`, which SillyTavern never reads).
 *  - Macros are substituted per prompt object and per message, at materialisation time.
 *  - The token budget is `openai_max_context - openai_max_tokens`. Chat history packs
 *    newest-first and stops hard at the first message that doesn't fit.
 *  - `injection_position: ABSOLUTE` prompts leave the ordered walk and splice into the
 *    history at `injection_depth`, ties broken by `injection_order` descending.
 *  - A character card's system_prompt / post_history_instructions override the `main` /
 *    `jailbreak` prompts unless the prompt sets `forbid_overrides`.
 */

import type { CardDataV2 } from '../types/card.ts';
import type { ApiMessage, ChatMessage, Persona } from '../types/chat.ts';
import type { GenerationType, Preset, Prompt } from '../types/preset.ts';
import {
  CHARACTER_NAMES_BEHAVIOR,
  DEFAULT_INJECTION_DEPTH,
  DEFAULT_INJECTION_ORDER,
  INJECTION_POSITION,
} from '../types/preset.ts';
import { type MacroEnvironment, substituteMacros } from './macros.ts';
import { getPromptOrder } from './preset-io.ts';

export interface AssembleOptions {
  preset: Preset;
  character: CardDataV2;
  persona?: Persona | null;
  messages: ChatMessage[];
  /** Display name for the user; falls back to the persona name. */
  userName?: string;
  generationType?: GenerationType;
  /** Activated world info, already sorted, split by insertion point. */
  worldInfoBefore?: string;
  worldInfoAfter?: string;
  /** World info entries injected at a specific chat depth. */
  worldInfoDepth?: DepthInjection[];
  countTokens: (text: string) => number;
  /** Stabilises {{pick}} across regenerations. */
  seed?: string;
}

export interface DepthInjection {
  depth: number;
  order: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AssembleResult {
  messages: ApiMessage[];
  /** Token count per prompt identifier, for the Prompt Manager display. */
  tokenCounts: Record<string, number>;
  totalTokens: number;
  /** Messages dropped because the budget ran out. */
  droppedMessages: number;
}

/** An assembled piece, before flattening into the final array. */
interface Slot {
  identifier: string;
  messages: ApiMessage[];
  tokens: number;
}

function sanitizeName(name: string): string | undefined {
  // The OpenAI `name` field permits only these characters.
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
  return cleaned || undefined;
}

/**
 * Parse `mes_example` into alternating example messages.
 * Blocks are separated by <START>; lines are prefixed with {{user}}: or {{char}}:.
 */
export function parseExampleDialogue(raw: string, env: MacroEnvironment): ApiMessage[][] {
  if (!raw?.trim()) return [];

  const blocks = raw
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const messages: ApiMessage[] = [];
      // Split on a name prefix at the start of a line, keeping the delimiter.
      const parts = block.split(/^(?=\s*\{\{(?:user|char)\}\}\s*:)/gim);

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const match = /^\{\{(user|char)\}\}\s*:\s*([\s\S]*)$/i.exec(trimmed);
        if (!match) continue;

        const isUser = match[1]!.toLowerCase() === 'user';
        const content = substituteMacros(match[2]!.trim(), env);
        if (!content) continue;

        messages.push({
          role: 'system',
          content,
          name: isUser ? 'example_user' : 'example_assistant',
        });
      }

      return messages;
    })
    .filter((block) => block.length > 0);
}

/**
 * Splice depth-injected content into the chat history.
 * Depth counts back from the end: 0 = after the last message, 1 = before it.
 */
function applyDepthInjections(history: ApiMessage[], injections: DepthInjection[]): ApiMessage[] {
  if (!injections.length) return history;

  const byDepth = new Map<number, DepthInjection[]>();
  for (const injection of injections) {
    const list = byDepth.get(injection.depth) ?? [];
    list.push(injection);
    byDepth.set(injection.depth, list);
  }

  // Work back-to-front so earlier splices don't shift later indices.
  const result = [...history];
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  for (const depth of depths) {
    const group = byDepth.get(depth)!;
    // Higher injection_order goes first at the same depth.
    group.sort((a, b) => b.order - a.order);

    const index = Math.max(0, result.length - depth);
    result.splice(index, 0, ...group.map((item) => ({ role: item.role, content: item.content })));
  }

  return result;
}

/**
 * Merge consecutive system messages that have no `name`, matching SillyTavern's
 * squashSystemMessages. Named messages act as hard breaks.
 */
function squashSystemMessages(messages: ApiMessage[]): ApiMessage[] {
  const result: ApiMessage[] = [];

  for (const message of messages) {
    const previous = result[result.length - 1];
    const squashable =
      message.role === 'system' && !message.name && previous?.role === 'system' && !previous.name;

    if (!message.content.trim() && message.role === 'system') continue;

    if (squashable) {
      previous.content = `${previous.content}\n${message.content}`;
    } else {
      result.push({ ...message });
    }
  }

  return result;
}

/**
 * Reshape the prompt for a `continue`, where the model extends its own last reply
 * rather than writing a new one.
 *
 * Two shapes, chosen by `continue_prefill`:
 *  - Prefill: the partial reply becomes the FINAL message, so the model carries straight
 *    on from it. It has to be moved there because prompts ordered after chatHistory
 *    (jailbreak, typically) would otherwise sit between it and the completion.
 *  - Nudge: the partial stays where it is and an instruction is appended instead. Used
 *    for providers that reject a trailing assistant turn.
 *
 * `continue_postfix` is the join between the old text and the new — the reason a
 * continuation does not otherwise run into the previous word.
 */
function applyContinue(
  messages: ApiMessage[],
  preset: Preset,
  env: MacroEnvironment,
  seed: string,
): ApiMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  if (lastAssistant === -1) return messages;

  const postfix = preset.continue_postfix ?? ' ';

  if (preset.continue_prefill) {
    const partial = messages[lastAssistant]!;
    const rest = messages.filter((_, index) => index !== lastAssistant);
    return [...rest, { ...partial, content: `${partial.content}${postfix}` }];
  }

  const nudge = substituteMacros(
    preset.continue_nudge_prompt ??
      '[Continue your last message without repeating its original content.]',
    env,
    seed,
  );

  return nudge ? [...messages, { role: 'system' as const, content: nudge }] : messages;
}

export function assemblePrompt(options: AssembleOptions): AssembleResult {
  const {
    preset,
    character,
    persona,
    messages,
    generationType = 'normal',
    worldInfoBefore = '',
    worldInfoAfter = '',
    worldInfoDepth = [],
    countTokens,
    seed = '',
  } = options;

  const userName = options.userName ?? persona?.name ?? 'User';
  const maxContext = preset.openai_max_context ?? 4095;
  const maxResponse = preset.openai_max_tokens ?? 300;

  const env: MacroEnvironment = {
    char: character.name,
    user: userName,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    persona: persona?.description ?? '',
    mesExamples: character.mes_example,
    charVersion: character.character_version,
    charPrompt: character.system_prompt,
    charJailbreak: character.post_history_instructions,
    creatorNotes: character.creator_notes,
    maxContext,
    maxResponse,
    lastMessage: messages[messages.length - 1]?.mes ?? '',
    lastUserMessage: [...messages].reverse().find((m) => m.is_user)?.mes ?? '',
    lastCharMessage: [...messages].reverse().find((m) => !m.is_user)?.mes ?? '',
  };

  const promptsById = new Map<string, Prompt>();
  for (const prompt of preset.prompts ?? []) promptsById.set(prompt.identifier, prompt);

  /** Content for the marker prompts, resolved from live state. */
  const markerContent: Record<string, string> = {
    charDescription: character.description,
    charPersonality: substituteMacros(preset.personality_format ?? '{{personality}}', env, seed),
    scenario: substituteMacros(preset.scenario_format ?? '{{scenario}}', env, seed),
    personaDescription: persona?.description ?? '',
    worldInfoBefore: worldInfoBefore
      ? (preset.wi_format ?? '{0}').replace('{0}', worldInfoBefore)
      : '',
    worldInfoAfter: worldInfoAfter
      ? (preset.wi_format ?? '{0}').replace('{0}', worldInfoAfter)
      : '',
  };

  // --- Budget ------------------------------------------------------------
  let budget = maxContext - maxResponse;
  const tokenCounts: Record<string, number> = {};
  const slots: Slot[] = [];
  const absolutePrompts: DepthInjection[] = [];

  function shouldTrigger(prompt: Prompt): boolean {
    if (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.length) {
      return true;
    }
    return prompt.injection_trigger.includes(generationType);
  }

  /** Resolve a prompt's final text, applying card overrides where allowed. */
  function resolveContent(prompt: Prompt): string {
    if (prompt.identifier === 'main' && !prompt.forbid_overrides && character.system_prompt) {
      return substituteMacros(character.system_prompt, env, seed);
    }
    if (
      prompt.identifier === 'jailbreak' &&
      !prompt.forbid_overrides &&
      character.post_history_instructions
    ) {
      return substituteMacros(character.post_history_instructions, env, seed);
    }

    if (prompt.marker) return substituteMacros(markerContent[prompt.identifier] ?? '', env, seed);
    return substituteMacros(prompt.content ?? '', env, seed);
  }

  // --- Walk the prompt order --------------------------------------------
  const order = getPromptOrder(preset);
  /** Index in `slots` where chat history goes; -1 until we see the marker. */
  let historySlotIndex = -1;
  let examplesSlotIndex = -1;

  for (const entry of order) {
    const prompt = promptsById.get(entry.identifier);
    if (!prompt || !entry.enabled || !shouldTrigger(prompt)) continue;

    // These two are filled after the fixed prompts, once we know the remaining budget.
    if (entry.identifier === 'chatHistory') {
      historySlotIndex = slots.length;
      slots.push({ identifier: 'chatHistory', messages: [], tokens: 0 });
      continue;
    }
    if (entry.identifier === 'dialogueExamples') {
      examplesSlotIndex = slots.length;
      slots.push({ identifier: 'dialogueExamples', messages: [], tokens: 0 });
      continue;
    }

    const content = resolveContent(prompt);
    if (!content.trim()) continue;

    // Absolute prompts leave the ordered flow and are spliced into the history later.
    if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
      absolutePrompts.push({
        depth: prompt.injection_depth ?? DEFAULT_INJECTION_DEPTH,
        order: prompt.injection_order ?? DEFAULT_INJECTION_ORDER,
        role: prompt.role ?? 'system',
        content,
      });
      const tokens = countTokens(content);
      tokenCounts[entry.identifier] = tokens;
      budget -= tokens;
      continue;
    }

    const message: ApiMessage = { role: prompt.role ?? 'system', content };
    const tokens = countTokens(content);

    tokenCounts[entry.identifier] = tokens;
    budget -= tokens;
    slots.push({ identifier: entry.identifier, messages: [message], tokens });
  }

  // --- Example dialogue --------------------------------------------------
  // Admitted whole-block, oldest first; a block that doesn't fit stops the rest.
  if (examplesSlotIndex !== -1) {
    const blocks = parseExampleDialogue(character.mes_example, env);
    const divider = substituteMacros(preset.new_example_chat_prompt ?? '[Example Chat]', env, seed);

    const accepted: ApiMessage[] = [];
    let used = 0;

    for (const block of blocks) {
      const withDivider: ApiMessage[] = [{ role: 'system', content: divider }, ...block];
      const cost = withDivider.reduce((sum, m) => sum + countTokens(m.content), 0);
      if (cost > budget - used) break;
      accepted.push(...withDivider);
      used += cost;
    }

    budget -= used;
    tokenCounts.dialogueExamples = used;
    slots[examplesSlotIndex] = {
      identifier: 'dialogueExamples',
      messages: accepted,
      tokens: used,
    };
  }

  // --- Chat history ------------------------------------------------------
  let droppedMessages = 0;

  if (historySlotIndex !== -1) {
    const namesBehavior = preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT;
    // is_system marks "hidden from prompt" — visible in the transcript, never sent.
    const visible = messages.filter((m) => !m.is_system);

    const newChatMarker = substituteMacros(
      preset.new_chat_prompt ?? '[Start a new Chat]',
      env,
      seed,
    );
    const markerCost = newChatMarker ? countTokens(newChatMarker) : 0;
    budget -= markerCost;

    const packed: ApiMessage[] = [];
    let used = 0;

    // Newest first: keep as much recent context as fits, drop the oldest.
    for (let i = visible.length - 1; i >= 0; i--) {
      const message = visible[i]!;
      const content = substituteMacros(message.mes, env, seed);
      if (!content.trim()) continue;

      const apiMessage: ApiMessage = {
        role: message.is_user ? 'user' : 'assistant',
        content:
          namesBehavior === CHARACTER_NAMES_BEHAVIOR.CONTENT
            ? `${message.name}: ${content}`
            : content,
      };

      if (namesBehavior === CHARACTER_NAMES_BEHAVIOR.COMPLETION) {
        apiMessage.name = sanitizeName(message.name);
      }

      const cost = countTokens(apiMessage.content);
      if (cost > budget - used) {
        droppedMessages = i + 1;
        break;
      }

      packed.unshift(apiMessage);
      used += cost;
    }

    budget -= used;

    const withInjections = applyDepthInjections(packed, [...absolutePrompts, ...worldInfoDepth]);
    const history = newChatMarker
      ? [{ role: 'system' as const, content: newChatMarker }, ...withInjections]
      : withInjections;

    tokenCounts.chatHistory = used;
    slots[historySlotIndex] = {
      identifier: 'chatHistory',
      messages: history,
      tokens: used + markerCost,
    };
  }

  // --- Flatten -----------------------------------------------------------
  let final = slots.flatMap((slot) => slot.messages);

  // Continue reshapes the finished array: the nudge has to be the last instruction, and
  // a prefill has to be the last message outright.
  if (generationType === 'continue') final = applyContinue(final, preset, env, seed);

  if (preset.squash_system_messages) final = squashSystemMessages(final);

  const totalTokens = final.reduce((sum, m) => sum + countTokens(m.content), 0);

  return { messages: final, tokenCounts, totalTokens, droppedMessages };
}
