export const COMPOSER_AREAS = ['left', 'centre', 'right'] as const;
export type ComposerArea = (typeof COMPOSER_AREAS)[number];
export type ComposerLabelMode = 'icon' | 'label';
export type ComposerKind = 'single' | 'group';

export interface ComposerLayoutItem {
  /** A catalog id, or `quick:<opaque quick-command id>`. */
  id: string;
  display: ComposerLabelMode;
}

export interface ComposerLayoutRow {
  id: string;
  left: ComposerLayoutItem[];
  centre: ComposerLayoutItem[];
  right: ComposerLayoutItem[];
}

export interface ComposerLayout {
  rows: ComposerLayoutRow[];
}

export interface ComposerLayouts {
  single: ComposerLayout;
  group: ComposerLayout;
}

export const MAX_COMPOSER_ROWS = 3;
export const REQUIRED_COMPOSER_CONTROLS = ['menu', 'send'] as const;

export const SINGLE_COMPOSER_CONTROLS = [
  'persona',
  'menu',
  'quickCommands',
  'nexus',
  'guides',
  'impersonate',
  'recap',
  'guide',
  'guidedSwipe',
  'send',
  'newChat',
  'checkpoint',
  'regenerate',
  'continue',
  'rename',
  'export',
  'import',
  'card',
  'branches',
  'context',
  'lore',
  'personas',
  'close',
] as const;

export const GROUP_COMPOSER_CONTROLS = [
  'persona',
  'menu',
  'quickCommands',
  'nexus',
  'guide',
  'send',
  'continueConversation',
  'pauseConversation',
  'speakNext',
  'cast',
  'memory',
  'inspect',
  'branches',
  'rename',
  'export',
  'macroCharacter',
  'close',
] as const;

const item = (id: string, display: ComposerLabelMode = 'icon'): ComposerLayoutItem => ({
  id,
  display,
});

export const DEFAULT_SINGLE_COMPOSER_LAYOUT: Readonly<ComposerLayout> = {
  rows: [
    {
      id: 'single-main',
      left: [item('persona', 'label'), item('menu'), item('quickCommands'), item('nexus')],
      centre: [],
      right: [
        item('guides'),
        item('impersonate'),
        item('guide'),
        item('guidedSwipe'),
        item('send', 'label'),
      ],
    },
  ],
};

export const DEFAULT_GROUP_COMPOSER_LAYOUT: Readonly<ComposerLayout> = {
  rows: [
    {
      id: 'group-main',
      left: [item('persona', 'label'), item('menu'), item('quickCommands'), item('nexus')],
      centre: [],
      right: [
        item('continueConversation', 'label'),
        item('pauseConversation', 'label'),
        item('speakNext', 'label'),
        item('guide'),
        item('send', 'label'),
      ],
    },
  ],
};

export const DEFAULT_COMPOSER_LAYOUTS: Readonly<ComposerLayouts> = {
  single: DEFAULT_SINGLE_COMPOSER_LAYOUT,
  group: DEFAULT_GROUP_COMPOSER_LAYOUT,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneComposerLayout(layout: ComposerLayout): ComposerLayout {
  return {
    rows: layout.rows.map((row) => ({
      id: row.id,
      left: row.left.map((entry) => ({ ...entry })),
      centre: row.centre.map((entry) => ({ ...entry })),
      right: row.right.map((entry) => ({ ...entry })),
    })),
  };
}

export function composerControlIds(kind: ComposerKind): ReadonlySet<string> {
  return new Set(kind === 'single' ? SINGLE_COMPOSER_CONTROLS : GROUP_COMPOSER_CONTROLS);
}

export function isComposerControlId(
  id: string,
  kind: ComposerKind,
  quickIds: ReadonlySet<string> = new Set(),
): boolean {
  return composerControlIds(kind).has(id) || (id.startsWith('quick:') && quickIds.has(id.slice(6)));
}

/** Strict enough for storage, forgiving enough that one bad tile cannot erase the layout. */
export function normalizeComposerLayout(
  value: unknown,
  kind: ComposerKind,
  fallback: ComposerLayout,
  quickIds: ReadonlySet<string> = new Set(),
): ComposerLayout {
  if (
    !record(value) ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > MAX_COMPOSER_ROWS
  ) {
    return cloneComposerLayout(fallback);
  }
  const seen = new Set<string>();
  const rowIds = new Set<string>();
  const rows: ComposerLayoutRow[] = [];
  for (const rawRow of value.rows) {
    if (!record(rawRow)) return cloneComposerLayout(fallback);
    const id = typeof rawRow.id === 'string' && rawRow.id.trim() ? rawRow.id.trim() : '';
    if (!id || rowIds.has(id)) return cloneComposerLayout(fallback);
    rowIds.add(id);
    const row: ComposerLayoutRow = { id, left: [], centre: [], right: [] };
    for (const area of COMPOSER_AREAS) {
      if (!Array.isArray(rawRow[area])) return cloneComposerLayout(fallback);
      for (const rawItem of rawRow[area]) {
        if (!record(rawItem) || typeof rawItem.id !== 'string') continue;
        const controlId = rawItem.id.trim();
        if (!controlId || seen.has(controlId) || !isComposerControlId(controlId, kind, quickIds))
          continue;
        seen.add(controlId);
        row[area].push({ id: controlId, display: rawItem.display === 'label' ? 'label' : 'icon' });
      }
    }
    rows.push(row);
  }
  if (REQUIRED_COMPOSER_CONTROLS.some((required) => !seen.has(required)))
    return cloneComposerLayout(fallback);
  return { rows };
}

export function removeMissingQuickCommands(
  layout: ComposerLayout,
  quickIds: ReadonlySet<string>,
): ComposerLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      left: row.left.filter(
        (item) => !item.id.startsWith('quick:') || quickIds.has(item.id.slice(6)),
      ),
      centre: row.centre.filter(
        (item) => !item.id.startsWith('quick:') || quickIds.has(item.id.slice(6)),
      ),
      right: row.right.filter(
        (item) => !item.id.startsWith('quick:') || quickIds.has(item.id.slice(6)),
      ),
    })),
  };
}

