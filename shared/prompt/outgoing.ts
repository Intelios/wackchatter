/**
 * Macro resolution for text the user just typed.
 *
 * The exact opposite of `greeting.ts`, and deliberately not in it. There, every entry point
 * throws its runtime away, because rendering must never write. Here the write is the point:
 * this runs once, at the moment a draft leaves the composer, and a `{{setvar}}` in that
 * draft is meant to set the variable.
 *
 * Resolving at send is SillyTavern's behaviour (`sendMessageAsUser` stores
 * `substituteParams(messageText)`), and the reason is worth stating: assembly re-substitutes
 * every stored message on every request, so a `{{roll:1d20}}` left unresolved in the
 * transcript is a different number in every swipe and regenerate, and the transcript shows
 * none of them. Resolving once makes the number a fact about the turn rather than about the
 * request that happened to carry it.
 *
 * Editing a message does NOT come through here. An edit is repair, not composition, and it
 * is the one place someone needs to be able to put `{{char}}` into history and have it stay.
 */

import type { MacroVariableMap } from '../types/chat.ts';
import { type ChatMacroOptions, chatEnvironment } from './environment.ts';
import { createMacroRuntime, substituteMacros } from './macros.ts';

export interface OutgoingMacroResult {
  text: string;
  /** The chat's variables after the pass. Only worth persisting when `localChanged`. */
  local: MacroVariableMap;
  global: MacroVariableMap;
  localChanged: boolean;
  globalChanged: boolean;
}

/**
 * Resolve a draft and report what its macros did to the variable maps.
 *
 * The caller commits: this returns the new maps rather than writing them, exactly as
 * `assemblePrompt` does, so the one place that knows whether the send actually went ahead
 * is the one place that persists.
 */
export function resolveOutgoingMacros(
  text: string,
  options: ChatMacroOptions,
): OutgoingMacroResult {
  const local = options.metadata?.variables ?? {};
  const global = options.globalVariables ?? {};
  const runtime = createMacroRuntime(local, global);
  const resolved = substituteMacros(text, chatEnvironment(options), options.seed ?? '', {
    runtime,
    source: 'message',
  });

  return {
    text: resolved,
    local: runtime.local,
    global: runtime.global,
    localChanged: runtime.localChanged,
    globalChanged: runtime.globalChanged,
  };
}
