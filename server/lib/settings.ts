/**
 * Application settings.
 *
 * These are ours and deliberately not portable — a preset carries prompts and samplers,
 * this file carries which server you are talking to. Keeping them apart means importing
 * someone else's preset cannot silently repoint your endpoint, and exporting yours cannot
 * leak it.
 *
 * A preset's own connection keys (custom_url, openrouter_model, chat_completion_source)
 * still round-trip untouched via the Preset index signature; they are simply never read.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_GROUP_COMPOSER_LAYOUT,
  DEFAULT_SINGLE_COMPOSER_LAYOUT,
  normalizeComposerLayout,
} from '../../shared/composer/layout.ts';
import { normalizeNexusSettings } from '../../shared/nexus/settings.ts';
import { normalizeBase } from '../../shared/providers/request.ts';
import type { Connection, ConnectionSettings, ProviderId } from '../../shared/providers/types.ts';
import { DEFAULT_CONNECTION, isProviderId, PROVIDERS } from '../../shared/providers/types.ts';
import { normalizeRegexScript } from '../../shared/regex/io.ts';
import type { ArenaProbe, ArenaSettings, Contender } from '../../shared/types/arena.ts';
import { ARENA_MAX_COLUMNS, ARENA_MIN_COLUMNS, DEFAULT_ARENA } from '../../shared/types/arena.ts';
import type { ExampleFields, ExampleSet } from '../../shared/types/cocreator.ts';
import { DEFAULT_EXAMPLE_FIELDS } from '../../shared/types/cocreator.ts';
import type { RegexScript } from '../../shared/types/regex.ts';
import type {
  AppSettings,
  CoCreatorSettings,
  DialogueColorOverride,
  DialogueColorSettings,
  GuidanceSettings,
  MemoryMode,
  MemorySettings,
  QuickCommand,
  SummarySettings,
} from '../../shared/types/settings.ts';
import {
  CHARACTER_RATING_MAX,
  CHARACTER_RATING_MIN,
  DEFAULT_COCREATOR,
  DEFAULT_DIALOGUE_COLORS,
  DEFAULT_GUIDANCE,
  DEFAULT_MEMORY,
  DEFAULT_SETTINGS,
  DEFAULT_SUMMARY,
  MAX_RECENT_PERSONAS,
} from '../../shared/types/settings.ts';
import type { WorldInfoSettings } from '../../shared/types/worldinfo.ts';
import { DEFAULT_WI_SETTINGS } from '../../shared/types/worldinfo.ts';
import { atomicWriteSync } from './fs.ts';
import { PATHS } from './paths.ts';
import { rekeyApiKey } from './secrets.ts';

export type { AppSettings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVariables(value: unknown): AppSettings['variables'] {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    ),
  );
}

/**
 * Coerce one stored connection entry into a valid one, falling back field by field.
 * Returns null for entries that cannot identify a connection — without a usable id the
 * key store and the selection cannot address it.
 */
function normalizeConnectionEntry(value: unknown): Connection | null {
  if (!isRecord(value)) return null;

  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
  if (!id) return null;

  const provider = isProviderId(value.provider) ? value.provider : DEFAULT_CONNECTION.provider;
  const baseUrl =
    typeof value.baseUrl === 'string' && value.baseUrl.trim()
      ? value.baseUrl.trim()
      : PROVIDERS[provider].defaultBaseUrl;

  const connection: Connection = {
    id,
    name:
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : PROVIDERS[provider].label,
    provider,
    baseUrl,
    model: typeof value.model === 'string' ? value.model : '',
    showReasoning: value.showReasoning !== false,
  };

  if (isRecord(value.routing)) connection.routing = value.routing as ConnectionSettings['routing'];
  if (isRecord(value.headers)) connection.headers = value.headers as Record<string, string>;
  if (value.reportUsage === true) connection.reportUsage = true;

  return connection;
}

