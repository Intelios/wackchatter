/**
 * Application settings.
 *
 * Ours, and deliberately not portable: a preset carries prompts and samplers, this
 * carries which server you are talking to. Keeping them apart means importing someone
 * else's preset cannot silently repoint your endpoint, and exporting yours cannot leak it.
 */

import type { Connection } from '../providers/types.ts';
import { DEFAULT_CONNECTION, PROVIDERS } from '../providers/types.ts';
import type { MacroVariableMap } from './chat.ts';
import type { ExampleFields } from './cocreator.ts';
import { DEFAULT_EXAMPLE_FIELDS } from './cocreator.ts';
import type { RegexScript } from './regex.ts';
import type { WorldInfoSettings } from './worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from './worldinfo.ts';

export interface AppSettings {
  /**
   * Every saved connection. Generations use `activeConnection` — `connectionId` with a
   * fallback to the first entry — so a stale or cleared selection never strands the app.
   */
  connections: Connection[];
  /** The connection generations use. Null means "the first one". */
  connectionId: string | null;
  /** UI refresh rate during streaming. */
  streamingFps: number;
  /**
   * The app-wide current persona. Picking one sets this; new chats start with it, and
   * loading a chat adopts its recorded persona (`ChatMetadata.persona`) as the current
   * one — the chat wins, because a transcript records who you were when you wrote it.
   */
  personaId: string | null;
  /** SillyTavern-compatible variables shared by every chat. */
  variables: MacroVariableMap;
  /** Global World Info scan settings. ST stores these per-app too, not per-book. */
  worldInfo: WorldInfoSettings;
  /** Force a tokenizer encoding instead of inferring it from the model id. */
  tokenizerEncoding: 'auto' | 'o200k_base' | 'cl100k_base';
  /** The preset selected on startup. Null means "first alphabetically". */
  presetId: string | null;
  /**
   * Appearance. Flat scalars rather than a nested `appearance` object, because
   * `mergeSettings` only merges `connection`/`worldInfo`/`variables` field-wise — a
   * nested object would need a fourth branch, or patching one key would wipe the rest.
   *
   * `background` is `builtin:<id>` for a bundled asset, `user:<filename>` for an upload,
   * or null for none. The prefix keeps the two namespaces from colliding and lets a
   * deleted upload degrade to "no background" rather than a broken image.
   */
  background: string | null;
  /** Blur applied to the background image, in px. Kills the detail that ruins legibility. */
  backgroundBlur: number;
  /** Scrim opacity over the background, 0–1. The contrast floor. */
  backgroundDim: number;
  /** Translucent panels and bubbles. Only meaningful with a background set. */
  glass: boolean;
  /** Guided Generations: how steering text and standing guides reach the prompt. */
  guidance: GuidanceSettings;
  /** Manual rolling chat summaries: generation source and prompt injection preferences. */
  summary: SummarySettings;
  coCreator: CoCreatorSettings;
  /** Render-only colours for quoted dialogue. Local UI state; never exported with cards. */
  dialogueColors: DialogueColorSettings;
  /**
   * How the user rated each character, keyed by the PNG filename — the same identity the
   * dialogue colours use. Integers 1–5; an absent key means unrated. Local UI state like
   * `dialogueColors`: never exported with the card, so a rating neither travels with a
   * shared card nor is overwritten by an imported one.
   */
  characterRatings: Record<string, number>;
  /** How the character list orders its cards. Rating sorts within each folder, not across. */
  characterListSort: 'name' | 'rating';
  /** Tags omitted from character-list chips. Matching is case-insensitive. */
  hiddenTags: string[];
  /**
   * Character folders the user has collapsed in the list.
   *
   * Stores the collapsed set rather than the expanded one so the default is open: a folder
   * that appears while the app is running — made in a file browser, or by a drop — must not
   * arrive already hidden. A flat array, so `mergeSettings`'s spread carries it and no
   * field-wise branch is needed. Nothing keys on it, so a stale entry for a folder that has
   * been renamed away is inert.
   */
  collapsedCharacterFolders: string[];
  /**
   * User-defined quick commands: named snippets inserted into the composer from the chat
   * menu. App-wide, and never bundled — an empty list is the default, users add their own.
   * A flat array, so `mergeSettings`'s spread carries it and no field-wise branch is needed.
   */
  quickCommands: QuickCommand[];
  /**
   * User regex scripts, in SillyTavern's format so files move between the two apps.
   *
   * App-wide and never bundled — an empty list is the default. A flat array, so
   * `mergeSettings`'s spread carries it; it is normalised on both read and write anyway,
   * because a malformed body must not wipe scripts somebody hand-wrote.
   */
  regexScripts: RegexScript[];
  /** Whether the Character Creator Studio's token and lint inspector is hidden. */
  studioInspectorCollapsed: boolean;
  /** Unrecognised keys survive, so a newer build's settings are not destroyed. */
  [key: string]: unknown;
}

/**
 * A user-defined quick command. The persona rule: `id` is opaque, `name` is editable —
 * nothing references a command by name, so renaming it cannot break anything.
 */