export interface ComposerItemLocation {
  rowId: string;
  area: ComposerArea;
  index: number;
  item: ComposerLayoutItem;
}

/** Where a control currently sits, or null when it is not placed. */
export function findComposerItem(layout: ComposerLayout, id: string): ComposerItemLocation | null {
  for (const row of layout.rows)
    for (const area of COMPOSER_AREAS) {
      const index = row[area].findIndex((entry) => entry.id === id);
      if (index >= 0) return { rowId: row.id, area, index, item: row[area][index]! };
    }
  return null;
}

export function moveComposerItem(
  layout: ComposerLayout,
  id: string,
  rowId: string,
  area: ComposerArea,
  index = Number.POSITIVE_INFINITY,
): ComposerLayout {
  const next = cloneComposerLayout(layout);
  let moved: ComposerLayoutItem | undefined;
  for (const row of next.rows)
    for (const key of COMPOSER_AREAS) {
      const at = row[key].findIndex((entry) => entry.id === id);
      if (at >= 0) [moved] = row[key].splice(at, 1);
    }
  if (!moved) return layout;
  const target = next.rows.find((row) => row.id === rowId)?.[area];
  if (!target) return layout;
  target.splice(Math.min(Math.max(0, index), target.length), 0, moved);
  return next;
}

/**
 * Place a control that is not in the layout yet — the drag-in and click-to-add path.
 *
 * A control already placed is left alone rather than duplicated: a layout holds each id at
 * most once (`normalizeComposerLayout` would drop the second), and a drag that lands back
 * on the tray it came from must not look like it did something.
 */
export function insertComposerItem(
  layout: ComposerLayout,
  id: string,
  rowId: string,
  area: ComposerArea,
  index = Number.POSITIVE_INFINITY,
): ComposerLayout {
  if (findComposerItem(layout, id)) return layout;
  const next = cloneComposerLayout(layout);
  const target = next.rows.find((row) => row.id === rowId)?.[area];
  if (!target) return layout;
  target.splice(Math.min(Math.max(0, index), target.length), 0, { id, display: 'icon' });
  return next;
}

/** Add an empty row at `index`, refusing past the row cap or on a duplicate id. */
export function insertComposerRow(
  layout: ComposerLayout,
  rowId: string,
  index = Number.POSITIVE_INFINITY,
): ComposerLayout {
  if (layout.rows.length >= MAX_COMPOSER_ROWS) return layout;
  if (!rowId.trim() || layout.rows.some((row) => row.id === rowId)) return layout;
  const next = cloneComposerLayout(layout);
  next.rows.splice(Math.min(Math.max(0, index), next.rows.length), 0, {
    id: rowId,
    left: [],
    centre: [],
    right: [],
  });
  return next;
}

/** Drop a row whole. The last row stays: a layout always has somewhere to put a control. */
export function removeComposerRow(layout: ComposerLayout, rowId: string): ComposerLayout {
  if (layout.rows.length <= 1) return layout;
  if (!layout.rows.some((row) => row.id === rowId)) return layout;
  const next = cloneComposerLayout(layout);
  return { rows: next.rows.filter((row) => row.id !== rowId) };
}

/**
 * Drop rows nothing lives in, so the tray never shows a blank strip.
 *
 * The all-empty case cannot arise from the editor — a drag always carries a control
 * somewhere — but a layout read back from storage is untrusted, and `normalizeComposerLayout`
 * accepts empty rows inside the cap. One row is kept so the result stays a valid layout.
 */
export function pruneEmptyComposerRows(layout: ComposerLayout): ComposerLayout {
  const next = cloneComposerLayout(layout);
  const kept = next.rows.filter((row) => row.left.length || row.centre.length || row.right.length);
  if (!kept.length) {
    const first = next.rows[0]!;
    return { rows: [{ id: first.id, left: [], centre: [], right: [] }] };
  }
  return kept.length === next.rows.length ? layout : { rows: kept };
}

export function setComposerItemDisplay(
  layout: ComposerLayout,
  id: string,
  display: ComposerLabelMode,
): ComposerLayout {
  if (!findComposerItem(layout, id)) return layout;
  const next = cloneComposerLayout(layout);
  for (const row of next.rows)
    for (const area of COMPOSER_AREAS)
      for (const entry of row[area]) if (entry.id === id) entry.display = display;
  return next;
}

export function removeComposerItem(layout: ComposerLayout, id: string): ComposerLayout {
  if ((REQUIRED_COMPOSER_CONTROLS as readonly string[]).includes(id)) return layout;
  const next = cloneComposerLayout(layout);
  for (const row of next.rows)
    for (const area of COMPOSER_AREAS) {
      row[area] = row[area].filter((item) => item.id !== id);
    }
  return next;
}
