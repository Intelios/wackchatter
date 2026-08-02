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
import {
  type ApiMessage,
  type AuthorNoteSettings,
  type ChatMessage,
  DEFAULT_AUTHOR_NOTE,
  type MacroVariableMap,
  type MacroWarning,
  type PersistentGuide,
  type Persona,
} from '../types/chat.ts';
import type { GenerationType, Preset, Prompt } from '../types/preset.ts';
import {
  CHARACTER_NAMES_BEHAVIOR,
  DEFAULT_INJECTION_DEPTH,
  DEFAULT_INJECTION_ORDER,
  INJECTION_POSITION,
} from '../types/preset.ts';
import { DEFAULT_GUIDANCE, type GuidanceSettings } from '../types/settings.ts';
import {
  type MacroEnvironment,
  type MacroRuntime,
  createMacroRuntime,
  substituteMacros,
} from './macros.ts';
import { getPromptOrder } from './preset-io.ts';
import type { TokenCounter } from './token-cache.ts';

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
  /** Present, including an empty string, means this chat overrides the card scenario. */
  scenarioOverride?: string;
  authorNote?: Partial<AuthorNoteSettings>;
  /** Standing per-chat instructions, injected on every generation. */
  guides?: PersistentGuide[];
  /**
   * Raw composer text for a guided generation. Absent or blank means an ordinary one.
   *
   * Never part of the transcript: the whole point of guiding a reply is to steer it
   * without writing a turn nobody wanted to read.
   */
  guidance?: string;
  guidanceSettings?: Partial<GuidanceSettings>;
  localVariables?: MacroVariableMap;
  globalVariables?: MacroVariableMap;
  countTokens: TokenCounter;
  /** Stabilises {{pick}} across regenerations. */
  seed?: string;
}

export interface DepthInjection {
  depth: number;
  order: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The name used for the user when no persona is set.
 *
 * Shared with the client's message labelling on purpose. These used to disagree — the
 * transcript labelled messages "You" while `{{user}}` expanded to "User" — and with
 * `names_behavior: CONTENT` the label becomes part of the message text, so the prompt
 * would say `You: hello` while the character card was told the user is called User.
 * 'User' wins because cards are written against SillyTavern's default.
 */
export const DEFAULT_USER_NAME = 'User';

/** Where a persona description goes when the position says at-depth. */
const DEFAULT_PERSONA_DEPTH = 2;

export interface ContextOverflow {
  code: 'context_overflow';
  maxContext: number;
  reservedCompletionTokens: number;
  requiredPromptTokens: number;
  overBy: number;
  identifiers: string[];
}

interface AssembleBase {
  /** The assembled payload, retained on failure for prompt inspection. */
  messages: ApiMessage[];
  /** Token count per prompt identifier, for the Prompt Manager display. */
  tokenCounts: Record<string, number>;
  totalTokens: number;
  /** Messages dropped because the budget ran out. */
  droppedMessages: number;
  macroWarnings: MacroWarning[];
  variableUpdates: {
    local: MacroVariableMap;
    global: MacroVariableMap;
    localChanged: boolean;
    globalChanged: boolean;
  };
}

export type AssembleResult =
  | (AssembleBase & { ok: true })
  | (AssembleBase & { ok: false; error: ContextOverflow });

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
export function parseExampleDialogue(
  raw: string,
  env: MacroEnvironment,
  options: { seed?: string; runtime?: MacroRuntime; source?: string } = {},
): ApiMessage[][] {
  if (!raw?.trim()) return [];

  const blocks = raw
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const messages: ApiMessage[] = [];
      // Split on a name prefix at the start of a line, keeping the delimiter.
      const parts = block.split(/^(?=\s*(?:\{\{(?:user|char)\}\}|<(?:USER|BOT|CHAR)>)\s*:)/gim);

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const match = /^(?:\{\{(user|char)\}\}|<(USER|BOT|CHAR)>)\s*:\s*([\s\S]*)$/i.exec(trimmed);
        if (!match) continue;

        const speaker = (match[1] ?? match[2] ?? '').toLowerCase();
        const isUser = speaker === 'user';
        const content = substituteMacros(match[3]!.trim(), env, options.seed, {
          runtime: options.runtime,
          source: options.source ?? 'dialogueExamples',
        });
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

  // Depth is measured against the original chat, not the growing result. Iterating from
  // shallow to deep without this is what used to put D1 after m2 once D0 existed.
  const result = [...history];
  const originalLength = history.length;
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  for (const depth of depths) {
    const group = byDepth.get(depth)!;
    // Higher injection_order goes first at the same depth.
    const roleOrder = { system: 0, user: 1, assistant: 2 } as const;
    group.sort((a, b) => b.order - a.order || roleOrder[a.role] - roleOrder[b.role]);

    const index = Math.max(0, originalLength - depth);
    result.splice(index, 0, ...group.map((item) => ({ role: item.role, content: item.content })));
  }

  return result;
}

/** Coalesce injections with one wire position, exactly as prompt managers do. */
function groupDepthInjections(injections: DepthInjection[]): DepthInjection[] {
  const grouped = new Map<string, DepthInjection & { contents: string[] }>();

  for (const injection of injections) {
    const key = `${injection.depth}\u0000${injection.order}\u0000${injection.role}`;
    const existing = grouped.get(key);
    if (existing) existing.contents.push(injection.content);
    else grouped.set(key, { ...injection, contents: [injection.content] });
  }

  return [...grouped.values()].map(({ contents, ...injection }) => ({
    ...injection,
    content: contents.join('\n'),
  }));
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
  nudge: string,
  forceNudge = false,
): ApiMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  if (lastAssistant === -1) {
    // The nudge is a continuation control, not transcript history. Keep it in the
    // mandatory shape if a reply exists in the source transcript but was pruned for
    // context; otherwise the budgeter could incorrectly declare the request affordable.
    if (!forceNudge || preset.continue_prefill) return messages;

    return nudge ? [...messages, { role: 'system' as const, content: nudge }] : messages;
  }