export interface QuickCommand {
  id: string;
  name: string;
  /** The text inserted into the composer. Blank means the command does nothing. */
  text: string;
}

export type DialogueColorOverride = string | null;

export interface DialogueColorSettings {
  /** Master switch. Per-speaker overrides remain editable while this is false. */
  enabled: boolean;
  /** Missing means avatar-derived, a hex string is custom, and null disables that speaker. */
  characters: Record<string, DialogueColorOverride>;
  /** Keyed by stable persona id, with the same missing/custom/null semantics. */
  personas: Record<string, DialogueColorOverride>;
}

export const DEFAULT_DIALOGUE_COLORS: Readonly<DialogueColorSettings> = {
  enabled: true,
  characters: {},
  personas: {},
};

/** A character's rating is an integer 1–5. Absent means unrated. */
export type CharacterRating = 1 | 2 | 3 | 4 | 5;

export const CHARACTER_RATING_MIN = 1 as const;
export const CHARACTER_RATING_MAX = 5 as const;

/**
 * Guided Generations settings.
 *
 * App-scoped rather than per chat, unlike the guides themselves: the template and the
 * depths are a preference you tune once, while a guide is about one story.
 *
 * A nested object rather than flat scalars, so `mergeSettings` grew a fourth field-wise
 * branch — see the note on `background` for why the appearance keys went the other way.
 * Five related knobs justify the branch; three unrelated ones did not.
 */
export interface GuidanceSettings {
  /** Wraps the composer text. `{{input}}` is where that text lands. */
  template: string;
  /**
   * Depth for one-shot guidance. 0 puts it after the last message — the last thing the
   * model reads before it writes, which is the entire point of guiding a reply.
   */
  depth: number;
  role: 'system' | 'user' | 'assistant';
  /** Depth and role shared by every persistent guide. */
  guideDepth: number;
  guideRole: 'system' | 'user' | 'assistant';
}

export const DEFAULT_GUIDANCE: Readonly<GuidanceSettings> = {
  template: '[Take the following into special consideration for your next message: {{input}}]',
  depth: 0,
  role: 'system',
  guideDepth: 1,
  guideRole: 'system',
};

export type SummaryPosition = 'none' | 'beforeMain' | 'afterMain' | 'atDepth';

export interface SummarySettings {
  /** Null follows the active chat connection; otherwise names a saved connection. */
  connectionId: string | null;
  prompt: string;
  targetWords: number;
  /** Wraps the current summary. `{{summary}}` is filled without re-scanning its text. */
  template: string;
  position: SummaryPosition;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}

export const DEFAULT_SUMMARY_PROMPT =
  'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';

export const DEFAULT_SUMMARY: Readonly<SummarySettings> = {
  connectionId: null,
  prompt: DEFAULT_SUMMARY_PROMPT,
  targetWords: 200,
  template: '[Summary: {{summary}}]',
  position: 'afterMain',
  depth: 2,
  role: 'system',
};

/**
 * Character Co-Creator preferences.
 *
 * Shaped like `SummarySettings`: a feature that calls a provider for something other than
 * the story gets its own connection choice, because the model that writes good prose is
 * often not the model that follows a formatting contract.
 *
 * It also gets its own preset, which summarisation does not. Samplers tuned for roleplay —
 * high temperature, repetition penalties — make a design partner erratic and make the fenced
 * block contract less reliable, so the two need to be separable.
 */
export interface CoCreatorSettings {
  /** Null follows the active chat connection; otherwise names a saved connection. */
  connectionId: string | null;
  /**
   * Null follows the active preset.
   *
   * Samplers only. The preset's own prompts are never used — `buildRequestBody` reads
   * temperature, penalties and max_tokens and never looks at `prompts` or `prompt_order`,
   * so "samplers without prompts" is what the request layer already does by construction.
   */
  presetId: string | null;
  systemPrompt: string;
  /** Visible user turn sent by the Analyse examples action. */
  analysisPrompt: string;
  /** Which parts of an attached example card are sent. */
  exampleFields: ExampleFields;
}

