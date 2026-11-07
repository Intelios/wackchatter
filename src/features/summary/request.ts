/**
 * What the classic summary sends, as pure functions. None of the chat's preset goes in: no
 * roleplay instructions, no lore, no samplers. It gets its own instructions, who the
 * characters are, the memory so far and the new part of the chat, written out as a
 * transcript so the model reads it rather than carrying on with it.
 *
 * Regex scripts still run over the chat lines, the way they run for a reply: a preset that
 * strips a repeated world-state or inventory block strips it here too.
 */

import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { regexDepths } from '@shared/regex/depth.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ApiMessage, ChatMessage, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import { REGEX_PLACEMENT, type RegexScript } from '@shared/types/regex.ts';
import type { SummarySettings } from '@shared/types/settings.ts';

export interface SummaryCast {
  char: string;
  user: string;
  /** The card's description (and scenario, when it has one), names filled in. */
  charText: string;
  /** The persona's description, names filled in. */
  userText: string;
}

/** Fill `{{char}}` and `{{user}}`, the only macros a description needs here. */
function names(text: string, char: string, user: string): string {
  return text.replace(/\{\{char\}\}/gi, char).replace(/\{\{user\}\}/gi, user);
}

export function summaryCast(
  character: Pick<CardDataV2, 'name' | 'description' | 'scenario'>,
  persona: Pick<Persona, 'name' | 'description'> | null,
  userName: string,
): SummaryCast {
  const char = character.name;
  const user = persona?.name || userName;
  const charText = [character.description, character.scenario && `Scenario: ${character.scenario}`]
    .filter((part) => part?.trim())
    .join('\n\n');
  return {
    char,
    user,
    charText: names(charText, char, user).trim(),
    userText: names(persona?.description ?? '', char, user).trim(),
  };
}

/** The instructions, with `{{words}}`, `{{char}}` and `{{user}}` filled in. */
export function summaryInstructions(prompt: string, targetWords: number, cast: SummaryCast) {
  return names(prompt.replaceAll('{{words}}', String(targetWords)), cast.char, cast.user);
}

/**
 * The chat as transcript lines, `Name: text`, after the prompt-side regex scripts. A line a
 * script empties is left out, as it would be from a reply's prompt.
 */
export function transcriptLines(
  messages: readonly ChatMessage[],
  scripts: readonly RegexScript[] = [],
): { message: ChatMessage; line: string }[] {
  const depths = scripts.length
    ? regexDepths(messages.map((message) => ({ ...message, is_system: false })))
    : null;
  const cache = createRegexCompileCache();
  return messages.flatMap((message) => {
    const text = depths
      ? applyRegexScripts(
          message.mes,
          scripts,
          {
            placement: message.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
            prompt: true,
            depth: depths.get(message.id),
          },
          { cache },
        )
      : message.mes;
    return text.trim() ? [{ message, line: `${message.name}: ${text.trim()}` }] : [];
  });
}

/** One request: the instructions, then everything to read in a single message. */
export function summaryMessages(input: {
  instructions: string;
  cast: SummaryCast;
  /** The memory so far, or empty to write the first one. */
  memory: string;
  lines: readonly string[];
}): ApiMessage[] {
  const { cast } = input;
  const who = [
    `## ${cast.char}`,
    cast.charText || '(No description.)',
    '',
    `## ${cast.user}`,
    cast.userText || '(No description.)',
  ].join('\n');
  const memory = input.memory.trim()
    ? `<memory_so_far>\n${input.memory.trim()}\n</memory_so_far>`
    : 'There is no memory yet. Write the first one from this part of the chat.';
  const content = [
    `<characters>\n${who}\n</characters>`,
    memory,
    `<new_chat>\n${input.lines.join('\n\n')}\n</new_chat>`,
    'Write the updated memory now.',
  ].join('\n\n');
  return [
    { role: 'system', content: input.instructions },
    { role: 'user', content },
  ];
}

/** Room kept free for the summary itself; reserved, never sent as a cap. */
export function summaryReserve(settings: Pick<SummarySettings, 'targetWords'>): number {
  return Math.ceil(settings.targetWords * 2) + 512;
}

/**
 * How many of `lines` fit in one request. Estimated per line, then checked against the
 * whole request and shrunk until it fits, since joins and wrapping cost a little extra.
 * Zero means not even the first line fits.
 */
export function linesThatFit(options: {
  lines: readonly string[];
  budget: number;
  counter: TokenCounter;
  build: (lines: readonly string[]) => ApiMessage[];
}): number {
  const { lines, budget, counter, build } = options;
  let room = budget - counter.countChat(build([]));
  let count = 0;
  for (const line of lines) {
    const cost = counter.countText(line) + 2;
    if (room - cost < 0) break;
    room -= cost;
    count++;
  }
  while (count > 0 && counter.countChat(build(lines.slice(0, count))) > budget) count--;
  return count;
}

/** The summary's samplers and context as a preset for the request body: nothing else in it. */
export function summaryPreset(settings: SummarySettings): Preset {
  return {
    ...createDefaultPreset(),
    temperature: settings.temperature,
    top_p: settings.topP,
    openai_max_context: settings.contextTokens,
    stream_openai: false,
  };
}