/** Coerce a stored connection list. Entries without a usable id are dropped. */
function normalizeConnections(value: unknown): Connection[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const connections: Connection[] = [];
  for (const entry of value) {
    const connection = normalizeConnectionEntry(entry);
    // A duplicate id would let one connection read the other's key; first one wins.
    if (!connection || seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(connection);
  }
  return connections;
}

/** A selection that does not name an existing connection falls back to the first. */
function normalizeConnectionId(value: unknown, connections: Connection[]): string | null {
  if (typeof value === 'string' && connections.some((connection) => connection.id === value)) {
    return value;
  }
  return connections[0]?.id ?? null;
}

export interface LegacyConnectionMigration {
  settings: Record<string, unknown>;
  /** The stored API key that must move with the migrated connection, if any. */
  keyMove: { from: ProviderId; to: string } | null;
}

/**
 * The id the migrated connection gets. Deliberately fixed, not a uuid: the migration
 * writes two files, and a deterministic id is what makes a crash between the writes
 * converge on retry instead of stranding the key under the first attempt's id.
 */
export const MIGRATION_CONNECTION_ID = 'legacy';

/**
 * Rewrite the pre-connections shape into the current one, purely.
 *
 * The old format had a single `connection` object and keys stored per provider id. The
 * rewrite wraps that object in a one-entry list and reports the key move, so an upgrade
 * loses neither the connection nor its key. A key stored for a provider other than the
 * active one had no connection to follow and is left behind.
 */
export function migrateLegacyConnection(
  stored: Record<string, unknown>,
  newId: string,
): LegacyConnectionMigration | null {
  if (stored.connections !== undefined || !isRecord(stored.connection)) return null;

  const connection = normalizeConnectionEntry({ ...stored.connection, id: newId });
  if (!connection) return null;

  const settings: Record<string, unknown> = {
    ...stored,
    connections: [connection],
    connectionId: connection.id,
  };
  delete settings.connection;

  return { settings, keyMove: { from: connection.provider, to: connection.id } };
}

/**
 * Apply `migrateLegacyConnection` to the files on disk.
 *
 * Runs from `getSettings` rather than at startup only: the data directory can move, and
 * a library never opened by a new build must migrate on its first read too. The
 * `connection` check makes it idempotent — once rewritten, this is a no-op.
 *
 * The secret is re-keyed BEFORE the settings write, and the id is deterministic. A
 * crash between the two writes leaves the key already under its new id while settings
 * is still legacy — so the retry re-keys (a no-op, the old provider id is empty by
 * then) and writes the same settings. The opposite order, with a fresh uuid per
 * attempt, would leave the key under the first attempt's id and the settings pointing
 * at the second's, and the next settings save would prune the orphan.
 */
function applyLegacyConnectionMigration(stored: Record<string, unknown>): Record<string, unknown> {
  const migration = migrateLegacyConnection(stored, MIGRATION_CONNECTION_ID);
  if (!migration) return stored;

  // A failed write must not take every request down: the session continues on the
  // in-memory migration and the files are retried on the next cache reset.
  try {
    if (migration.keyMove) rekeyApiKey(migration.keyMove.from, migration.keyMove.to);
    atomicWriteSync(PATHS.settings, `${JSON.stringify(migration.settings, null, 2)}\n`);
  } catch (error) {
    console.error('[wackchatter] Could not persist the connections migration:', error);
  }

  return migration.settings;
}

/**
 * Coerce stored World Info settings, field by field.
 *
 * A settings file written before this key existed has no `worldInfo` at all, and a client
 * may legitimately send a single field, so every field falls back to its default
 * independently rather than the object falling back as a whole.
 */
function normalizeWorldInfo(value: unknown): WorldInfoSettings {
  const stored = isRecord(value) ? value : {};
  const pick = <K extends keyof WorldInfoSettings>(key: K): WorldInfoSettings[K] => {
    const candidate = stored[key as string];
    return typeof candidate === typeof DEFAULT_WI_SETTINGS[key]
      ? (candidate as WorldInfoSettings[K])
      : DEFAULT_WI_SETTINGS[key];
  };

  return {
    depth: pick('depth'),
    budget: pick('budget'),
    budgetCap: pick('budgetCap'),
    recursive: pick('recursive'),
    maxRecursionSteps: pick('maxRecursionSteps'),
    caseSensitive: pick('caseSensitive'),
    matchWholeWords: pick('matchWholeWords'),
    minActivations: pick('minActivations'),
  };
}

const INJECTION_ROLES = ['system', 'user', 'assistant'] as const;

function normalizeRole(
  value: unknown,
  fallback: GuidanceSettings['role'],
): GuidanceSettings['role'] {
  return INJECTION_ROLES.includes(value as GuidanceSettings['role'])
    ? (value as GuidanceSettings['role'])
    : fallback;
}

/**
 * Coerce stored Guided Generations settings, field by field, like `normalizeWorldInfo`.
 *
 * The roles cannot go through the same typeof comparison the numbers do: both sides are
 * `string`, so any word at all would pass and the bad role would only surface as a 400
 * from the provider, with nothing pointing back at this file.
 */
function normalizeGuidance(value: unknown): GuidanceSettings {
  const stored = isRecord(value) ? value : {};
  const number = (key: 'depth' | 'guideDepth'): number => {
    const candidate = stored[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? candidate
      : DEFAULT_GUIDANCE[key];
  };

  return {
    template: typeof stored.template === 'string' ? stored.template : DEFAULT_GUIDANCE.template,
    depth: number('depth'),
    role: normalizeRole(stored.role, DEFAULT_GUIDANCE.role),
    guideDepth: number('guideDepth'),
    guideRole: normalizeRole(stored.guideRole, DEFAULT_GUIDANCE.guideRole),
  };
}

const SUMMARY_POSITIONS: SummarySettings['position'][] = [
  'none',
  'beforeMain',
  'afterMain',
  'atDepth',
];

/** Coerce summary preferences and revalidate their optional connection reference. */
function normalizeSummary(value: unknown, connections: Connection[]): SummarySettings {
  const stored = isRecord(value) ? value : {};
  const connectionId =
    typeof stored.connectionId === 'string' &&
    connections.some((connection) => connection.id === stored.connectionId)
      ? stored.connectionId
      : null;
  const targetWords =
    typeof stored.targetWords === 'number' && Number.isFinite(stored.targetWords)
      ? Math.min(1000, Math.max(25, Math.round(stored.targetWords / 25) * 25))
      : DEFAULT_SUMMARY.targetWords;
  const depth =
    typeof stored.depth === 'number' && Number.isFinite(stored.depth)
      ? Math.max(0, Math.floor(stored.depth))
      : DEFAULT_SUMMARY.depth;

  return {
    connectionId,
    prompt: typeof stored.prompt === 'string' ? stored.prompt : DEFAULT_SUMMARY.prompt,
    targetWords,
    template: typeof stored.template === 'string' ? stored.template : DEFAULT_SUMMARY.template,
    position: SUMMARY_POSITIONS.includes(stored.position as SummarySettings['position'])
      ? (stored.position as SummarySettings['position'])
      : DEFAULT_SUMMARY.position,
    depth,
    role: normalizeRole(stored.role, DEFAULT_SUMMARY.role),
  };
}

const MEMORY_MODES: MemoryMode[] = ['classic', 'memories', 'nexus', 'off'];

/** Coerce the memory feature selector. Anything unrecognised falls back to the summary. */
function normalizeMemoryMode(value: unknown): MemoryMode {
  if (value === 'memories') return 'nexus';
  return MEMORY_MODES.includes(value as MemoryMode) ? (value as MemoryMode) : 'classic';
}

/**
 * Coerce memory preferences and revalidate their optional connection reference.
 *
 * The numeric fields are clamped rather than merely type-checked. Every one of them costs
 * money or context when it is wrong: a `windowSize` of 5000 sends the whole chat in one
 * request, and a `budgetTokens` larger than the context makes assembly drop the transcript
 * to make room for memories about it.
 */
function normalizeMemory(value: unknown, connections: Connection[]): MemorySettings {
  const stored = isRecord(value) ? value : {};
  const connectionId =
    typeof stored.connectionId === 'string' &&
    connections.some((connection) => connection.id === stored.connectionId)
      ? stored.connectionId
      : null;

  const clamped = (
    key: 'windowSize' | 'maxMemoryTokens' | 'verbatimTail' | 'budgetTokens' | 'depth',
    min: number,
    max: number,
  ): number => {
    const candidate = stored[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(max, Math.max(min, Math.floor(candidate)))
      : DEFAULT_MEMORY[key];
  };

  // Unlike the others, 0 is a legal value — it is the off switch. Anything positive is
  // clamped rather than defaulted, and the floor keeps a typo of 1 from starting a paid
  // run after every single message.
  const autoInterval = (() => {
    const candidate = stored.autoInterval;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return 0;
    const floored = Math.floor(candidate);
    return floored <= 0 ? 0 : Math.min(2000, Math.max(10, floored));
  })();

  return {
    connectionId,
    presetId: typeof stored.presetId === 'string' && stored.presetId ? stored.presetId : null,
    extractPrompt:
      typeof stored.extractPrompt === 'string' && stored.extractPrompt.trim()
        ? stored.extractPrompt
        : DEFAULT_MEMORY.extractPrompt,
    windowSize: clamped('windowSize', 5, 200),
    autoInterval,
    maxMemoryTokens: clamped('maxMemoryTokens', 100, 4000),
    autoHide: typeof stored.autoHide === 'boolean' ? stored.autoHide : DEFAULT_MEMORY.autoHide,
    verbatimTail: clamped('verbatimTail', 0, 200),
    budgetTokens: clamped('budgetTokens', 0, 32000),
    template: typeof stored.template === 'string' ? stored.template : DEFAULT_MEMORY.template,
    position: SUMMARY_POSITIONS.includes(stored.position as SummarySettings['position'])
      ? (stored.position as SummarySettings['position'])
      : DEFAULT_MEMORY.position,
    depth: clamped('depth', 0, 999),
    role: normalizeRole(stored.role, DEFAULT_MEMORY.role),
  };
}

/**
 * Coerce a stored example-set list.
 *
 * Entries without a usable id are dropped — the persona rule: the id is what edits and
 * deletes address, and a duplicate id would let one set shadow another.
 */
function normalizeExampleSets(value: unknown): ExampleSet[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const sets: ExampleSet[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = typeof entry.name === 'string' ? entry.name : '';
    const cards = Array.isArray(entry.cards)
      ? entry.cards.filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
      : [];

    const storedFields = isRecord(entry.fields) ? entry.fields : {};
    const fields = { ...DEFAULT_EXAMPLE_FIELDS } as ExampleFields;
    for (const key of Object.keys(DEFAULT_EXAMPLE_FIELDS) as (keyof ExampleFields)[]) {
      if (typeof storedFields[key] === 'boolean') fields[key] = storedFields[key];
    }

    sets.push({ id, name, cards, fields });
  }
  return sets;
}

/**
 * Coerce Co-Creator preferences and revalidate their optional connection reference.
 *
 * `presetId` is deliberately NOT validated against anything here: presets are files, not
 * settings, so the server would have to read the directory to check. A dangling id falls
 * back to the active preset on the client, which is the same outcome with less coupling.
 */
function normalizeCoCreator(value: unknown, connections: Connection[]): CoCreatorSettings {
  const stored = isRecord(value) ? value : {};
  const connectionId =
    typeof stored.connectionId === 'string' &&
    connections.some((connection) => connection.id === stored.connectionId)
      ? stored.connectionId
      : null;

  const storedFields = isRecord(stored.exampleFields) ? stored.exampleFields : {};
  const exampleFields = { ...DEFAULT_EXAMPLE_FIELDS } as ExampleFields;
  for (const key of Object.keys(DEFAULT_EXAMPLE_FIELDS) as (keyof ExampleFields)[]) {
    if (typeof storedFields[key] === 'boolean') exampleFields[key] = storedFields[key];
  }

  const exampleSets = normalizeExampleSets(stored.exampleSets);

  return {
    connectionId,
    presetId: typeof stored.presetId === 'string' && stored.presetId ? stored.presetId : null,
    systemPrompt:
      typeof stored.systemPrompt === 'string' && stored.systemPrompt.trim()
        ? stored.systemPrompt
        : DEFAULT_COCREATOR.systemPrompt,
    analysisPrompt:
      typeof stored.analysisPrompt === 'string' && stored.analysisPrompt.trim()
        ? stored.analysisPrompt
        : DEFAULT_COCREATOR.analysisPrompt,
    exampleFields,
    exampleSets,
    quickCommands: normalizeQuickCommands(stored.quickCommands),
    streaming:
      typeof stored.streaming === 'boolean' ? stored.streaming : DEFAULT_COCREATOR.streaming,
  };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeDialogueColorMap(value: unknown): Record<string, DialogueColorOverride> {
  if (!isRecord(value)) return {};

  const entries: Array<[string, DialogueColorOverride]> = [];
  for (const [id, candidate] of Object.entries(value)) {
    if (!id) continue;
    if (candidate === null) entries.push([id, null]);
    else if (typeof candidate === 'string' && HEX_COLOR.test(candidate)) {
      entries.push([id, candidate.toLowerCase()]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Coerce the contender pool, on the same terms as quick commands: an entry with no usable
 * id is dropped, because the id is what edits, deletes and — crucially — recorded rounds
 * address.
 *
 * A contender whose connection has since been deleted is deliberately KEPT. It is unusable,
 * not invalid, and its rounds still name it; dropping it here would quietly rewrite the
 * leaderboard's labels the moment someone tidied their connection list. The panel shows it
 * disabled with a reason instead.
 */
function normalizeContenders(value: unknown): Contender[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const contenders: Contender[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    contenders.push({
      id,
      name: typeof entry.name === 'string' ? entry.name : '',
      connectionId: typeof entry.connectionId === 'string' ? entry.connectionId : '',
      model: typeof entry.model === 'string' ? entry.model : '',
      // Opt-out rather than opt-in: a contender you took the trouble to add is one you
      // meant to benchmark.
      enabled: entry.enabled !== false,
    });
  }
  return contenders;
}

function normalizeProbes(value: unknown): ArenaProbe[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const probes: ArenaProbe[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    probes.push({ id, text: typeof entry.text === 'string' ? entry.text : '' });
  }
  return probes;
}

/** Card filenames. Deduplicated; empty entries dropped. An empty pool means every card. */
function normalizeCardPool(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) seen.add(entry.trim());
  }
  return [...seen];
}

function normalizeArena(value: unknown): ArenaSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_ARENA, contenders: [], cardPool: [], probes: [] };
  }

  const columns = Number(value.columns);
  return {
    contenders: normalizeContenders(value.contenders),
    cardPool: normalizeCardPool(value.cardPool),
    probes: normalizeProbes(value.probes),
    presetId: typeof value.presetId === 'string' && value.presetId ? value.presetId : null,
    personaId: typeof value.personaId === 'string' && value.personaId ? value.personaId : null,
    // Clamped rather than rejected: a hand-edited 9 is a preference expressed badly, and
    // four columns is the answer closest to what it asked for.
    columns: Number.isFinite(columns)
      ? Math.min(ARENA_MAX_COLUMNS, Math.max(ARENA_MIN_COLUMNS, Math.round(columns)))
      : DEFAULT_ARENA.columns,
    holdBlindUntilComplete: value.holdBlindUntilComplete !== false,
    mergedContenders: normalizeMergedContenders(value.mergedContenders),
  };
}

function normalizeDialogueColors(value: unknown): DialogueColorSettings {
  const stored = isRecord(value) ? value : {};
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_DIALOGUE_COLORS.enabled,
    characters: normalizeDialogueColorMap(stored.characters),
    personas: normalizeDialogueColorMap(stored.personas),
  };
}

/**
 * Coerce a stored rating map. A rating is an integer in [1, 5]; everything else is dropped
 * so a hand-edited settings file (or a stale build's value) cannot surface as a UI bug.
 * Keyed by the avatar filename, the same identity the dialogue colours use.
 */
function normalizeCharacterRatings(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  const entries: Array<[string, number]> = [];
  for (const [avatar, candidate] of Object.entries(value)) {
    if (!avatar) continue;
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= CHARACTER_RATING_MIN &&
      candidate <= CHARACTER_RATING_MAX
    ) {
      entries.push([avatar, candidate]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Coerce the stored background→effect pairing map. Only string→string entries survive;
 * the client's effect catalog is the authority on ids, so an id it no longer knows is kept
 * here and degrades to "no effect" at render — the deleted-upload rule for pairings.
 */
function normalizeBackgroundEffects(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const entries: Array<[string, string]> = [];
  for (const [background, candidate] of Object.entries(value)) {
    if (!background || typeof candidate !== 'string' || !candidate) continue;
    entries.push([background, candidate]);
  }
  return Object.fromEntries(entries);
}

/**
 * Coerce the contender merge map. String→string, self-references dropped: an entry pointing
 * at itself is not a merge and would only make the Pool's own "already merged" checks lie.
 *
 * A target id that is not in the pool is deliberately KEPT, on the same terms as a contender
 * whose connection was deleted — it is unresolvable, not invalid. The rounds still name it,
 * and the pool row that was folded away is exactly the one you are likely to remove; the
 * `merges.ts` reader treats a missing target as "not merged" for display, so a kept link is
 * inert rather than wrong, and re-adding the target restores the merge untouched.
 */
function normalizeMergedContenders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const entries: Array<[string, string]> = [];
  for (const [id, target] of Object.entries(value)) {
    if (!id || typeof target !== 'string' || !target || target === id) continue;
    entries.push([id, target]);
  }
  return Object.fromEntries(entries);
}

/** Coerce the app-wide list of tags hidden from character-list chips. */
function normalizeHiddenTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const tag = candidate.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/**
 * Coerce the recently-used persona list: strings only, deduplicated, newest first, capped.
 *
 * Normalised rather than carried wholesale like `collapsedCharacterFolders`, for two
 * reasons. The cap has to be enforced somewhere the client cannot skip, since the list is
 * appended to on every switch and nothing else prunes it. And a malformed body — `null`, or
 * a list of objects — must not reach the client, where this array is mapped over to build
 * the switcher. Unlike `quickCommands` there is nothing to protect from loss: the list is a
 * convenience, and the worst an empty one costs is a search.
 */
function normalizeRecentPersonaIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_RECENT_PERSONAS) break;
  }
  return ids;
}

/**
 * Coerce a stored quick-command list. Entries without a usable id are dropped — the id is
 * what edits and deletes address, and a duplicate id would let one command shadow another.
 */
function normalizeQuickCommands(value: unknown): QuickCommand[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const commands: QuickCommand[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    commands.push({
      id,
      name: typeof entry.name === 'string' ? entry.name : '',
      text: typeof entry.text === 'string' ? entry.text : '',
    });
  }
  return commands;
}

function normalizeComposerLayouts(
  value: unknown,
  current?: AppSettings['composerLayouts'],
  commands: QuickCommand[] = [],
): AppSettings['composerLayouts'] {
  const stored = isRecord(value) ? value : {};
  const quickIds = new Set(commands.map((command) => command.id));
  return {
    single: normalizeComposerLayout(
      stored.single,
      'single',
      current?.single ?? DEFAULT_SINGLE_COMPOSER_LAYOUT,
      quickIds,
    ),
    group: normalizeComposerLayout(
      stored.group,
      'group',
      current?.group ?? DEFAULT_GROUP_COMPOSER_LAYOUT,
      quickIds,
    ),
  };
}

/**
 * Coerce a stored regex-script list, on the same terms as quick commands: an entry with no
 * usable id is dropped, because the id is what edits, deletes and reorders address.
 *
 * Everything else is coerced rather than rejected. `normalizeRegexScript` is shared with the
 * client's importer on purpose — a trust boundary and an import path that disagreed about
 * what a valid script is would be a bug nobody could see from either side.
 */
function normalizeRegexScripts(value: unknown): RegexScript[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const scripts: RegexScript[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    scripts.push(normalizeRegexScript(entry, id));
  }
  return scripts;
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;

  let stored: Record<string, unknown> = {};
  if (existsSync(PATHS.settings)) {
    try {
      const parsed = JSON.parse(readFileSync(PATHS.settings, 'utf8')) as unknown;
      if (isRecord(parsed)) stored = parsed;
    } catch {
      console.error('[wackchatter] settings.json is unreadable — using defaults.');
    }
  }

  stored = applyLegacyConnectionMigration(stored);

  // A missing list gets the seeded default connection; an explicitly empty list is the
  // user having deleted them all, and stays empty.
  const connections =
    stored.connections === undefined
      ? DEFAULT_SETTINGS.connections.map((connection) => ({ ...connection }))
      : normalizeConnections(stored.connections);

  const quickCommands = normalizeQuickCommands(stored.quickCommands);
  cache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    connections,
    connectionId: normalizeConnectionId(stored.connectionId, connections),
    worldInfo: normalizeWorldInfo(stored.worldInfo),
    variables: normalizeVariables(stored.variables),
    guidance: normalizeGuidance(stored.guidance),
    summary: normalizeSummary(stored.summary, connections),
    memoryMode: normalizeMemoryMode(stored.memoryMode),
    nexus: normalizeNexusSettings(stored.nexus),
    memory: normalizeMemory(stored.memory, connections),
    coCreator: normalizeCoCreator(stored.coCreator, connections),
    arena: normalizeArena(stored.arena),
    dialogueColors: normalizeDialogueColors(stored.dialogueColors),
    characterRatings: normalizeCharacterRatings(stored.characterRatings),
    backgroundEffectEnabled:
      typeof stored.backgroundEffectEnabled === 'boolean'
        ? stored.backgroundEffectEnabled
        : DEFAULT_SETTINGS.backgroundEffectEnabled,
    backgroundEffects: normalizeBackgroundEffects(stored.backgroundEffects),
    // Pinned rather than spread, because this one gates a write outside the library: a
    // hand-edited `"usageLog": "yes"` must not read as consent.
    usageLog: stored.usageLog === true,
    // Pinned to the two legal values, the `characterListSort` shape: anything else is a
    // stale or hand-edited file, and behind is the default.
    backgroundEffectLayer: stored.backgroundEffectLayer === 'front' ? 'front' : 'behind',
    characterListSort: stored.characterListSort === 'rating' ? 'rating' : 'name',
    hiddenTags: normalizeHiddenTags(stored.hiddenTags),
    quickCommands,
    composerLayouts: normalizeComposerLayouts(stored.composerLayouts, undefined, quickCommands),
    recentPersonaIds: normalizeRecentPersonaIds(stored.recentPersonaIds),
    // Pinned to the two legal values, the same shape as `characterListSort` above: anything
    // else is a stale or hand-edited file, and rows are the safe default.
    personaListDensity: stored.personaListDensity === 'gallery' ? 'gallery' : 'list',
    regexScripts: normalizeRegexScripts(stored.regexScripts),
  };

  return cache;
}

