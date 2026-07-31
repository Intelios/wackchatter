/**
 * World Info / lorebook types.
 *
 * The same data has two on-disk shapes and they differ structurally:
 *  - Standalone book file: `{ entries: { "<uid>": {...} } }`  — entries is an OBJECT keyed by uid
 *  - Embedded `character_book`: `{ name, entries: [...] }`     — entries is an ARRAY
 * Conversion between them lives in server/lib/lorebook.ts.
 */

export const WI_LOGIC = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const;

export type WiLogic = (typeof WI_LOGIC)[keyof typeof WI_LOGIC];

export const WI_POSITION = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const;

export type WiPosition = (typeof WI_POSITION)[keyof typeof WI_POSITION];

export const WI_DEFAULT_DEPTH = 4;
export const WI_DEFAULT_WEIGHT = 100;

/** Role used for at-depth injection. Mirrors ST's extension_prompt_roles. */
export const WI_ROLE = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const;

export type WiRole = (typeof WI_ROLE)[keyof typeof WI_ROLE];

/** A lorebook entry in our internal (ST standalone-file) shape. */
export interface WorldInfoEntry {
  uid: number;
  /** Primary keys. A `/pattern/flags` literal is treated as a regex. */
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  /** Always active, no keyword scan. */
  constant: boolean;
  /** Use secondary keys with `selectiveLogic`. */
  selective: boolean;
  selectiveLogic: WiLogic;
  addMemo: boolean;
  /** Insertion order — higher sorts later within a bucket. */
  order: number;
  position: WiPosition;
  disable: boolean;
  ignoreBudget: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: number | boolean;
  probability: number;
  useProbability: boolean;
  /** Depth for `position: atDepth`. */
  depth: number;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  /** Per-entry overrides of the global scan settings; null = inherit. */
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string;
  role: WiRole;
  vectorized: boolean;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  characterFilterNames?: string[];
  characterFilterTags?: string[];
  characterFilterExclude?: boolean;
  triggers?: string[];
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A standalone lorebook file: entries keyed by uid. */
export interface WorldInfoBook {
  name?: string;
  entries: Record<string, WorldInfoEntry>;
  extensions?: Record<string, unknown>;
  /** Set when the book came from an imported character_book, so we can round-trip verbatim. */
  originalData?: unknown;
  [key: string]: unknown;
}

export interface LorebookSummary {
  /** Filename without extension — the unique ID. */
  id: string;
  name: string;
  entryCount: number;
  modified: number;
}

/** Global scan settings. ST stores these per-app, not per-book. */
export interface WorldInfoSettings {
  /** How many recent messages to scan for keywords. */
  depth: number;
  /** Percentage of max context reserved for lorebook content. */
  budget: number;
  /** Absolute token cap; 0 = no cap. */
  budgetCap: number;
  /** Activated entries' own text can trigger further entries. */
  recursive: boolean;
  maxRecursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  minActivations: number;
}

export const DEFAULT_WI_SETTINGS: WorldInfoSettings = {
  depth: 2,
  budget: 25,
  budgetCap: 0,
  recursive: true,
  maxRecursionSteps: 3,
  caseSensitive: false,
  matchWholeWords: true,
  minActivations: 0,
};

/** Blank entry template — every field defaulted, matching ST's newWorldInfoEntryTemplate. */
export function createWorldInfoEntry(uid: number): WorldInfoEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    selective: true,
    selectiveLogic: WI_LOGIC.AND_ANY,
    addMemo: false,
    order: 100,
    position: WI_POSITION.before,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: WI_DEFAULT_DEPTH,
    group: '',
    groupOverride: false,
    groupWeight: WI_DEFAULT_WEIGHT,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: WI_ROLE.SYSTEM,
    vectorized: false,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    extensions: {},
  };
}
