/**
 * World Info / lorebook types.
 *
 * The same data has two on-disk shapes and they differ structurally:
 *  - Standalone book file: `{ entries: { "<uid>": {...} } }`  — entries is an OBJECT keyed by uid
 *  - Embedded `character_book`: `{ name, entries: [...] }`     — entries is an ARRAY
 * Conversion between them lives in shared/worldinfo/convert.ts — shared, not server-side,
 * because the browser needs it for both the embedded editor and the activation engine.
 *
 * Three unrelated things in here are called "depth". They are not interchangeable:
 *  - `WorldInfoSettings.depth` / `WorldInfoEntry.scanDepth` — how many recent MESSAGES to
 *    scan for keywords. Default 2.
 *  - `WorldInfoEntry.depth` — where in the history an `atDepth` entry is SPLICED, counted
 *    back from the end. Default 4.
 *  - `Persona.depth` — the same splice offset, for the persona description. Default 2.
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

/** WiRole is numeric on disk; a DepthInjection wants the string. */
export const WI_ROLE_TO_STRING: Record<WiRole, 'system' | 'user' | 'assistant'> = {
  [WI_ROLE.SYSTEM]: 'system',
  [WI_ROLE.USER]: 'user',
  [WI_ROLE.ASSISTANT]: 'assistant',
};

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
  /**
   * Insertion weight. Sorted DESCENDING then unshifted, so within a bucket the highest
   * `order` ends up last — closest to the chat. Ties are legal; see `displayIndex` for
   * the list order, which is a different thing entirely.
   */
  order: number;
  /** Position in the editor's list. A permutation, unlike `order`, which is a weight. */
  displayIndex: number;
  position: WiPosition;
  disable: boolean;
  ignoreBudget: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: number | boolean;
  probability: number;
  useProbability: boolean;
  /** Splice offset for `position: atDepth`, counted back from the end of the history. */
  depth: number;
  /** Target for `position: outlet`. Carried, not honoured — outlets are out of scope. */
  outletName: string;
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
  /**
   * Timing suppressors. Carried through a round-trip but never read: each can only ever
   * make an entry fire LESS, so ignoring them is noisy rather than wrong. Contrast
   * `vectorized`, which the engine must honour — see activate.ts.
   */
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  triggers?: string[];
  /**
   * The entry's raw `extensions` bag from the character_book, kept verbatim. This is what
   * carries third-party keys and the fields we deliberately don't model — ST nests the
   * character filter here as `character_filter`, so it round-trips without three flat
   * fields nothing populates and nothing reads.
   */
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A standalone lorebook file: entries keyed by uid. */
export interface WorldInfoBook {
  name?: string;
  entries: Record<string, WorldInfoEntry>;
  extensions?: Record<string, unknown>;
  /**
   * Book-level settings the V2 `character_book` spec defines. A standalone ST book has no
   * equivalent, but an embedded one does, so they are carried here to survive a
   * round-trip — and they are the only fields the embedded editor shows that the
   * standalone editor doesn't.
   */
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
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
    displayIndex: uid,
    position: WI_POSITION.before,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: WI_DEFAULT_DEPTH,
    outletName: '',
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