  const postfix = preset.continue_postfix ?? ' ';

  if (preset.continue_prefill) {
    const partial = messages[lastAssistant]!;
    const rest = messages.filter((_, index) => index !== lastAssistant);
    return [...rest, { ...partial, content: `${partial.content}${postfix}` }];
  }

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
    scenarioOverride,
    authorNote: authorNoteInput,
    guides = [],
    guidance = '',
    guidanceSettings,
    localVariables = {},
    globalVariables = {},
    countTokens,
    seed = '',
  } = options;

  const userName = options.userName ?? persona?.name ?? DEFAULT_USER_NAME;
  const maxContext = preset.openai_max_context ?? 4095;
  const maxResponse = preset.openai_max_tokens ?? 300;
  const runtime = createMacroRuntime(localVariables, globalVariables);
  const effectiveScenario = scenarioOverride !== undefined ? scenarioOverride : character.scenario;

  const env: MacroEnvironment = {
    char: character.name,
    user: userName,
    description: character.description,
    personality: character.personality,
    scenario: effectiveScenario,
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

  const substitute = (text: string, source: string, extra?: MacroEnvironment['extra']): string =>
    substituteMacros(text, extra ? { ...env, extra } : env, seed, {
      runtime,
      source,
    });

  const variableUpdates = () => ({
    local: { ...runtime.local },
    global: { ...runtime.global },
    localChanged: runtime.localChanged,
    globalChanged: runtime.globalChanged,
  });

  const promptsById = new Map<string, Prompt>();
  for (const prompt of preset.prompts ?? []) promptsById.set(prompt.identifier, prompt);

  // Where the persona description goes. `{{persona}}` keeps expanding whatever this says,
  // as it does in ST — otherwise a preset that references the macro would break the
  // moment somebody changed a dropdown.
  const personaPosition = persona?.position ?? 'inPrompt';
  const personaText = persona?.description?.trim() ? persona.description : '';
  const authorNote: AuthorNoteSettings = { ...DEFAULT_AUTHOR_NOTE, ...authorNoteInput };
  const userTurnCount = messages.filter((message) => message.is_user).length;
  const noteActive =
    authorNote.interval > 0 &&
    userTurnCount > 0 &&
    userTurnCount % Math.max(1, Math.floor(authorNote.interval)) === 0;
  const noteParts = noteActive
    ? [
        ...(personaPosition === 'topAuthorNote' && personaText ? [personaText] : []),
        ...(authorNote.text.trim() ? [authorNote.text] : []),
        ...(personaPosition === 'bottomAuthorNote' && personaText ? [personaText] : []),
      ]
    : [];
  const authorNoteText = noteParts.join('\n');

  /** Content for the marker prompts, resolved from live state. */
  const markerContent: Record<string, string> = {
    charDescription: character.description,
    charPersonality: preset.personality_format ?? '{{personality}}',
    scenario: preset.scenario_format ?? '{{scenario}}',
    // Suppressed for the other two positions: at-depth ships it as an injection below,
    // and 'none' means the description exists for the macro but is not sent on its own.
    personaDescription: personaPosition === 'inPrompt' ? personaText : '',
    worldInfoBefore: worldInfoBefore
      ? (preset.wi_format ?? '{0}').replace('{0}', worldInfoBefore)
      : '',
    worldInfoAfter: worldInfoAfter
      ? (preset.wi_format ?? '{0}').replace('{0}', worldInfoAfter)
      : '',
  };

  // --- Materialise fixed prompt collections -----------------------------
  const tokenCounts: Record<string, number> = {};
  const slots: Slot[] = [];
  const absolutePrompts: DepthInjection[] = [];
  const mandatoryIdentifiers: string[] = [];
  // gpt-tokenizer includes completion priming in every whole-chat count. Subtract it
  // when assigning an individual message to a prompt slot, then charge it once in the
  // final assembled payload.
  const replyPriming = countTokens.countChat([]);
  const messageCost = (message: ApiMessage) => countTokens.countChat([message]) - replyPriming;

  function shouldTrigger(prompt: Prompt): boolean {
    if (!Array.isArray(prompt.injection_trigger) || !prompt.injection_trigger.length) {
      return true;
    }
    return prompt.injection_trigger.includes(generationType);
  }

  let authorNoteAdded = false;
  const authorNoteIsRelative = Boolean(authorNoteText) && authorNote.position !== 'atDepth';

  function addRelativeAuthorNote(index = slots.length): void {
    if (authorNoteAdded || !authorNoteIsRelative) return;
    authorNoteAdded = true;
    const content = substitute(authorNoteText, 'authorNote');
    if (!content.trim()) return;
    const message: ApiMessage = { role: authorNote.role, content };
    const tokens = messageCost(message);
    tokenCounts.authorNote = tokens;
    mandatoryIdentifiers.push('authorNote');
    slots.splice(index, 0, { identifier: 'authorNote', messages: [message], tokens });
  }

  /** Resolve a prompt's final text, applying card overrides where allowed. */
  function resolveContent(prompt: Prompt): string {
    if (prompt.identifier === 'main' && !prompt.forbid_overrides && character.system_prompt) {
      const original = substitute(prompt.content ?? '', 'prompt:main:original');
      let originalUsed = false;
      return substitute(character.system_prompt, 'prompt:main:override', {
        original: () => {
          if (originalUsed) return '';
          originalUsed = true;
          return original;
        },
      });
    }
    if (
      prompt.identifier === 'jailbreak' &&
      !prompt.forbid_overrides &&
      character.post_history_instructions
    ) {
      const original = substitute(prompt.content ?? '', 'prompt:jailbreak:original');
      let originalUsed = false;
      return substitute(character.post_history_instructions, 'prompt:jailbreak:override', {
        original: () => {
          if (originalUsed) return '';
          originalUsed = true;
          return original;
        },
      });
    }

    if (prompt.marker) {
      return substitute(markerContent[prompt.identifier] ?? '', `prompt:${prompt.identifier}`);
    }
    return substitute(prompt.content ?? '', `prompt:${prompt.identifier}`);
  }

  // --- Walk the prompt order --------------------------------------------
  const order = getPromptOrder(preset);
  const hasScenarioAnchor = order.some((entry) => {
    const prompt = promptsById.get(entry.identifier);
    return (
      entry.identifier === 'scenario' && entry.enabled && Boolean(prompt) && shouldTrigger(prompt!)
    );
  });
  /** Index in `slots` where chat history goes; -1 until we see the marker. */
  let historySlotIndex = -1;
  let examplesSlotIndex = -1;

  for (const entry of order) {
    const prompt = promptsById.get(entry.identifier);
    if (!prompt || !entry.enabled || !shouldTrigger(prompt)) continue;

    if (
      authorNoteIsRelative &&
      ((entry.identifier === 'scenario' &&
        authorNote.position === 'beforeScenario' &&
        prompt.injection_position !== INJECTION_POSITION.ABSOLUTE) ||
        (!hasScenarioAnchor && entry.identifier === 'chatHistory'))
    ) {
      addRelativeAuthorNote();
    }

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
    if (!content.trim()) {
      if (entry.identifier === 'scenario' && authorNoteIsRelative) {
        // An empty scenario has no usable anchor. Put the note immediately before
        // history, even when the scenario marker itself was ordered after it.
        addRelativeAuthorNote(historySlotIndex >= 0 ? historySlotIndex : slots.length);
      }
      continue;
    }

    // Absolute prompts leave the ordered flow and are spliced into the history later.
    if (prompt.injection_position === INJECTION_POSITION.ABSOLUTE) {
      const injection: DepthInjection = {
        depth: prompt.injection_depth ?? DEFAULT_INJECTION_DEPTH,
        order: prompt.injection_order ?? DEFAULT_INJECTION_ORDER,
        role: prompt.role ?? 'system',
        content,
      };
      absolutePrompts.push(injection);
      const tokens = messageCost({ role: injection.role, content: injection.content });
      tokenCounts[entry.identifier] = tokens;
      mandatoryIdentifiers.push(entry.identifier);
      if (entry.identifier === 'scenario' && authorNoteIsRelative && !authorNoteAdded) {
        authorNoteAdded = true;
        const noteContent = substitute(authorNoteText, 'authorNote');
        if (noteContent.trim()) {
          const noteInjection: DepthInjection = {
            depth: injection.depth,
            order: injection.order + (authorNote.position === 'beforeScenario' ? 1 : -1),
            role: authorNote.role,
            content: noteContent,
          };
          absolutePrompts.push(noteInjection);
          tokenCounts.authorNote = messageCost({
            role: noteInjection.role,
            content: noteInjection.content,
          });
          mandatoryIdentifiers.push('authorNote');
        }
      }
      continue;
    }

    const message: ApiMessage = { role: prompt.role ?? 'system', content };
    const tokens = messageCost(message);

    tokenCounts[entry.identifier] = tokens;
    mandatoryIdentifiers.push(entry.identifier);
    slots.push({ identifier: entry.identifier, messages: [message], tokens });

    if (entry.identifier === 'scenario' && authorNote.position === 'afterScenario') {
      addRelativeAuthorNote();
    }
  }

  addRelativeAuthorNote();

  // --- Depth injections --------------------------------------------------
  // Everything spliced into the history rather than ordered around it: world info at
  // at-depth, and a persona positioned the same way.
  //
  // Macros are substituted HERE and nowhere else. The activation engine deliberately
  // leaves content raw, so an at-depth entry containing {{char}} expands exactly once,
  // in the same place a before/after entry does. Charging the tokens here — with the
  // other fixed content, before examples and history pack — is the other half: history
  // used to pack against a budget that had never seen the lore it was sharing space with.
  const depthInjections: DepthInjection[] = [];
  for (const injection of worldInfoDepth) {
    const content = substitute(injection.content, 'worldInfoDepth');
    if (!content.trim()) continue;
    depthInjections.push({ ...injection, content });
  }

  if (personaPosition === 'atDepth' && personaText) {
    const content = substitute(personaText, 'personaDescription');
    if (content.trim()) {
      depthInjections.push({
        depth: persona?.depth ?? DEFAULT_PERSONA_DEPTH,
        order: DEFAULT_INJECTION_ORDER,
        role: persona?.role ?? 'system',
        content,
      });
    }
  }

  let resolvedAuthorNoteDepth = '';
  if (authorNoteText && authorNote.position === 'atDepth') {
    resolvedAuthorNoteDepth = substitute(authorNoteText, 'authorNote');
    if (resolvedAuthorNoteDepth.trim()) {
      depthInjections.push({
        depth: Math.max(0, Math.floor(authorNote.depth)),
        order: DEFAULT_INJECTION_ORDER,
        role: authorNote.role,
        content: resolvedAuthorNoteDepth,
      });
    }
  }

  /*
   * Guided Generations. Pushed last, which is what decides the reading order when several
   * sources land on one wire position: `groupDepthInjections` joins collisions in array
   * order, so world info and the note set the scene, the standing guides follow, and the
   * one-shot steer is the final line.
   *
   * Each guide is its own push even though they share a depth, order and role and will be
   * coalesced anyway — that is what gives every guide its own macro-warning source, so a
   * broken `{{macro}}` names the guide it came from instead of a merged blob.
   */
  const guidanceConfig: GuidanceSettings = { ...DEFAULT_GUIDANCE, ...guidanceSettings };

  let guideTokens = 0;
  for (const guide of guides) {
    if (!guide.enabled) continue;
    const content = substitute(guide.text, `guide:${guide.id}`);
    if (!content.trim()) continue;

    const injection: DepthInjection = {
      depth: Math.max(0, Math.floor(guidanceConfig.guideDepth)),
      order: DEFAULT_INJECTION_ORDER,
      role: guidanceConfig.guideRole,
      content,
    };
    depthInjections.push(injection);
    guideTokens += messageCost({ role: injection.role, content: injection.content });
  }

  let resolvedGuidance = '';
  if (guidance.trim()) {
    // {{input}} rides the `extra` hook, the same mechanism {{original}} uses for card
    // overrides. That is one macro pass over the template, so text the user typed is
    // placed rather than re-scanned — a {{setvar}} in the composer cannot mutate state.
    const filled = substitute(guidanceConfig.template, 'guidance', { input: guidance });
    if (filled.trim()) {
      resolvedGuidance = filled;
      depthInjections.push({
        depth: Math.max(0, Math.floor(guidanceConfig.depth)),
        order: DEFAULT_INJECTION_ORDER,
        role: guidanceConfig.role,
        content: filled,
      });
    }
  }

  const groupedInjections = groupDepthInjections([...absolutePrompts, ...depthInjections]);
  const depthTokens = groupedInjections.reduce(
    (sum, injection) => sum + messageCost({ role: injection.role, content: injection.content }),
    0,
  );
  if (groupedInjections.length > 0) {
    tokenCounts.worldInfoDepth = depthTokens;
    if (resolvedAuthorNoteDepth) {
      tokenCounts.authorNote = messageCost({
        role: authorNote.role,
        content: resolvedAuthorNoteDepth,
      });
    }
    // Their own keys rather than folded into worldInfoDepth, which is already the sum over
    // every grouped injection. Extending that over-count would make both numbers useless.
    if (guideTokens > 0) tokenCounts.guides = guideTokens;
    if (resolvedGuidance) {
      tokenCounts.guidance = messageCost({
        role: guidanceConfig.role,
        content: resolvedGuidance,
      });
    }
    mandatoryIdentifiers.push('worldInfoDepth');
    if (resolvedAuthorNoteDepth) mandatoryIdentifiers.push('authorNote');
    if (guideTokens > 0) mandatoryIdentifiers.push('guides');
    if (resolvedGuidance) mandatoryIdentifiers.push('guidance');
  }

  const newChatMarker =
    historySlotIndex === -1
      ? ''
      : substitute(preset.new_chat_prompt ?? '[Start a new Chat]', 'newChatPrompt');
  if (newChatMarker) mandatoryIdentifiers.push('chatHistory');
  const hasContinuableAssistant = messages.some(
    (message) => !message.is_user && !message.is_system && Boolean(message.mes.trim()),
  );
  const continueNudge =
    generationType === 'continue' && !preset.continue_prefill
      ? substitute(
          preset.continue_nudge_prompt ??
            '[Continue your last message without repeating its original content.]',
          'continueNudge',
        )
      : '';
  const sendIfEmpty = preset.send_if_empty?.trim()
    ? substitute(preset.send_if_empty, 'sendIfEmpty')
    : '';

  /** Build and normalise the exact message array that would be sent to the provider. */
  function materialize(
    examples: ApiMessage[],
    packedHistory: ApiMessage[],
    includeSendIfEmpty = false,
  ): ApiMessage[] {
    const history = [
      ...(newChatMarker ? [{ role: 'system' as const, content: newChatMarker }] : []),
      ...applyDepthInjections(packedHistory, groupedInjections),
    ];
    if (includeSendIfEmpty && sendIfEmpty && history.at(-1)?.role === 'assistant') {
      history.push({ role: 'user', content: sendIfEmpty });
    }

    let final = slots.flatMap((slot) => {
      if (slot.identifier === 'dialogueExamples')
        return examples.map((message) => ({ ...message }));
      if (slot.identifier === 'chatHistory') return history.map((message) => ({ ...message }));
      return slot.messages.map((message) => ({ ...message }));
    });

    // A disabled history marker still needs a home for absolute/depth injections.
    if (historySlotIndex === -1 && groupedInjections.length) {
      final = [...final, ...applyDepthInjections([], groupedInjections)];
    }

    if (generationType === 'continue') {
      final = applyContinue(final, preset, continueNudge, hasContinuableAssistant);
    }
    if (preset.squash_system_messages) final = squashSystemMessages(final);
    return final;
  }

  const fixed = materialize([], []);
  const fixedTokens = countTokens.countChat(fixed);
  const maxPromptTokens = maxContext - maxResponse;
  if (fixedTokens > maxPromptTokens) {
    return {
      ok: false,
      messages: fixed,
      tokenCounts,
      totalTokens: fixedTokens,
      droppedMessages: 0,
      macroWarnings: [...runtime.warnings],
      variableUpdates: variableUpdates(),
      error: {
        code: 'context_overflow',
        maxContext,
        reservedCompletionTokens: maxResponse,
        requiredPromptTokens: fixedTokens,
        overBy: fixedTokens - maxPromptTokens,
        identifiers: mandatoryIdentifiers,
      },
    };
  }

  // --- Optional example dialogue ----------------------------------------
  const acceptedExamples: ApiMessage[] = [];
  if (examplesSlotIndex !== -1) {
    const blocks = parseExampleDialogue(character.mes_example, env, {
      seed,
      runtime,
      source: 'dialogueExamples',
    });
    const divider = substitute(
      preset.new_example_chat_prompt ?? '[Example Chat]',
      'newExampleChatPrompt',
    );

    for (const block of blocks) {
      const candidate = [{ role: 'system' as const, content: divider }, ...block];
      const next = [...acceptedExamples, ...candidate];
      if (countTokens.countChat(materialize(next, [])) > maxPromptTokens) break;
      acceptedExamples.push(...candidate);
    }
    tokenCounts.dialogueExamples = acceptedExamples.reduce(
      (sum, message) => sum + messageCost(message),
      0,
    );
  }

  // --- Optional chat history ---------------------------------------------
  const namesBehavior = preset.names_behavior ?? CHARACTER_NAMES_BEHAVIOR.DEFAULT;
  const visible = messages.filter((message) => !message.is_system);
  const packedHistory: ApiMessage[] = [];
  let droppedMessages = 0;

  if (historySlotIndex !== -1) {
    for (let i = visible.length - 1; i >= 0; i--) {
      const message = visible[i]!;
      const content = substitute(message.mes, `message:${message.id}`);
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

      const candidate = [apiMessage, ...packedHistory];
      if (countTokens.countChat(materialize(acceptedExamples, candidate)) > maxPromptTokens) {
        droppedMessages = i + 1;
        break;
      }
      packedHistory.unshift(apiMessage);
    }
  }

  const historyTailRole = [
    ...(newChatMarker ? [{ role: 'system' as const, content: newChatMarker }] : []),
    ...applyDepthInjections(packedHistory, groupedInjections),
  ].at(-1)?.role;
  const canIncludeSendIfEmpty =
    Boolean(sendIfEmpty) &&
    historyTailRole === 'assistant' &&
    countTokens.countChat(materialize(acceptedExamples, packedHistory, true)) <= maxPromptTokens;
  const final = materialize(acceptedExamples, packedHistory, canIncludeSendIfEmpty);
  const totalTokens = countTokens.countChat(final);
  tokenCounts.chatHistory = packedHistory.reduce((sum, message) => sum + messageCost(message), 0);
  if (newChatMarker)
    tokenCounts.chatHistory += messageCost({ role: 'system', content: newChatMarker });
  if (canIncludeSendIfEmpty && sendIfEmpty) {
    tokenCounts.emptyUserMessageReplacement = messageCost({ role: 'user', content: sendIfEmpty });
  }
  tokenCounts.replyPriming = replyPriming;

  return {
    ok: true,
    messages: final,
    tokenCounts,
    totalTokens,
    droppedMessages,
    macroWarnings: [...runtime.warnings],
    variableUpdates: variableUpdates(),
  };
}
