/**
 * The macro reference.
 *
 * What the completion box lists and what a person reads to find out that `{{pick}}` exists.
 * It documents the engine in `macros.ts` and is held to it by `macroCatalog.test.ts`: every
 * entry here has to resolve, and every name the engine knows has to appear here. A macro
 * nobody can discover may as well not be implemented.
 *
 * `usage` is shown verbatim and is also the text that gets inserted, so it is written the
 * way it should be typed — `::` separators throughout, which is the spelling SillyTavern's
 * own documentation uses even though the engine also accepts a space or a single colon.
 */

export type MacroCategory =
  | 'identity'
  | 'card'
  | 'chat'
  | 'randomness'
  | 'variables'
  | 'time'
  | 'generation'
  | 'utility';

export interface MacroDoc {
  /** Canonical, lowercase. What the completion box inserts. */
  name: string;
  /** Other spellings the engine accepts. Documented, never suggested on their own. */
  aliases?: string[];
  category: MacroCategory;
  usage: string;
  description: string;
  /** Takes arguments, so accepting a completion leaves the caret between the separators. */
  takesArgs?: true;
  /**
   * What a completion inserts, when the skeleton derived from `usage` would be wrong.
   * Only the comment macro needs it: its argument is prose, not a `::` list.
   */
  insert?: string;
}

/** Display order for the completion box's grouping. Randomness sits high; it is the fun one. */
export const MACRO_CATEGORY_LABELS: Record<MacroCategory, string> = {
  identity: 'Names',
  randomness: 'Randomness',
  variables: 'Variables',
  card: 'Character card',
  chat: 'This chat',
  time: 'Time',
  generation: 'Generation',
  utility: 'Utility',
};

