import type { MacroValue, MacroVariableMap, MacroWarning } from '../types/chat.ts';

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

/** Roll NdM or a flat 1..N. Mirrors SillyTavern's {{roll}}. */
function roll(spec: string): string {
  const dice = /^(\d*)d(\d+)$/i.exec(spec.trim());
  if (dice) {
    const count = Number(dice[1] || 1);
    const sides = Number(dice[2]);
    if (!Number.isFinite(count) || !Number.isFinite(sides) || sides < 1) return '';
    let total = 0;
    for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
    return String(total);
  }

  const max = Number(spec.trim());
  if (!Number.isFinite(max) || max < 1) return '';
  return String(Math.floor(Math.random() * max) + 1);
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

  // Values resolved lazily so we never compute a macro the text doesn't use.
  const values: Record<string, () => string> = {
    char: () => env.char,
    bot: () => env.char,
    user: () => env.user,
    // Not a group chat in V1: {{group}} and {{charIfNotGroup}} both resolve to the char.
    group: () => env.char,
    charifnotgroup: () => env.char,
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

  for (const [key, value] of Object.entries(env.extra ?? {})) {
    values[key.toLowerCase()] = typeof value === 'function' ? value : () => value;
  }

  let pickCounter = 0;

  // One pass. Nested macros are not supported, matching the legacy engine.
  const result = source.replace(/\{\{([^{}]*)\}\}/g, (match, body: string) => {
    const raw = String(body).trim();
    if (!raw) return match;

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
          return match;
        }
        setVariable(runtime, name === 'setglobalvar', variable, storedValue(value));
        return '';
      }

      case 'addvar':
      case 'addglobalvar': {
        const [variable, value] = variablePair(args);
        if (!variable) {
          warn(runtime, match, diagnosticSource);
          return match;
        }
        addVariable(runtime, name === 'addglobalvar', variable, value);
        return '';
      }

      case 'incvar':
      case 'incglobalvar': {
        if (!args.trim()) {
          warn(runtime, match, diagnosticSource);
          return match;
        }
        return String(changeVariable(runtime, name === 'incglobalvar', args.trim(), 1));
      }

      case 'decvar':
      case 'decglobalvar': {
        if (!args.trim()) {
          warn(runtime, match, diagnosticSource);
          return match;
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
        return match;
      }
    }
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
