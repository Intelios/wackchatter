/**
 * Macro resolution for the display path.
 *
 * Everything here runs while rendering the transcript, which is why every entry point
 * builds a FRESH runtime and throws it away: a `{{setvar}}` in a greeting or in a regex
 * script's replacement would otherwise fire on every render, and scrolling would quietly
 * rewrite the chat's variables. The prompt path deliberately does the opposite — there the
 * runtime is assembly's, and the write is the point.
 */

import type { RegexMacros } from '../regex/engine.ts';
import { sanitizeRegexMacro } from '../regex/engine.ts';
import { type ChatMacroOptions, chatEnvironment } from './environment.ts';
import { createMacroRuntime, substituteMacros } from './macros.ts';

/** Kept as the display path's own name for the shared options; see `environment.ts`. */
export type GreetingMacroOptions = ChatMacroOptions;

/** Resolve a greeting for display while leaving its stored text and all variable maps untouched. */
export function resolveGreetingMacros(text: string, options: GreetingMacroOptions): string {
  return substituteMacros(text, chatEnvironment(options), options.seed ?? '', {
    runtime: createMacroRuntime(options.metadata?.variables ?? {}, options.globalVariables ?? {}),
    source: 'greeting',
  });
}

/**
 * Macro hooks for regex scripts on the display path.
 *
 * The runtime is built once per call and never read back, so a script whose replacement
 * contains `{{setvar}}` can write to it all it likes and nothing survives the render. On
 * the prompt path the same script really does set the variable, which is SillyTavern's
 * behaviour and the reason these two are built in different places.
 */
export function createDisplayRegexMacros(options: GreetingMacroOptions): RegexMacros {
  const env = chatEnvironment(options);
  const seed = options.seed ?? '';
  const local = options.metadata?.variables ?? {};
  const global = options.globalVariables ?? {};

  return {
    expand: (text, source) =>
      substituteMacros(text, env, seed, { runtime: createMacroRuntime(local, global), source }),
    expandEscaped: (text, source) =>
      substituteMacros(text, env, seed, {
        runtime: createMacroRuntime(local, global),
        source,
        postProcess: sanitizeRegexMacro,
      }),
  };
}
