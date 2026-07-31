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
 */
function hashString(value: string): number {
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
export function substituteMacros(text: string, env: MacroEnvironment, seed = ''): string {
  if (!text) return '';

  // {{trim}} eats the whitespace around its own position. Handled up front, on its own,
  // so the general pass never needs a sentinel value that could collide with real text.
  const source = text.replace(/\s*\{\{trim\}\}\s*/gi, '');
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

      default: {
        const resolver = values[name];
        return resolver ? resolver() : match;
      }
    }
  });

  return result;
}

/** Build a macro environment from the pieces the assembler already has. */
export function createEnvironment(
  overrides: Partial<MacroEnvironment> & Pick<MacroEnvironment, 'char' | 'user'>,
): MacroEnvironment {
  return { ...overrides };
}
