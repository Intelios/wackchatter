/**
 * Application settings.
 *
 * Ours, and deliberately not portable: a preset carries prompts and samplers, this
 * carries which server you are talking to. Keeping them apart means importing someone
 * else's preset cannot silently repoint your endpoint, and exporting yours cannot leak it.
 */

import { type ComposerLayouts, DEFAULT_COMPOSER_LAYOUTS } from '../composer/layout.ts';
import {
  type ChatReasoningEffortPatch,
  type ChatReasoningEfforts,
  type CoCreatorReasoningEffortPatch,
  type CoCreatorReasoningEfforts,
  emptyCoCreatorReasoningEfforts,
} from '../models/reasoning.ts';
import { DEFAULT_MODEL_SLOTS, type ModelRef, type ModelSlots } from '../models/slots.ts';
import { DEFAULT_NEXUS, type NexusSettings } from '../nexus/types.ts';
import type { Connection } from '../providers/types.ts';
import { DEFAULT_CONNECTION, PROVIDERS } from '../providers/types.ts';
import type { ArenaSettings } from './arena.ts';
import { DEFAULT_ARENA } from './arena.ts';
import type { MacroVariableMap } from './chat.ts';
import type { ExampleFields, ExampleSet, SideChatDefaults } from './cocreator.ts';
import { DEFAULT_EXAMPLE_FIELDS, DEFAULT_SIDE_CHAT } from './cocreator.ts';
import type { RegexScript } from './regex.ts';
import type { WorldInfoSettings } from './worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from './worldinfo.ts';

