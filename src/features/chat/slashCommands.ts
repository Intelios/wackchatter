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

import { parseDiceFormula } from '@shared/prompt/dice.ts';

export type SlashCommand =
  | { type: 'hide'; start: number | null; end: number | null }
  | { type: 'unhide'; start: number | null; end: number | null }
  | { type: 'jump'; index: number }
  | { type: 'rename'; title: string }
  | { type: 'reload' }
  /** Opens the card reader. An empty query just opens it. */
  | { type: 'card'; query: string }
  /**
   * Switches who you are writing as. An empty query opens the panel; `none` clears the
   * persona. Resolving the name against the library is the executor's job — this module
   * only recognises.
   */
  | { type: 'persona'; query: string }
  /** The formula is already normalised and known to roll — see `parseDiceFormula`. */
  | { type: 'roll'; formula: string };

export type SlashParseResult = { ok: true; command: SlashCommand } | { ok: false; error: string };

const JUMP_USAGE = 'Usage: /jump <message index> (indices start at 0).';
const RENAME_USAGE = 'Usage: /rename <new title>.';
const ROLL_USAGE = 'Usage: /roll <formula>, e.g. /roll 2d6+3. On its own it rolls 1d20.';

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
  {
    name: 'card',
    usage: '/card or /card <text to find>',
    description: "Read this character's card, optionally jumping to what you searched for.",
  },
  {
    name: 'persona',
    usage: '/persona <name>, /persona none, or /persona',
    description: 'Switch who you are writing as. On its own, opens the persona panel.',
  },
  {
    name: 'roll',
    usage: '/roll 2d6+3, or /roll for 1d20',
    description: 'Roll dice into the chat, where the character can read the result.',
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

  /*
   * Case-insensitive to match `slashCompletion`, which suggests on a lowercased token —
   * the box must never advertise a name the parser then refuses. The unknown-command
   * error below still echoes the spelling that was typed.
   */
  switch (firstWord.toLowerCase()) {
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
    /*
     * The only command whose argument is optional, because both halves are useful on their
     * own: `/card` is "show me the card" and `/card hair` is "show me the bit about hair".
     * Verbatim like `/rename` — a search term is prose, and "blonde hair" is one query.
     */
    case 'card':
      return { ok: true, command: { type: 'card', query: arg } };
    /*
     * Optional argument for the same reason as `/card`, and verbatim for the same reason as
     * `/rename`: a persona name is prose — "Tamsin Vale" is one name, not two tokens.
     *
     * Whether the name resolves is decided by the executor against the live library, which
     * is where the personas are. A name matching nothing, or matching two personas equally
     * well, is an error there — never a silent switch, because the persona is recorded onto
     * every message you then send.
     */
    case 'persona':
      return { ok: true, command: { type: 'persona', query: arg } };
    /*
     * Validated here rather than by the executor, because this module's rule is that a
     * command-shaped line that fails to parse is an error and never a send. `/roll 2x6` is a
     * typo; letting it through would put "2x6" in front of the model as dialogue.
     *
     * Empty means 1d20 — the die you reach for when you did not say which one.
     */
    case 'roll': {
      const parsed = parseDiceFormula(arg || '1d20');
      if (!parsed) {
        return { ok: false, error: `Could not read "${arg}" as a dice formula. ${ROLL_USAGE}` };
      }
      return { ok: true, command: { type: 'roll', formula: parsed.formula } };
    }
    default:
      return { ok: false, error: `Unknown command "/${firstWord}".` };
  }
}
