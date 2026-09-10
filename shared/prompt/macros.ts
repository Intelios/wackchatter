import type { MacroValue, MacroVariableMap, MacroWarning } from '../types/chat.ts';
import { rollDice } from './dice.ts';

/**
 * Macro substitution.
 *
 * Critically, this runs per prompt object and per chat message at the moment each is
 * materialised — never as one pass over a finished, concatenated prompt. That ordering
 * is load-bearing: {{random}} must re-roll per occurrence, and token counts are only
 * accurate when taken after substitution.
 */

export interface MacroEnvironment {
  char: string;
  groupNames?: string;
  user: string;
  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  mesExamples?: string;
  charVersion?: string;
  charPrompt?: string;
  charJailbreak?: string;
  creatorNotes?: string;
  model?: string;
  /** Filled in by the caller for context-dependent macros. */
  lastMessage?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  maxContext?: number;
  maxResponse?: number;
  /** Extra one-off macros, e.g. {{original}} when a card overrides a prompt. */
  extra?: Record<string, string | (() => string)>;
}

/** Mutable only within one assembly. The caller decides whether to persist the result. */
export interface MacroRuntime {
  local: MacroVariableMap;
  global: MacroVariableMap;
  localChanged: boolean;
  globalChanged: boolean;
  warnings: MacroWarning[];
  /** Internal de-duplication index. */
  warningKeys: Set<string>;
}

export interface MacroSubstitutionOptions {
  runtime?: MacroRuntime;
  /** Prompt identifier, message id, or synthesized section for diagnostics. */
  source?: string;
  /**
   * Applied to each RESOLVED macro value before it is spliced in — ST's
   * `substituteParamsExtended(text, {}, postProcessFn)`. Regex scripts use it to escape
   * `{{char}}` before it lands inside a find pattern, where a name containing `.` or `(`
   * would otherwise become live syntax.
   *
   * Deliberately NOT applied to the unresolved fallback: a macro the engine could not
   * resolve stays visible as literal `{{...}}` text, and escaping it would turn text the
   * user can read into text they cannot.
   */
  postProcess?: (value: string) => string;
}

export function createMacroRuntime(
  local: MacroVariableMap = {},
  global: MacroVariableMap = {},
): MacroRuntime {
  return {
    local: { ...local },
    global: { ...global },
    localChanged: false,
    globalChanged: false,
    warnings: [],
    warningKeys: new Set(),
  };
}

/**
 * A macro the engine could not resolve. It stays visible as literal `{{...}}` text and is
 * reported to the preview rather than blocking generation — and it never reaches
 * `postProcess`, which is the point of having a sentinel rather than returning the text.
 */
const UNRESOLVED = Symbol('unresolved-macro');

function warn(runtime: MacroRuntime, macro: string, source = 'unknown'): void {
  const key = `${source}\0${macro.toLowerCase()}`;
  if (runtime.warningKeys.has(key)) return;
  runtime.warningKeys.add(key);
  runtime.warnings.push({ macro, source });
}

function macroString(value: MacroValue | undefined): string {
  return value === undefined ? '' : String(value);
}