/**
 * Apply a partial update. Pure, so the merge rules are testable without a filesystem.
 *
 * `worldInfo` and `guidance` merge FIELD-WISE. A shallow spread would drop every field
 * the patch didn't mention, so a client changing only the scan depth would silently
 * reset the budget and every match setting along with it.
 *
 * `connections` is PINNED: the list mutates only through `addConnection`,
 * `patchConnectionEntry` and `deleteConnectionEntry` — the per-connection endpoints.
 * A wholesale array from a client would let a stale tab (or a malformed body like
 * `{"connections": null}`) delete every connection, and the key pruning that follows a
 * deletion would make that irreversible. This is the character-book rule.
 */
export function mergeSettings(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const quickCommands = Array.isArray(patch.quickCommands)
    ? normalizeQuickCommands(patch.quickCommands)
    : current.quickCommands;
  return {
    ...current,
    ...patch,
    connections: current.connections,
    connectionId: normalizeConnectionId(
      patch.connectionId !== undefined ? patch.connectionId : current.connectionId,
      current.connections,
    ),
    worldInfo: patch.worldInfo
      ? normalizeWorldInfo({ ...current.worldInfo, ...patch.worldInfo })
      : current.worldInfo,
    variables: patch.variables ? normalizeVariables(patch.variables) : current.variables,
    guidance: patch.guidance
      ? normalizeGuidance({ ...current.guidance, ...patch.guidance })
      : current.guidance,
    summary: patch.summary
      ? normalizeSummary({ ...current.summary, ...patch.summary }, current.connections)
      : normalizeSummary(current.summary, current.connections),
    memoryMode:
      patch.memoryMode === undefined ? current.memoryMode : normalizeMemoryMode(patch.memoryMode),
    nexus: normalizeNexusSettings({ ...current.nexus, ...patch.nexus }),
    memory: patch.memory
      ? normalizeMemory({ ...current.memory, ...patch.memory }, current.connections)
      : normalizeMemory(current.memory, current.connections),
    coCreator: patch.coCreator
      ? normalizeCoCreator(
          {
            ...current.coCreator,
            ...patch.coCreator,
            // Nested one level deeper than the rest, so it needs its own spread or toggling
            // one field would reset the other seven.
            exampleFields: {
              ...current.coCreator.exampleFields,
              ...(patch.coCreator.exampleFields ?? {}),
            },
            exampleSets:
              patch.coCreator.exampleSets !== undefined
                ? patch.coCreator.exampleSets
                : current.coCreator.exampleSets,
            quickCommands: Array.isArray(patch.coCreator.quickCommands)
              ? patch.coCreator.quickCommands
              : current.coCreator.quickCommands,
          },
          current.connections,
        )
      : normalizeCoCreator(current.coCreator, current.connections),
    // Field-wise like coCreator, and for the same reason — but note the three array
    // sub-fields are guarded on `Array.isArray` rather than merely spread, and the merge map
    // on `isRecord` the way `characterRatings` is: `normalizeArena` turns a non-array into an
    // empty one, so `{"arena": {"contenders": null}}` from a stale tab would otherwise wipe a
    // pool whose ratings history it cannot restore.
    arena: patch.arena
      ? normalizeArena({
          ...current.arena,
          ...patch.arena,
          contenders: Array.isArray(patch.arena.contenders)
            ? patch.arena.contenders
            : current.arena.contenders,
          cardPool: Array.isArray(patch.arena.cardPool)
            ? patch.arena.cardPool
            : current.arena.cardPool,
          probes: Array.isArray(patch.arena.probes) ? patch.arena.probes : current.arena.probes,
          // The client sends the whole map (it holds the loaded settings), so a real object
          // replaces wholesale — the `backgroundEffects` semantics — while a `null` keeps it.
          mergedContenders:
            isRecord(patch.arena.mergedContenders) || patch.arena.mergedContenders === undefined
              ? (patch.arena.mergedContenders ?? current.arena.mergedContenders)
              : current.arena.mergedContenders,
        })
      : current.arena,
    dialogueColors: patch.dialogueColors
      ? normalizeDialogueColors({
          ...current.dialogueColors,
          ...patch.dialogueColors,
          characters:
            patch.dialogueColors.characters === undefined
              ? current.dialogueColors.characters
              : patch.dialogueColors.characters,
          personas:
            patch.dialogueColors.personas === undefined
              ? current.dialogueColors.personas
              : patch.dialogueColors.personas,
        })
      : current.dialogueColors,
    // A wholesale array like `collapsedCharacterFolders`, but normalised: a stale tab or a
    // malformed body like `{"quickCommands": null}` must not wipe the user's commands.
    quickCommands,
    composerLayouts: isRecord(patch.composerLayouts)
      ? normalizeComposerLayouts(
          {
            single: patch.composerLayouts.single ?? current.composerLayouts.single,
            group: patch.composerLayouts.group ?? current.composerLayouts.group,
          },
          current.composerLayouts,
          quickCommands,
        )
      : normalizeComposerLayouts(current.composerLayouts, current.composerLayouts, quickCommands),
    // Normalised on the way in as well as on read, so the cap is enforced where the client
    // cannot skip it — this list is appended to on every persona switch.
    recentPersonaIds: Array.isArray(patch.recentPersonaIds)
      ? normalizeRecentPersonaIds(patch.recentPersonaIds)
      : current.recentPersonaIds,
    // Same treatment, same reason: `{"regexScripts": null}` from a stale tab must not
    // wipe scripts the user wrote by hand.
    regexScripts: Array.isArray(patch.regexScripts)
      ? normalizeRegexScripts(patch.regexScripts)
      : current.regexScripts,
    // A record keyed by avatar filenames, so a stale tab or `{"characterRatings": null}`
    // must not wipe the ratings — the quick-commands guard, applied to a map.
    characterRatings:
      isRecord(patch.characterRatings) || patch.characterRatings === undefined
        ? normalizeCharacterRatings(
            patch.characterRatings === undefined
              ? current.characterRatings
              : patch.characterRatings,
          )
        : current.characterRatings,
    // Same guard for the background→effect pairings. The client always sends the whole
    // map (it holds the loaded settings), so a real object replaces wholesale — the
    // `dialogueColors` semantics — while `{"backgroundEffects": null}` keeps the map.
    backgroundEffects:
      isRecord(patch.backgroundEffects) || patch.backgroundEffects === undefined
        ? normalizeBackgroundEffects(
            patch.backgroundEffects === undefined
              ? current.backgroundEffects
              : patch.backgroundEffects,
          )
        : current.backgroundEffects,
    backgroundEffectLayer:
      patch.backgroundEffectLayer === 'behind' || patch.backgroundEffectLayer === 'front'
        ? patch.backgroundEffectLayer
        : current.backgroundEffectLayer,
    characterListSort:
      patch.characterListSort === 'name' || patch.characterListSort === 'rating'
        ? patch.characterListSort
        : current.characterListSort,
    hiddenTags: Array.isArray(patch.hiddenTags)
      ? normalizeHiddenTags(patch.hiddenTags)
      : current.hiddenTags,
  };
}