export const MACRO_CATALOG: readonly MacroDoc[] = [
  // --- Names ---------------------------------------------------------------
  {
    name: 'char',
    aliases: ['bot', 'group', 'charifnotgroup'],
    category: 'identity',
    usage: '{{char}}',
    description: "The character's name.",
  },
  {
    name: 'user',
    category: 'identity',
    usage: '{{user}}',
    description: 'Your name — the persona you are writing as.',
  },

  // --- Randomness ----------------------------------------------------------
  {
    name: 'roll',
    category: 'randomness',
    usage: '{{roll::1d20}}',
    description: 'Roll dice. Accepts 2d6, 3d6+4, d20, or a bare number for one die.',
    takesArgs: true,
  },
  {
    name: 'random',
    category: 'randomness',
    usage: '{{random::heads::tails}}',
    description: 'One of the choices, drawn afresh every time the text is resolved.',
    takesArgs: true,
  },
  {
    name: 'pick',
    category: 'randomness',
    usage: '{{pick::north::south::east}}',
    description: 'Like random, but the choice sticks for this chat instead of re-rolling.',
    takesArgs: true,
  },

  // --- Variables -----------------------------------------------------------
  {
    name: 'setvar',
    category: 'variables',
    usage: '{{setvar::name::value}}',
    description: 'Store a value in this chat. Resolves to nothing.',
    takesArgs: true,
  },
  {
    name: 'getvar',
    category: 'variables',
    usage: '{{getvar::name}}',
    description: 'Read a value stored in this chat.',
    takesArgs: true,
  },
  {
    name: 'addvar',
    category: 'variables',
    usage: '{{addvar::name::1}}',
    description: 'Add to a number, or append to a string. Resolves to nothing.',
    takesArgs: true,
  },
  {
    name: 'incvar',
    category: 'variables',
    usage: '{{incvar::name}}',
    description: 'Add one and resolve to the new value.',
    takesArgs: true,
  },
  {
    name: 'decvar',
    category: 'variables',
    usage: '{{decvar::name}}',
    description: 'Subtract one and resolve to the new value.',
    takesArgs: true,
  },
  {
    name: 'hasvar',
    aliases: ['varexists'],
    category: 'variables',
    usage: '{{hasvar::name}}',
    description: 'true or false, depending on whether the variable has been set.',
    takesArgs: true,
  },
  {
    name: 'deletevar',
    aliases: ['flushvar'],
    category: 'variables',
    usage: '{{deletevar::name}}',
    description: 'Forget a variable. Resolves to nothing.',
    takesArgs: true,
  },
  {
    name: 'setglobalvar',
    category: 'variables',
    usage: '{{setglobalvar::name::value}}',
    description: 'As setvar, but shared by every chat rather than scoped to this one.',
    takesArgs: true,
  },
  {
    name: 'getglobalvar',
    category: 'variables',
    usage: '{{getglobalvar::name}}',
    description: 'Read an app-wide variable.',
    takesArgs: true,
  },
  {
    name: 'addglobalvar',
    category: 'variables',
    usage: '{{addglobalvar::name::1}}',
    description: 'As addvar, app-wide.',
    takesArgs: true,
  },
  {
    name: 'incglobalvar',
    category: 'variables',
    usage: '{{incglobalvar::name}}',
    description: 'As incvar, app-wide.',
    takesArgs: true,
  },
  {
    name: 'decglobalvar',
    category: 'variables',
    usage: '{{decglobalvar::name}}',
    description: 'As decvar, app-wide.',
    takesArgs: true,
  },
  {
    name: 'hasglobalvar',
    aliases: ['globalvarexists'],
    category: 'variables',
    usage: '{{hasglobalvar::name}}',
    description: 'As hasvar, app-wide.',
    takesArgs: true,
  },
  {
    name: 'deleteglobalvar',
    aliases: ['flushglobalvar'],
    category: 'variables',
    usage: '{{deleteglobalvar::name}}',
    description: 'As deletevar, app-wide.',
    takesArgs: true,
  },

  // --- Character card ------------------------------------------------------
  {
    name: 'description',
    category: 'card',
    usage: '{{description}}',
    description: "The card's description field.",
  },
  {
    name: 'personality',
    category: 'card',
    usage: '{{personality}}',
    description: "The card's personality field.",
  },
  {
    name: 'scenario',
    category: 'card',
    usage: '{{scenario}}',
    description: "The scenario — this chat's override if it has one, otherwise the card's.",
  },
  {
    name: 'persona',
    category: 'card',
    usage: '{{persona}}',
    description: "Your persona's description.",
  },
  {
    name: 'mesexamples',
    aliases: ['mesexamplesraw'],
    category: 'card',
    usage: '{{mesExamples}}',
    description: "The card's example messages.",
  },
  {
    name: 'charversion',
    aliases: ['char_version'],
    category: 'card',
    usage: '{{charVersion}}',
    description: "The card's version string.",
  },
  {
    name: 'charprompt',
    category: 'card',
    usage: '{{charPrompt}}',
    description: "The card's own system prompt.",
  },
  {
    name: 'charjailbreak',
    aliases: ['charinstruction'],
    category: 'card',
    usage: '{{charJailbreak}}',
    description: "The card's post-history instructions.",
  },
  {
    name: 'creatornotes',
    category: 'card',
    usage: '{{creatorNotes}}',
    description: "The card's creator notes.",
  },

  // --- This chat -----------------------------------------------------------
  {
    name: 'lastmessage',
    aliases: ['lastchatmessage'],
    category: 'chat',
    usage: '{{lastMessage}}',
    description: 'The most recent message, whoever wrote it.',
  },
  {
    name: 'lastusermessage',
    category: 'chat',
    usage: '{{lastUserMessage}}',
    description: 'The most recent thing you said.',
  },
  {
    name: 'lastcharmessage',
    category: 'chat',
    usage: '{{lastCharMessage}}',
    description: 'The most recent thing the character said.',
  },

  // --- Time ----------------------------------------------------------------
  {
    name: 'time',
    category: 'time',
    usage: '{{time}}',
    description: 'The current time, as 4:05 PM.',
  },
  {
    name: 'date',
    category: 'time',
    usage: '{{date}}',
    description: 'The current date, as March 9, 2026.',
  },
  {
    name: 'weekday',
    category: 'time',
    usage: '{{weekday}}',
    description: 'The current day of the week.',
  },
  {
    name: 'isotime',
    category: 'time',
    usage: '{{isotime}}',
    description: 'The current time, as 16:05:23.',
  },
  {
    name: 'isodate',
    category: 'time',
    usage: '{{isodate}}',
    description: 'The current date, as 2026-03-09.',
  },

  // --- Generation ----------------------------------------------------------
  {
    name: 'model',
    category: 'generation',
    usage: '{{model}}',
    description: 'The model this request is going to.',
  },
  {
    name: 'maxcontext',
    aliases: ['maxcontexttokens'],
    category: 'generation',
    usage: '{{maxContext}}',
    description: "The preset's context size.",
  },
  {
    name: 'maxresponse',
    aliases: ['maxresponsetokens'],
    category: 'generation',
    usage: '{{maxResponse}}',
    description: "The preset's reply size.",
  },
  {
    name: 'maxprompt',
    aliases: ['maxprompttokens'],
    category: 'generation',
    usage: '{{maxPrompt}}',
    description: 'Context minus reply — the budget the prompt is packed into.',
  },

  // --- Utility -------------------------------------------------------------
  {
    name: 'reverse',
    category: 'utility',
    usage: '{{reverse::text}}',
    description: 'The argument, backwards.',
    takesArgs: true,
  },
  {
    name: 'newline',
    category: 'utility',
    usage: '{{newline}}',
    description: 'A line break, for places a real one is awkward to type.',
  },
  {
    name: 'trim',
    category: 'utility',
    usage: '{{trim}}',
    description: 'Eats the whitespace around itself, including the surrounding line breaks.',
  },
  {
    name: 'noop',
    category: 'utility',
    usage: '{{noop}}',
    description: 'Nothing at all. Useful for keeping a prompt from being empty.',
  },
  {
    name: '//',
    category: 'utility',
    usage: '{{// a note to yourself}}',
    description: 'A comment. Never reaches the model.',
    takesArgs: true,
    insert: '{{// }}',
  },
];

/** Case-insensitive lookup across canonical names and aliases. */
export function findMacro(name: string): MacroDoc | undefined {
  const needle = name.toLowerCase();
  return MACRO_CATALOG.find(
    (macro) => macro.name === needle || macro.aliases?.includes(needle) === true,
  );
}

/**
 * The catalogue filtered by a half-typed name, canonical names only.
 *
 * Prefix matches come first and in catalogue order, so typing `ro` puts `roll` at the top
 * rather than burying it under an alphabetical accident. An empty query lists everything.
 */
export function searchMacros(query: string): MacroDoc[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...MACRO_CATALOG];

  const prefix = MACRO_CATALOG.filter((macro) => macro.name.startsWith(needle));
  const contains = MACRO_CATALOG.filter(
    (macro) => !macro.name.startsWith(needle) && macro.name.includes(needle),
  );
  return [...prefix, ...contains];
}