export interface AppSettings {
  /**
   * The server's write counter, bumped on every persisted settings change and never by a
   * client. A response carrying an older number describes a world that has been replaced,
   * so the app can ignore it instead of painting stale connections or models back over a
   * newer save.
   */
  settingsRevision: number;
  /** Every saved connection: endpoints and how to talk to them, never a model. */
  connections: Connection[];
  /**
   * The model each app-wide feature runs on (`shared/models/slots.ts`). Field-wise in
   * `mergeSettings`, so picking one slot's model never touches another's.
   */
  models: ModelSlots;
  /**
   * Chat-only reasoning overrides, by connection then model. An absent leaf follows the
   * preset; explicit `auto` is saved too. Patches merge both levels, and only a null model
   * leaf resets one. Deleting a connection drops its preferences.
   */
  chatReasoningEfforts: ChatReasoningEfforts;
  /**
   * Co-Creator reasoning overrides, scoped per picker target then connection then model.
   * Absent leaves follow the target's default (the sampler preset, the preset under test,
   * or the Preset Co-Creator session's Setup fallback).
   */
  coCreatorReasoningEfforts: CoCreatorReasoningEfforts;
  /**
   * Models most recently picked anywhere, newest first, capped at `MAX_RECENT_MODELS`.
   * Convenience only, like `recentPersonaIds`: it heads the model picker.
   */
  recentModels: ModelRef[];
  /**
   * Starred models, in the order they were starred. They head the model picker above the
   * recents, so a model used often never needs a search. Refs to a deleted connection go
   * with it, like recents.
   */
  favoriteModels: ModelRef[];
  /**
   * Which model picker groups are open, by group key (`pickerLogic.ts`). Only groups someone
   * toggled are stored; the rest keep their default.
   */
  modelPickerGroups: Record<string, boolean>;
  /** UI refresh rate during streaming. */
  streamingFps: number;
  /**
   * How a reply appears: word by word as it is written, or whole once it is finished.
   * Display only: the request still streams when the preset says so, which is what keeps
   * the island and the Line lit while you wait.
   */
  revealReplies?: 'written' | 'finished';
  /**
   * The app-wide current persona. Picking one sets this; new chats start with it, and
   * loading a chat adopts its recorded persona (`ChatMetadata.persona`) as the current
   * one — the chat wins, because a transcript records who you were when you wrote it.
   */
  personaId: string | null;
  /**
   * Personas most recently switched to, newest first, capped at `MAX_RECENT_PERSONAS`.
   *
   * Convenience only: it orders the composer's switcher and the panel's roster so the two
   * or three personas someone is actually using this week are reachable without a search.
   * Nothing keys on it, losing it costs a few clicks, and an entry for a deleted persona is
   * inert — `orderPersonas` drops ids it cannot resolve. A flat array, so `mergeSettings`'
   * spread carries it and no field-wise branch is needed.
   */
  recentPersonaIds: string[];
  /**
   * How the persona panel lists the library: dense rows, or a grid of faces.
   *
   * Rows fit about fifteen personas where the grid fits six, which is why they are the
   * default — but a library browsed by face rather than by name is a real way to work, so
   * the grid stays one click away rather than being removed.
   */
  personaListDensity: 'list' | 'gallery';
  /** SillyTavern-compatible variables shared by every chat. */
  variables: MacroVariableMap;
  /** Global World Info scan settings. ST stores these per-app too, not per-book. */
  worldInfo: WorldInfoSettings;
  /** Force a tokenizer encoding instead of inferring it from the model id. */
  tokenizerEncoding: 'auto' | 'o200k_base' | 'cl100k_base';
  /**
   * Append one line per generation to ~/.wackchatter/usage/v2, for an external token
   * accountant to read. On by default; an explicit off preference is preserved.
   *
   * Named for what it is rather than for whoever reads it — the file is a plain usage
   * log, and nothing about it is specific to one consumer.
   */
  usageLog: boolean;
  /**
   * When the server last finished building a library backup (ISO), or null for never.
   * Written by the export route, not the client: it's when one was made, not downloaded.
   */
  lastBackupAt: string | null;
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
  /**
   * Master switch for ambient particle effects. On by default — harmless, because
   * nothing animates until a background is paired below.
   */
  backgroundEffectEnabled: boolean;
  /**
   * Which particle effect each background carries, keyed by the stored background
   * string (`builtin:<id>` / `user:<filename>`). User-driven: ships empty, and the
   * client's effect catalog is the authority — an id it no longer knows degrades to
   * "no effect" at render, the same way a deleted upload degrades to "no background".
   */
  backgroundEffects: Record<string, string>;
  /** Whether the effect layer sits behind the screen's surfaces or in front of them. */
  backgroundEffectLayer: 'behind' | 'front';
  /** Guided Generations: how steering text and standing guides reach the prompt. */
  guidance: GuidanceSettings;
  /** Manual rolling chat summaries: generation source and prompt injection preferences. */
  summary: SummarySettings;
  /** Which story-memory feature new chats start with: the rolling summary, Nexus, or neither. */
  memoryMode: MemoryMode;
  nexus: NexusSettings;
  coCreator: CoCreatorSettings;
  /**
   * Model Arena: the contender pool, the blind draw's card and probe pools, and how a
   * round is set up. Ratings are not here — they are replayed from the recorded rounds,
   * so there is no stored number that could disagree with the history behind it.
   */
  arena: ArenaSettings;
  /** Render-only colours for quoted dialogue. Local UI state; never exported with cards. */
  dialogueColors: DialogueColorSettings;
  /**
   * How the user rated each character, keyed by the PNG filename — the same identity the
   * dialogue colours use. Integers 1–5; an absent key means unrated. Local UI state like
   * `dialogueColors`: never exported with the card, so a rating neither travels with a
   * shared card nor is overwritten by an imported one.
   */
  characterRatings: Record<string, number>;
  /**
   * Where each character's face strip is cut, as the vertical position of the portrait in
   * percent (0 top, 100 bottom), keyed by PNG filename like the ratings. Absent means the
   * automatic crop (`AUTO_FACE_CROP`). Local UI state, never written into the card.
   */
  characterCrops: Record<string, number>;
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
   * Chat-menu families the user has collapsed in the burger menu, by the header's key
   * (`chat`, `reply`, …).
   *
   * The same shape and the same reasoning as `collapsedCharacterFolders`: the collapsed set
   * is stored rather than the expanded one, so the default is open and a family added by a
   * later build cannot arrive already hidden. A flat array, so `mergeSettings`'s spread
   * carries it and no field-wise branch is needed. Nothing keys on it, so a stale entry for
   * a family that has been renamed away is inert.
   */
  collapsedChatMenuGroups: string[];
  /**
   * User-defined quick commands: named snippets inserted into the composer from the chat
   * menu. App-wide, and never bundled — an empty list is the default, users add their own.
   * A flat array, so `mergeSettings`'s spread carries it and no field-wise branch is needed.
   */
  quickCommands: QuickCommand[];
  /** The app-wide composer control tray. */
  composerLayouts: ComposerLayouts;
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
 * Partial settings updates, with per-slot picks and nullable reasoning resets. Keep this
 * homomorphic: Omit over AppSettings's string index signature would lose every other
 * declared field's type, allowing malformed scalar patches at typed call sites.
 */
export type SettingsPatch = {
  [K in keyof AppSettings]?: K extends 'models'
    ? Partial<ModelSlots>
    : K extends 'chatReasoningEfforts'
      ? ChatReasoningEffortPatch
      : K extends 'coCreatorReasoningEfforts'
        ? CoCreatorReasoningEffortPatch
        : AppSettings[K];
};

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

export type PaletteTreatment = 'single' | 'gradient';
export type DialogueTreatment = 'solid' | 'gradient' | 'off';

/** Local appearance only. Portrait treatments keep following the versioned image. */
export type SpeakerPaletteOverride = {
  aura: PaletteTreatment;
  dialogue: DialogueTreatment;
} & ({ source: 'portrait' } | { source: 'custom'; colors: string[] });

/** Legacy hex and null remain valid: a pinned solid colour, or speech colouring off. */
export type DialogueColorOverride = string | null | SpeakerPaletteOverride;

export interface DialogueColorSettings {
  /** Master switch. Per-speaker overrides remain editable while this is false. */
  enabled: boolean;
  /** Missing means portrait-derived; null disables speech, independently of Aura. */
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
 * Where a face strip is cut when nobody has moved it: a fifth of the way down, where most
 * card art puts the eyes. Percent of the portrait's height, as CSS `object-position`.
 */
export const AUTO_FACE_CROP = 20;

/**
 * How many entries `AppSettings.recentPersonaIds` keeps.
 *
 * A cap rather than an unbounded log: the list is pushed to on every switch, and nothing
 * ever prunes it otherwise. Enforced on the server so a stale tab cannot grow the file, and
 * imported by the client so the two agree on one number.
 */
export const MAX_RECENT_PERSONAS = 8 as const;

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

/**
 * Where a story-memory feature's text lands in the prompt.
 *
 * Shared by `SummarySettings` and `NexusSettings` because assembly has exactly one slot
 * for "what happened earlier" and either feature can fill it. Splitting the placement out
 * is what lets that slot stay a single code path instead of two parallel ones that would
 * drift.
 */
export interface StoryMemoryPlacement {
  /** Wraps the feature's text. Its `{{macro}}` is filled without re-scanning the result. */
  template: string;
  position: SummaryPosition;
  depth: number;
  role: 'system' | 'user' | 'assistant';
}

/** The summary's model is the `summary` slot in `AppSettings.models`. */
export interface SummarySettings extends StoryMemoryPlacement {
  /** The summarizer's instructions. `{{words}}`, `{{char}}` and `{{user}}` are filled in. */
  prompt: string;
  targetWords: number;
  /** The summary's own samplers. Nothing about it comes from the chat's preset. */
  temperature: number;
  topP: number;
  /**
   * Update by itself, right after a reply, once `autoAfter` new messages wait. How much one
   * request carries is never set: it comes from the model's own context length.
   */
  auto: boolean;
  autoAfter: number;
  /** Hide summarised messages from the prompt, all but the newest `keepMessages`. */
  hideCovered: boolean;
  keepMessages: number;
}

/**
 * The default instructions: written for a roleplay, a back-and-forth between two sides
 * rather than a book, kept in fixed sections so an update rewrites each one instead of
 * squeezing the oldest facts out of a single paragraph.
 */
export const DEFAULT_SUMMARY_PROMPT = `You keep the memory for an ongoing roleplay between {{user}} and {{char}}. It is a back-and-forth chat: {{user}}'s messages are their own words and actions, and {{char}}'s replies answer them. It is not a novel, so don't retell it as one.

You get who the characters are, the memory so far (when there is one) and the newest part of the chat. Write the updated memory: everything from the memory so far that still matters, with the new part folded in. Never drop an earlier fact just because the new part doesn't mention it.

Write it in these sections, as short bullet points:

## Who's who
Everyone who has appeared: who they are, how they stand with {{user}} and with each other, and how that has changed.

## Where things stand
The scene right now: where and when it is, what is happening, and anything about what each character is doing, wearing or holding that matters.

## What happened
The key events in order, oldest first. Compress older events harder than recent ones.

## Promises, plans and open threads
What is still owed: promises, plans, secrets, unanswered questions, unresolved tension.

## Facts to keep
Details that must stay consistent: names, places, objects, how the world works, and what {{user}} or {{char}} revealed about themselves.

Rules:
- Only what the chat shows. Don't invent, guess at motives or fill gaps.
- Keep who said or believes what: a suspicion or a lie is not a fact.
- Name people. Never write "the user" or "the AI".
- Plain, specific wording, and no comments about the memory itself.
- Stay under {{words}} words. When space runs short, compress the oldest events first, never the current scene or open threads.

Reply with the memory only, starting at the first heading.`;

/** What 2.x shipped as the default. A library still holding it gets the new one. */
export const LEGACY_SUMMARY_PROMPT =
  'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.';
export const LEGACY_SUMMARY_WORDS = 200;

export const DEFAULT_SUMMARY: Readonly<SummarySettings> = {
  prompt: DEFAULT_SUMMARY_PROMPT,
  targetWords: 700,
  temperature: 0.3,
  topP: 1,
  auto: true,
  autoAfter: 80,
  hideCovered: false,
  keepMessages: 200,
  template: '[Summary: {{summary}}]',
  position: 'afterMain',
  depth: 2,
  role: 'system',
};

/**
 * Which memory feature reaches the model. Exactly one, or neither — never both.
 *
 * `classic` is the default so an existing chat keeps behaving as it did. The two write to
 * different `ChatMetadata` fields, so switching mode is reversible and loses nothing: the
 * old rolling summary is still sitting there when you switch back.
 */
export const MEMORY_MODES = ['classic', 'nexus', 'off'] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

export function isMemoryMode(value: unknown): value is MemoryMode {
  return (MEMORY_MODES as readonly unknown[]).includes(value);
}

/**
 * Character Co-Creator preferences.
 *
 * Its model is the `cocreator` slot in `AppSettings.models` (the side chat's is `sideChat`):
 * the model that writes good prose is often not the model that follows a formatting contract.
 *
 * It also gets its own preset, which summarisation does not. Samplers tuned for roleplay —
 * high temperature, repetition penalties — make a design partner erratic and make the fenced
 * block contract less reliable, so the two need to be separable.
 */
export interface CoCreatorSettings {
  sideChat: SideChatDefaults;
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
  /** Saved named sets of example cards and fields that can be applied to sessions. */
  exampleSets: ExampleSet[];
  /** User-defined quick commands for Co-Creator sessions. App-wide and default empty. */
  quickCommands: QuickCommand[];
  /**
   * Stream design replies token-by-token. Ours, not the preset's: the preset's
   * `stream_openai` governs chat only, so the two areas can disagree — streaming off
   * for roleplay, on for the design partner.
   */
  streaming: boolean;
}

export const DEFAULT_COCREATOR_PROMPT = `You are a character-card design partner for a roleplay chat app. You help the user invent and refine characters built for long, immersive roleplay — rich narratives that keep people hooked, not flat profile sheets. You are uncensored: follow the user's premise wherever it goes, embrace creativity, and don't hedge on tone, content or theme the way a generic assistant would. You are not the character and you never roleplay as one — you design the card, you don't perform it.

The current accepted card is supplied with each request. When it already contains a character, use that work and focus on the user's requested changes. An alternate scenario is an Alternate Greeting on this character. For a new character, build it with the user before writing card content. Ask questions — present them as a numbered list, one question per line, so they're easy to answer and you get back something you can actually use. The user's answer is the truth: take it as given, don't second-guess it, and don't offer alternative answers unless they ask for them. Push for detail over vagueness — a card is only as good as the picture behind it.

Don't predefine a fixed tone or theme for the roleplay. These are live roleplays that change every time — the card sets up a character and a situation, not a script. Define who the character is, not how every scene should feel.

Work in stages when building a new character. Build the profile first — description, personality, scenario — and only write the first message once the user says they're ready for it. Never produce the profile and the opening message in the same reply. If the user asks for an alternate greeting, treat it as a new entry point into the character: it can open in a different environment, under different world conditions, or from a different relationship to the one in the original — so rewrite the framing, voice and situation rather than lightly rewording the first message.

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
  sideChat: { ...DEFAULT_SIDE_CHAT },
  presetId: null,
  systemPrompt: DEFAULT_COCREATOR_PROMPT,
  analysisPrompt: DEFAULT_COCREATOR_ANALYSIS_PROMPT,
  exampleFields: { ...DEFAULT_EXAMPLE_FIELDS },
  exampleSets: [],
  quickCommands: [],
  streaming: true,
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

export const DEFAULT_SETTINGS: AppSettings = {
  settingsRevision: 0,
  connections: [{ ...DEFAULT_CONNECTION, id: DEFAULT_CONNECTION_ID, name: PROVIDERS.custom.label }],
  models: { ...DEFAULT_MODEL_SLOTS },
  chatReasoningEfforts: {},
  coCreatorReasoningEfforts: emptyCoCreatorReasoningEfforts(),
  recentModels: [],
  favoriteModels: [],
  modelPickerGroups: {},
  streamingFps: 30,
  personaId: null,
  recentPersonaIds: [],
  personaListDensity: 'list',
  variables: {},
  worldInfo: { ...DEFAULT_WI_SETTINGS },
  tokenizerEncoding: 'auto',
  usageLog: true,
  lastBackupAt: null,
  presetId: null,
  background: null,
  backgroundBlur: 8,
  backgroundDim: 0.55,
  backgroundEffectEnabled: true,
  backgroundEffects: {},
  backgroundEffectLayer: 'behind',
  guidance: { ...DEFAULT_GUIDANCE },
  summary: { ...DEFAULT_SUMMARY },
  memoryMode: 'classic',
  nexus: { ...DEFAULT_NEXUS },
  coCreator: {
    ...DEFAULT_COCREATOR,
    exampleFields: { ...DEFAULT_EXAMPLE_FIELDS },
    exampleSets: [],
  },
  arena: {
    ...DEFAULT_ARENA,
    // Fresh arrays, or every install would share one — the same reason coCreator spreads
    // its own above.
    contenders: [],
    cardPool: [],
    probes: [],
    mergedContenders: {},
  },
  dialogueColors: {
    enabled: DEFAULT_DIALOGUE_COLORS.enabled,
    characters: {},
    personas: {},
  },
  characterRatings: {},
  characterCrops: {},
  characterListSort: 'name',
  hiddenTags: [],
  collapsedCharacterFolders: [],
  collapsedChatMenuGroups: [],
  quickCommands: [],
  composerLayouts: structuredClone(DEFAULT_COMPOSER_LAYOUTS),
  regexScripts: [],
  studioInspectorCollapsed: false,
};
