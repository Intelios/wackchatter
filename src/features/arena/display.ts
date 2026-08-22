/**
 * Making a column read the way a chat bubble would.
 *
 * A reply that has not been through the user's regex scripts is not the reply they would
 * see in a chat — a script that strips a `<think>` block or rewrites a speaker prefix is
 * the difference between comparing two models and comparing two raw dumps. So the same
 * display pass runs here, built the same way `useChat` builds it: a disposable macro
 * runtime per call, so a `{{setvar}}` in a replacement writes to nothing.
 *
 * Depth is always 0. The arena's transcript is a scene and one reply, and the reply is
 * always the newest message — there is no scroll position for a depth bound to disagree
 * with, so `regexDepths` has nothing to compute.
 */

import { createDisplayRegexMacros } from '@shared/prompt/greeting.ts';
import { applyRegexScripts, createRegexCompileCache } from '@shared/regex/engine.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage, MacroVariableMap, Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { REGEX_PLACEMENT } from '@shared/types/regex.ts';

export interface ArenaDisplayOptions {
  card: CardDataV2 | null;
  preset: Preset | null;
  persona: Persona | null;
  messages: ChatMessage[];
  globalVariables: MacroVariableMap;
  regexScripts: readonly RegexScript[];
  seed: string;
}

export interface ArenaDisplay {
  output: (text: string) => string;
  reasoning: (text: string) => string;
}

/** The identity transform, for when there is nothing to run — or nothing to run it on. */
export const PASSTHROUGH_DISPLAY: ArenaDisplay = {
  output: (text) => text,
  reasoning: (text) => text,
};

export function createArenaDisplay(options: ArenaDisplayOptions): ArenaDisplay {
  const { card, preset, persona, messages, globalVariables, regexScripts, seed } = options;
  if (!card || !preset || regexScripts.length === 0) return PASSTHROUGH_DISPLAY;

  const macros = createDisplayRegexMacros({
    character: card,
    preset,
    persona,
    messages,
    globalVariables,
    seed,
  });
  // One cache for the whole column set: the same handful of patterns run against every
  // reply, and recompiling them per column is the only cost worth avoiding here.
  const runOptions = { macros, cache: createRegexCompileCache() };

  return {
    output: (text) =>
      applyRegexScripts(
        text,
        regexScripts,
        { placement: REGEX_PLACEMENT.AI_OUTPUT, display: true, depth: 0 },
        runOptions,
      ),
    reasoning: (text) =>
      applyRegexScripts(
        text,
        regexScripts,
        { placement: REGEX_PLACEMENT.REASONING, display: true, depth: 0 },
        runOptions,
      ),
  };
}
