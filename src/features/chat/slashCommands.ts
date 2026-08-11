/**
 * Slash commands — typed, not menu-driven.
 *
 * Pure, with no DOM, chat or store in reach, so the recognition rules are unit-testable
 * the same way `buildChatMenu` is. The two rules that matter:
 *
 *  - Only text that *starts* with `/` is a command. A message is either a command or a
 *    message; there is no middle state, and parsing happens before `chat.send` ever sees
 *    the text.
 *  - A command-shaped line that fails to parse is an *error*, never a silent send. Sending
 *    `/giggle` to a provider is how a typo becomes character dialogue nobody asked for.
 *
 * Indexes and ranges are zero-based and inclusive, matching SillyTavern's `/hide`
 * (`stringToRange(value, 0, chat.length - 1)` and its `<= end` loop in `chats.js`). Bounds
 * against the actual transcript are the executor's job — this module only recognises.
 */

export type SlashCommand =
  | { type: 'hide'; start: number | null; end: number | null }
  | { type: 'unhide'; start: number | null; end: number | null }
  | { type: 'jump'; index: number }
  | { type: 'rename'; title: string }
  | { type: 'reload' };

export type SlashParseResult = { ok: true; command: SlashCommand } | { ok: false; error: string };

const JUMP_USAGE = 'Usage: /jump <message index> (indices start at 0).';
const RENAME_USAGE = 'Usage: /rename <new title>.';

/** The shipped commands, as shown in the composer's autocomplete box. */
export interface SlashCommandHelp {
  name: string;
  /** The syntax, shown verbatim so the box teaches the commands it lists. */
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommandHelp[] = [
  {
    name: 'hide',
    usage: '/hide <index> or /hide <start>-<end>',
    description: 'Hide messages from the prompt, keeping them in the transcript.',
  },
  {
    name: 'unhide',
    usage: '/unhide <index> or /unhide <start>-<end>',
    description: 'Show hidden messages to the prompt again.',
  },
  {
    name: 'jump',
    usage: '/jump <message index>',
    description: 'Scroll to a message by its zero-based index.',
  },
  {
    name: 'rename',
    usage: '/rename <new title>',
    description: 'Retitle this chat, which is how it is labelled on the start screen.',
  },
  {
    name: 'reload',
    usage: '/reload',
    description: 'Save and re-fetch this chat from the server.',
  },
];

/** The suggestions the composer's autocomplete should show for a draft, or null when the
 * draft is not a command at all. */
export interface SlashCompletion {
  suggestions: SlashCommandHelp[];
  /**
   * True while the command name is still being typed — Enter and Tab complete it instead
   * of sending. Once the name is exactly spelled (or arguments follow), Enter runs it.
   */
  completing: boolean;
}

export function slashCompletion(text: string): SlashCompletion | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const rest = trimmed.slice(1);
  const token = rest.split(/\s+/)[0] ?? '';
  const name = token.toLowerCase();
  const suggestions = name
    ? SLASH_COMMANDS.filter((command) => command.name.startsWith(name))
    : [...SLASH_COMMANDS];
  const completing = !/\s/.test(rest) && suggestions.some((command) => command.name !== name);
  return { suggestions, completing };
}

/** A plain non-negative integer, or null when the token is something else. */
function integerToken(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Shared body for `/hide` and `/unhide`, which share the range syntax. */
function parseRange(name: 'hide' | 'unhide', arg: string): SlashParseResult {
  const usage = `Usage: /${name} <index> or /${name} <start>-<end> (indices start at 0).`;
  const rangeCommand = (start: number | null, end: number | null): SlashCommand =>
    ({ type: name, start, end }) as SlashCommand;

  if (!arg) return { ok: true, command: rangeCommand(null, null) };

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(arg);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) {
      return {
        ok: false,
        error: `Reversed range ${start}-${end} — the start must be at or before the end. ${usage}`,
      };
    }
    return { ok: true, command: rangeCommand(start, end) };
  }

  const single = integerToken(arg);
  if (single !== null) return { ok: true, command: rangeCommand(single, single) };

  return { ok: false, error: `Could not parse "${arg}" as an index or range. ${usage}` };
}

export function parseSlashCommand(input: string): SlashParseResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const rest = trimmed.slice(1);
  const firstWord = /^(\S+)/.exec(rest)?.[1] ?? '';
  const arg = rest.slice(firstWord.length).trim();

  if (!firstWord) {
    return { ok: false, error: 'Enter a command after the slash, e.g. /hide 0-150.' };
  }

  switch (firstWord) {
    case 'hide':
      return parseRange('hide', arg);
    case 'unhide':
      return parseRange('unhide', arg);
    case 'jump': {
      if (!arg) return { ok: false, error: JUMP_USAGE };
      const index = integerToken(arg);
      if (index === null) {
        return {
          ok: false,
          error: `Could not parse "${arg}" as a message index. ${JUMP_USAGE}`,
        };
      }
      return { ok: true, command: { type: 'jump', index } };
    }
    // The rest of the argument verbatim, spaces and all — a chat title is prose, not
    // tokens, so there is nothing here to parse beyond "is it empty".
    case 'rename': {
      if (!arg) return { ok: false, error: RENAME_USAGE };
      return { ok: true, command: { type: 'rename', title: arg } };
    }
    case 'reload':
      if (arg) return { ok: false, error: '`/reload` takes no arguments.' };
      return { ok: true, command: { type: 'reload' } };
    default:
      return { ok: false, error: `Unknown command "/${firstWord}".` };
  }
}