/** Merge a partial update and persist. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = mergeSettings(getSettings(), patch);

  atomicWriteSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return next;
}

/**
 * Drop the memoized copy, so the next read comes from whatever settings.json is current.
 *
 * Used by tests, and by the data-directory move — the cached settings belong to the old
 * root and would otherwise be written back over the new one.
 */
export function resetSettingsCache(): void {
  cache = null;
}

/**
 * Whether two connections name the same endpoint. The API key belongs to the endpoint
 * — provider plus base URL — not to the connection's identity, so this is the test for
 * "does the stored key still apply?" after an edit or in a client-submitted probe.
 * Compared after `normalizeBase`, because `http://x/v1` and `http://x/v1/` are one
 * endpoint and a trailing-slash edit must not look like a move.
 */
export function sameEndpoint(
  a: Pick<Connection, 'provider' | 'baseUrl'>,
  b: Pick<Connection, 'provider' | 'baseUrl'>,
): boolean {
  return a.provider === b.provider && normalizeBase(a.baseUrl) === normalizeBase(b.baseUrl);
}

/** The lowest free `<provider label> N`; the first connection takes the bare label. */
export function nextConnectionName(connections: Connection[], provider: ProviderId): string {
  const base = PROVIDERS[provider].label;
  const taken = new Set(connections.map((connection) => connection.name));

  let n = 1;
  let candidate = base;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base} ${n}`;
  }
  return candidate;
}

/**
 * Merge a patch into one entry, normalising the result. Pure, so the merge rules are
 * testable without a filesystem. Returns null when the id names no entry. The id is
 * forced back: it keys the secret store and the selection, so a patch cannot move an
 * entry to a new identity (which would read another connection's key).
 */
export function applyConnectionPatch(
  connections: Connection[],
  id: string,
  patch: Record<string, unknown>,
): Connection[] | null {
  const index = connections.findIndex((connection) => connection.id === id);
  if (index === -1) return null;

  const merged = normalizeConnectionEntry({ ...connections[index], ...patch, id });
  if (!merged) return null;

  const next = [...connections];
  next[index] = merged;
  return next;
}

/**
 * Remove one entry and fix the selection. Pure. Returns null when the id names no
 * entry. A selection pointing at the deleted entry falls back per
 * `normalizeConnectionId`; one pointing elsewhere is kept.
 */
export function dropConnection(
  connections: Connection[],
  selectedId: string | null,
  id: string,
): { connections: Connection[]; connectionId: string | null } | null {
  if (!connections.some((connection) => connection.id === id)) return null;

  const rest = connections.filter((connection) => connection.id !== id);
  return {
    connections: rest,
    connectionId: normalizeConnectionId(selectedId === id ? null : selectedId, rest),
  };
}

/** Persist settings built by the connection mutators below. */
function writeSettings(next: AppSettings): AppSettings {
  atomicWriteSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
  return next;
}

/**
 * Create a connection server-side and activate it.
 *
 * The id and the name are minted here, not by the client: two fast "New connection"
 * clicks — or two tabs — then serialize through this process and each gets its own
 * entry and a collision-free name, instead of one overwriting the other's captured
 * array.
 */
export function addConnection(provider: ProviderId): AppSettings {
  const current = getSettings();
  const connection: Connection = {
    id: crypto.randomUUID(),
    name: nextConnectionName(current.connections, provider),
    provider,
    baseUrl: PROVIDERS[provider].defaultBaseUrl,
    model: '',
    showReasoning: true,
  };

  return writeSettings({
    ...current,
    connections: [...current.connections, connection],
    connectionId: connection.id,
  });
}

/** Edit one entry. Returns null when the id names no entry. */
export function patchConnectionEntry(
  id: string,
  patch: Record<string, unknown>,
): AppSettings | null {
  const current = getSettings();
  const connections = applyConnectionPatch(current.connections, id, patch);
  if (!connections) return null;

  return writeSettings({ ...current, connections });
}

/** Remove one entry and fix the selection. Returns null when the id names no entry. */
export function deleteConnectionEntry(id: string): AppSettings | null {
  const current = getSettings();
  const dropped = dropConnection(current.connections, current.connectionId, id);
  if (!dropped) return null;

  return writeSettings({
    ...current,
    connections: dropped.connections,
    connectionId: dropped.connectionId,
    summary: normalizeSummary(current.summary, dropped.connections),
    memory: normalizeMemory(current.memory, dropped.connections),
    coCreator: normalizeCoCreator(current.coCreator, dropped.connections),
  });
}

/** Re-key or remove the local dialogue colour attached to a character filename. */
export function reassignCharacterDialogueColor(
  current: AppSettings,
  oldAvatar: string,
  newAvatar: string | null,
): AppSettings | null {
  if (!Object.hasOwn(current.dialogueColors.characters, oldAvatar)) return null;

  const characters = { ...current.dialogueColors.characters };
  const value = characters[oldAvatar]!;
  delete characters[oldAvatar];
  if (newAvatar !== null) characters[newAvatar] = value;
  return { ...current, dialogueColors: { ...current.dialogueColors, characters } };
}

/** Remove local appearance state when a stable persona id is deleted. */
export function removePersonaDialogueColor(
  current: AppSettings,
  personaId: string,
): AppSettings | null {
  if (!Object.hasOwn(current.dialogueColors.personas, personaId)) return null;

  const personas = { ...current.dialogueColors.personas };
  delete personas[personaId];
  return { ...current, dialogueColors: { ...current.dialogueColors, personas } };
}

/**
 * Re-key or remove the rating attached to a character filename. The avatar filename is the
 * identity everything else keys on, so a rename moves the rating with it and a delete takes
 * it out. Returns null when there was nothing to move — no save needed.
 */
export function reassignCharacterRating(
  current: AppSettings,
  oldAvatar: string,
  newAvatar: string | null,
): AppSettings | null {
  if (!Object.hasOwn(current.characterRatings, oldAvatar)) return null;

  const ratings = { ...current.characterRatings };
  const value = ratings[oldAvatar]!;
  delete ratings[oldAvatar];
  if (newAvatar !== null) ratings[newAvatar] = value;
  return { ...current, characterRatings: ratings };
}

/**
 * Repoint the global-lorebook selection when a standalone book is renamed or removed.
 *
 * `globalLorebooks` rides the settings index signature rather than a declared field, so it
 * is read defensively: anything that is not an array of strings is left alone. Pure, so the
 * rewrite rule is testable without a filesystem. Returns the updated settings, or null when
 * nothing referenced the old id and there is nothing to persist.
 */
export function reassignGlobalLorebooks(
  current: AppSettings,
  oldId: string,
  newId: string | null,
): AppSettings | null {
  const stored = current.globalLorebooks;
  if (!Array.isArray(stored) || !stored.includes(oldId)) return null;

  const next =
    newId === null
      ? stored.filter((id) => id !== oldId)
      : stored.map((id) => (id === oldId ? newId : id));

  return { ...current, globalLorebooks: next };
}

/**
 * Re-key or remove avatar filenames referenced in saved example sets.
 * When oldAvatar is renamed to newAvatar, occurrences of oldAvatar become newAvatar.
 * When oldAvatar is deleted (newAvatar is null), oldAvatar is removed from any set.
 * Returns updated AppSettings, or null if no sets referenced oldAvatar.
 */
export function reassignCharacterExampleSets(
  current: AppSettings,
  oldAvatar: string,
  newAvatar: string | null,
): AppSettings | null {
  const sets = current.coCreator.exampleSets;
  if (!sets || sets.length === 0) return null;

  let changed = false;
  const updatedSets: ExampleSet[] = sets.map((set) => {
    if (!set.cards.includes(oldAvatar)) return set;
    changed = true;
    const cards =
      newAvatar === null
        ? set.cards.filter((card) => card !== oldAvatar)
        : set.cards.map((card) => (card === oldAvatar ? newAvatar : card));
    return { ...set, cards };
  });

  if (!changed) return null;

  return {
    ...current,
    coCreator: {
      ...current.coCreator,
      exampleSets: updatedSets,
    },
  };
}

/**
 * Re-key or remove the card's slot in the Arena blind-draw pool. The pool stores the same
 * PNG filenames everything else keys on, so a rename carries the slot to the new identity —
 * the draw filters the pool against the library, and a stale entry would silently drop the
 * renamed card from every future round — and a delete takes it out rather than leaving a
 * dead id squatting in the list. Returns null when the pool never named the card — no save
 * needed.
 */
export function reassignArenaCardPool(
  current: AppSettings,
  oldAvatar: string,
  newAvatar: string | null,
): AppSettings | null {
  if (!current.arena.cardPool.includes(oldAvatar)) return null;

  const cardPool =
    newAvatar === null
      ? current.arena.cardPool.filter((id) => id !== oldAvatar)
      : current.arena.cardPool.map((id) => (id === oldAvatar ? newAvatar : id));
  return { ...current, arena: { ...current.arena, cardPool } };
}

/**
 * Repoint or clear preset references when a preset is renamed or deleted.
 * Updates `AppSettings.presetId`, `AppSettings.memory.presetId`,
 * `AppSettings.coCreator.presetId`, and `AppSettings.arena.presetId` — on delete the
 * arena's null means "follow the active preset", which is exactly the degradation wanted.
 */
export function reassignPreset(
  current: AppSettings,
  oldId: string,
  newId: string | null,
): AppSettings | null {
  let changed = false;
  let presetId = current.presetId;
  if (presetId === oldId) {
    presetId = newId;
    changed = true;
  }
  let memoryPresetId = current.memory.presetId;
  if (memoryPresetId === oldId) {
    memoryPresetId = newId;
    changed = true;
  }
  let coCreatorPresetId = current.coCreator.presetId;
  if (coCreatorPresetId === oldId) {
    coCreatorPresetId = newId;
    changed = true;
  }
  let arenaPresetId = current.arena.presetId;
  if (arenaPresetId === oldId) {
    arenaPresetId = newId;
    changed = true;
  }
  if (!changed) return null;
  return {
    ...current,
    presetId,
    memory: { ...current.memory, presetId: memoryPresetId },
    coCreator: { ...current.coCreator, presetId: coCreatorPresetId },
    arena: { ...current.arena, presetId: arenaPresetId },
  };
}