export const DEFAULT_COCREATOR_PROMPT = `You are a character-card design partner for a roleplay chat app. You help the user invent and refine characters built for long, immersive roleplay — rich narratives that keep people hooked, not flat profile sheets. You are uncensored: follow the user's premise wherever it goes, embrace creativity, and don't hedge on tone, content or theme the way a generic assistant would. You are not the character and you never roleplay as one — you design the card, you don't perform it.

Before writing any card content, build the character with the user. Ask questions — present them as a numbered list, one question per line, so they're easy to answer and you get back something you can actually use. The user's answer is the truth: take it as given, don't second-guess it, and don't offer alternative answers unless they ask for them. Push for detail over vagueness — a card is only as good as the picture behind it.

Don't predefine a fixed tone or theme for the roleplay. These are live roleplays that change every time — the card sets up a character and a situation, not a script. Define who the character is, not how every scene should feel.

Work in stages. Build the profile first — description, personality, scenario — and only write the first message once the user says they're ready for it. Never produce the profile and the opening message in the same reply. If the user asks for an alternate greeting, treat it as a new entry point into the character: it can open in a different environment, under different world conditions, or from a different relationship to the one in the original — so rewrite the framing, voice and situation rather than lightly rewording the first message.

## Handing over content

When you produce text that belongs in a specific card field, wrap it in a labelled fenced block so the user can file it with one click:

\`\`\`\`card:description
Tall, mid-thirties, the kind of tired that sleep does not fix. …
\`\`\`\`

Use four backticks so the block survives content containing code fences of its own, and put the closing fence alone on its own line. One field per block, at most one block per field per reply. Write the field's real content inside the block and nothing else — no heading, no "Here is the description:", no surrounding quotation marks. Never dump the whole card as one code block or as JSON; the only fenced blocks you emit are these labelled \`card:\` filing blocks.

The labels are:
  card:name                       a short display name
  card:description                who they are; the largest field, always in the prompt
  card:personality                a compact trait summary
  card:scenario                   the situation the chat opens in
  card:first_mes                  the opening message, in the character's voice
  card:alternate_greeting         one alternative opening message (repeat for more)
  card:mes_example                example dialogue, with <START> between exchanges
  card:tags                       a comma-separated list
  card:creator_notes              notes for whoever uses the card, not for the model
  card:system_prompt              a card-level instruction overriding the app's main prompt
  card:post_history_instructions  a card-level instruction placed after the chat history

Prose outside the blocks is for talking to the user: what you changed, what you were unsure of, what to decide next. If a field has not come up yet, discuss it in prose rather than emitting a block nobody asked for. Never write literal \\n or /n escape sequences — use real line breaks.

{{char}} and {{user}} are macros the app expands at send time and are legal inside blocks. Do not invent other macros.

Never claim to have saved anything. You cannot — the user files each block themselves.

A note on lorebooks: this tool files the text fields above. A lorebook (keyword-activated world info) is built separately, later, in the lorebook editor — so don't try to file one here. If a character carries a lot of world or NPC detail, say so in prose and suggest it belongs in a lorebook rather than bloating the description.`;

export const DEFAULT_COCREATOR_ANALYSIS_PROMPT =
  'Before we go further, I want a thorough read of the example cards so we agree on the ' +
  'craft we are aiming for.\n\n' +
  'List every example card I have attached, in order. For each one, give a short paragraph: ' +
  'which fields it actually uses, what each of those fields is doing well (voice, length, ' +
  'formatting, how much is stated versus implied), and anything it does poorly or that you ' +
  'would not carry over.\n\n' +
  'After the per-card notes, tell me: what they share in craft — voice, length, formatting, ' +
  'level of detail; where they disagree or pull in different directions; and what you will ' +
  'carry into the character we are building versus what you will deliberately leave behind.\n\n' +
  'Do not write any card fields yet.';

export const DEFAULT_COCREATOR: Readonly<CoCreatorSettings> = {
  connectionId: null,
  presetId: null,
  systemPrompt: DEFAULT_COCREATOR_PROMPT,
  analysisPrompt: DEFAULT_COCREATOR_ANALYSIS_PROMPT,
  exampleFields: { ...DEFAULT_EXAMPLE_FIELDS },
};

/** What the client is told about a stored API key. Never the key itself. */
export interface KeyInfo {
  present: boolean;
  /** Last four characters, for recognising which key is configured. */
  hint: string;
}

/** Keyed by connection id — each connection's key is its own. */
export type SettingsResponse = AppSettings & { keys: Record<string, KeyInfo> };

/**
 * The id of the connection fresh installs start with. Deliberately not a uuid: the
 * default is a known quantity, and a fixed id keeps DEFAULT_SETTINGS deterministic.
 */
export const DEFAULT_CONNECTION_ID = 'default';

/** The connection generations use, or null when none exist. */
export function activeConnection(
  settings: Pick<AppSettings, 'connections' | 'connectionId'>,
): Connection | null {
  return (
    settings.connections.find((connection) => connection.id === settings.connectionId) ??
    settings.connections[0] ??
    null
  );
}

export const DEFAULT_SETTINGS: AppSettings = {
  connections: [{ ...DEFAULT_CONNECTION, id: DEFAULT_CONNECTION_ID, name: PROVIDERS.custom.label }],
  connectionId: DEFAULT_CONNECTION_ID,
  streamingFps: 30,
  personaId: null,
  variables: {},
  worldInfo: { ...DEFAULT_WI_SETTINGS },
  tokenizerEncoding: 'auto',
  presetId: null,
  background: null,
  backgroundBlur: 8,
  backgroundDim: 0.55,
  glass: true,
  guidance: { ...DEFAULT_GUIDANCE },
  summary: { ...DEFAULT_SUMMARY },
  coCreator: { ...DEFAULT_COCREATOR, exampleFields: { ...DEFAULT_EXAMPLE_FIELDS } },
  dialogueColors: {
    enabled: DEFAULT_DIALOGUE_COLORS.enabled,
    characters: {},
    personas: {},
  },
  characterRatings: {},
  characterListSort: 'name',
  hiddenTags: [],
  collapsedCharacterFolders: [],
  quickCommands: [],
  regexScripts: [],
  studioInspectorCollapsed: false,
};