function numeric(value: MacroValue | undefined): number | null {
  if (value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function storedValue(value: string): MacroValue {
  const parsed = numeric(value);
  return parsed === null ? value : parsed;
}

function variablePair(args: string): [string, string] {
  const doubleColon = args.indexOf('::');
  if (doubleColon !== -1) {
    return [args.slice(0, doubleColon).trim(), args.slice(doubleColon + 2).trim()];
  }

  const whitespace = args.search(/\s/);
  if (whitespace === -1) return [args.trim(), ''];
  return [args.slice(0, whitespace).trim(), args.slice(whitespace).trim()];
}

function variableMap(runtime: MacroRuntime, global: boolean): MacroVariableMap {
  return global ? runtime.global : runtime.local;
}

function markVariableChange(runtime: MacroRuntime, global: boolean): void {
  if (global) runtime.globalChanged = true;
  else runtime.localChanged = true;
}

function setVariable(
  runtime: MacroRuntime,
  global: boolean,
  name: string,
  value: MacroValue,
): void {
  variableMap(runtime, global)[name] = value;
  markVariableChange(runtime, global);
}

function addVariable(
  runtime: MacroRuntime,
  global: boolean,
  name: string,
  raw: string,
): MacroValue {
  const map = variableMap(runtime, global);
  const current = map[name] ?? 0;

  if (typeof current === 'string') {
    try {
      const parsed = JSON.parse(current);
      if (Array.isArray(parsed)) {
        parsed.push(storedValue(raw));
        setVariable(runtime, global, name, JSON.stringify(parsed));
        return map[name]!;
      }
    } catch {
      // A normal string is handled below.
    }
  }

  const left = numeric(current);
  const right = numeric(raw);
  const next = left !== null && right !== null ? left + right : `${macroString(current)}${raw}`;
  setVariable(runtime, global, name, next);
  return next;
}

function changeVariable(
  runtime: MacroRuntime,
  global: boolean,
  name: string,
  delta: number,
): MacroValue {
  return addVariable(runtime, global, name, String(delta));
}

/** Two-digit zero pad. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatTime(date: Date): string {
  const hours = date.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const twelve = hours % 12 || 12;
  return `${twelve}:${pad(date.getMinutes())} ${suffix}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Mirrors SillyTavern's {{roll}}: the total alone, and an empty string for a formula droll
 * would reject. The grammar lives in `dice.ts`, which `/roll` shares — one place decides
 * what `3d6+4` means, so the command and the macro can never disagree about a card.
 */
function roll(spec: string): string {
  const result = rollDice(spec);
  return result === null ? '' : String(result.total);
}

/** Split a {{random}}/{{pick}} argument list on :: or , as SillyTavern accepts both. */
function splitChoices(raw: string): string[] {
  const list = raw.includes('::') ? raw.split('::') : raw.split(',');
  return list.map((item) => item.trim()).filter(Boolean);
}

/**
 * Stable hash, used to seed {{pick}} so a given occurrence resolves the same way across
 * regenerations of the same text — unlike {{random}}, which re-rolls every call.
 *
 * Exported because World Info needs the same trick for probability and group rolls, and
 * two hash functions would mean two ways for "the same chat" to disagree about a seed.
 */
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * The macros whose value is simply read out of the environment, resolved lazily so nothing
 * is computed for a macro the text does not use.
 *
 * A module-level builder rather than a literal inside `substituteMacros` for one reason:
 * `CORE_MACRO_NAMES` below is derived from it, so the macro reference cannot drift from the
 * engine by forgetting to document a name. Keep it that way.
 */
function coreValues(env: MacroEnvironment, now: Date): Record<string, () => string> {
  return {
    char: () => env.char,
    bot: () => env.char,
    user: () => env.user,
    // Not a group chat in V1: {{group}} and {{charIfNotGroup}} both resolve to the char.
    group: () => env.groupNames ?? env.char,
    charifnotgroup: () => env.groupNames ?? env.char,
    description: () => env.description ?? '',
    personality: () => env.personality ?? '',
    scenario: () => env.scenario ?? '',
    persona: () => env.persona ?? '',
    mesexamples: () => env.mesExamples ?? '',
    mesexamplesraw: () => env.mesExamples ?? '',
    charversion: () => env.charVersion ?? '',
    char_version: () => env.charVersion ?? '',
    charprompt: () => env.charPrompt ?? '',
    charjailbreak: () => env.charJailbreak ?? '',
    charinstruction: () => env.charJailbreak ?? '',
    creatornotes: () => env.creatorNotes ?? '',
    model: () => env.model ?? '',
    lastmessage: () => env.lastMessage ?? '',
    lastchatmessage: () => env.lastMessage ?? '',
    lastusermessage: () => env.lastUserMessage ?? '',
    lastcharmessage: () => env.lastCharMessage ?? '',
    maxcontext: () => String(env.maxContext ?? ''),
    maxcontexttokens: () => String(env.maxContext ?? ''),
    maxresponse: () => String(env.maxResponse ?? ''),
    maxresponsetokens: () => String(env.maxResponse ?? ''),
    maxprompt: () => String(Math.max(0, (env.maxContext ?? 0) - (env.maxResponse ?? 0))),
    maxprompttokens: () => String(Math.max(0, (env.maxContext ?? 0) - (env.maxResponse ?? 0))),
    time: () => formatTime(now),
    date: () => `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`,
    weekday: () => WEEKDAYS[now.getDay()]!,
    isotime: () => `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    isodate: () => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    newline: () => '\n',
    noop: () => '',
  };
}

/** Every environment-backed macro name, derived rather than listed. */
export const CORE_MACRO_NAMES: readonly string[] = Object.keys(
  coreValues({ char: '', user: '' }, new Date()),
);

/**
 * Every macro handled by the resolver's switch — the ones that take arguments and do
 * something rather than read a value.
 *
 * This one IS a hand-kept list, because a `switch` has no keys to enumerate. Adding a case
 * below without adding it here is the one way the reference can fall behind the engine, and
 * `macroCatalog.test.ts` will not catch it. Add both, or neither.
 */
export const KEYWORD_MACROS: readonly string[] = [
  'roll',
  'random',
  'pick',
  'reverse',
  'setvar',
  'setglobalvar',
  'addvar',
  'addglobalvar',
  'incvar',
  'incglobalvar',
  'decvar',
  'decglobalvar',
  'getvar',
  'getglobalvar',
  'hasvar',
  'varexists',
  'hasglobalvar',
  'globalvarexists',
  'deletevar',
  'flushvar',
  'deleteglobalvar',
  'flushglobalvar',
];

/**
 * Everything the engine resolves, for the macro reference and its completion box.
 *
 * `{{trim}}` and `{{//}}` are absent on purpose: both are stripped before the resolver ever
 * sees them, so neither has a name here. The catalogue documents them separately.
 */
export const KNOWN_MACROS: readonly string[] = [...CORE_MACRO_NAMES, ...KEYWORD_MACROS];

/**
 * Substitute macros in `text`.
 *
 * @param seed Stabilises {{pick}}. Pass something chat-scoped so a pick stays put.
 */
export function substituteMacros(
  text: string,
  env: MacroEnvironment,
  seed = '',
  options: MacroSubstitutionOptions = {},
): string {
  if (!text) return '';

  const runtime = options.runtime ?? createMacroRuntime();
  const diagnosticSource = options.source ?? 'unknown';

  // SillyTavern's pre-curly legacy identity tokens are still common in older cards.
  const withLegacyNames = text.replace(
    /<(USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/gi,
    (_match, name: string) => (name.toLowerCase() === 'user' ? env.user : env.char),
  );

  // {{trim}} eats the whitespace around its own position. Handled up front, on its own,
  // so the general pass never needs a sentinel value that could collide with real text.
  const source = withLegacyNames.replace(/\s*\{\{trim\}\}\s*/gi, '');
  if (!source) return '';

  const now = new Date();

  const values = coreValues(env, now);

  for (const [key, value] of Object.entries(env.extra ?? {})) {
    values[key.toLowerCase()] = typeof value === 'function' ? value : () => value;
  }

  let pickCounter = 0;

  /**
   * One macro, or UNRESOLVED when the engine could not make sense of it.
   *
   * The sentinel exists so `postProcess` can be applied to resolved values only. Comparing
   * the returned string against `match` would nearly work and would be wrong the one time
   * a variable legitimately holds its own macro text.
   */
  const resolve = (match: string, body: string): string | typeof UNRESOLVED => {
    const raw = String(body).trim();
    if (!raw) return UNRESOLVED;

    // Comments are stripped entirely.
    if (raw.startsWith('//')) return '';

    const separator = raw.search(/[:\s]/);
    const name = (separator === -1 ? raw : raw.slice(0, separator)).toLowerCase();
    const args = separator === -1 ? '' : raw.slice(separator).replace(/^::?/, '').trim();

    switch (name) {
      case 'roll':
        return roll(args);

      case 'random': {
        const choices = splitChoices(args);
        if (!choices.length) return '';
        return choices[Math.floor(Math.random() * choices.length)]!;
      }

      case 'pick': {
        const choices = splitChoices(args);
        if (!choices.length) return '';
        // Seeded on the surrounding text so the same {{pick}} keeps its answer.
        const index = hashString(`${seed}:${raw}:${pickCounter++}`) % choices.length;
        return choices[index]!;
      }

      case 'reverse':
        return args.split('').reverse().join('');

      case 'setvar':
      case 'setglobalvar': {
        const [variable, value] = variablePair(args);
        if (!variable) {
          warn(runtime, match, diagnosticSource);
          return UNRESOLVED;
        }
        setVariable(runtime, name === 'setglobalvar', variable, storedValue(value));
        return '';
      }

      case 'addvar':
      case 'addglobalvar': {
        const [variable, value] = variablePair(args);
        if (!variable) {
          warn(runtime, match, diagnosticSource);
          return UNRESOLVED;
        }
        addVariable(runtime, name === 'addglobalvar', variable, value);
        return '';
      }

      case 'incvar':
      case 'incglobalvar': {
        if (!args.trim()) {
          warn(runtime, match, diagnosticSource);
          return UNRESOLVED;
        }
        return String(changeVariable(runtime, name === 'incglobalvar', args.trim(), 1));
      }

      case 'decvar':
      case 'decglobalvar': {
        if (!args.trim()) {
          warn(runtime, match, diagnosticSource);
          return UNRESOLVED;
        }
        return String(changeVariable(runtime, name === 'decglobalvar', args.trim(), -1));
      }

      case 'getvar':
      case 'getglobalvar':
        return macroString(variableMap(runtime, name === 'getglobalvar')[args.trim()]);

      case 'hasvar':
      case 'varexists':
      case 'hasglobalvar':
      case 'globalvarexists':
        return String(
          Object.hasOwn(
            variableMap(runtime, name === 'hasglobalvar' || name === 'globalvarexists'),
            args.trim(),
          ),
        );

      case 'deletevar':
      case 'flushvar':
      case 'deleteglobalvar':
      case 'flushglobalvar': {
        const global = name === 'deleteglobalvar' || name === 'flushglobalvar';
        const map = variableMap(runtime, global);
        const variable = args.trim();
        if (Object.hasOwn(map, variable)) {
          delete map[variable];
          markVariableChange(runtime, global);
        }
        return '';
      }

      default: {
        const resolver = values[name];
        if (resolver) return resolver();
        warn(runtime, match, diagnosticSource);
        return UNRESOLVED;
      }
    }
  };

  // One pass. Nested macros are not supported, matching the legacy engine.
  const result = source.replace(/\{\{([^{}]*)\}\}/g, (match, body: string) => {
    const value = resolve(match, body);
    if (value === UNRESOLVED) return match;
    return options.postProcess ? options.postProcess(value) : value;
  });

  // Keep diagnostics non-destructive: anything still macro-shaped remains visible in
  // the prompt and is reported to the preview/inspector rather than blocking generation.
  //
  // Only `{{...}}` counts. Angle-bracket tokens are deliberately NOT reported: the five
  // legacy ones are already substituted above, so nothing real can reach here, while
  // `<POV>`, `<RULES>` and friends are ordinary pseudo-XML section markers that presets
  // use constantly. Flagging those trained the warning to mean nothing.
  for (const match of result.match(/\{\{[^{}]*\}\}/g) ?? []) {
    warn(runtime, match, diagnosticSource);
  }

  return result;
}

/** Build a macro environment from the pieces the assembler already has. */
export function createEnvironment(
  overrides: Partial<MacroEnvironment> & Pick<MacroEnvironment, 'char' | 'user'>,
): MacroEnvironment {
  return { ...overrides };
}
