import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROUP_COMPOSER_LAYOUT,
  DEFAULT_SINGLE_COMPOSER_LAYOUT,
  findComposerItem,
  insertComposerItem,
  insertComposerRow,
  moveComposerItem,
  normalizeComposerLayout,
  pruneEmptyComposerRows,
  removeComposerItem,
  removeComposerRow,
  removeMissingQuickCommands,
  setComposerItemDisplay,
} from './layout.ts';

describe('composer layouts', () => {
  test('a missing or malformed layout restores the chat-type default', () => {
    expect(normalizeComposerLayout(null, 'single', DEFAULT_SINGLE_COMPOSER_LAYOUT)).toEqual(
      DEFAULT_SINGLE_COMPOSER_LAYOUT,
    );
    expect(normalizeComposerLayout({ rows: [] }, 'group', DEFAULT_GROUP_COMPOSER_LAYOUT)).toEqual(
      DEFAULT_GROUP_COMPOSER_LAYOUT,
    );
  });

  test('requires one menu and one send control', () => {
    const missingSend = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    missingSend.rows[0]!.right = missingSend.rows[0]!.right.filter((item) => item.id !== 'send');
    expect(normalizeComposerLayout(missingSend, 'single', DEFAULT_SINGLE_COMPOSER_LAYOUT)).toEqual(
      DEFAULT_SINGLE_COMPOSER_LAYOUT,
    );
  });

  test('drops duplicates and unsupported controls without changing order', () => {
    const value = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    value.rows[0]!.left.push({ id: 'send', display: 'icon' }, { id: 'unknown', display: 'label' });
    const next = normalizeComposerLayout(value, 'single', DEFAULT_SINGLE_COMPOSER_LAYOUT);
    expect(next.rows[0]!.left.map((item) => item.id)).toEqual([
      'persona',
      'menu',
      'quickCommands',
      'nexus',
      'send',
    ]);
    expect(next.rows[0]!.right.some((item) => item.id === 'send')).toBe(false);
  });

  test('moves across rows and alignments and preserves presentation', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    layout.rows.push({ id: 'second', left: [], centre: [], right: [] });
    const next = moveComposerItem(layout, 'impersonate', 'second', 'centre');
    expect(next.rows[1]!.centre).toEqual([{ id: 'impersonate', display: 'icon' }]);
    expect(next.rows[0]!.right.some((item) => item.id === 'impersonate')).toBe(false);
  });

  test('required controls cannot be removed', () => {
    expect(removeComposerItem(DEFAULT_SINGLE_COMPOSER_LAYOUT, 'send')).toEqual(
      DEFAULT_SINGLE_COMPOSER_LAYOUT,
    );
    expect(
      removeComposerItem(DEFAULT_SINGLE_COMPOSER_LAYOUT, 'guide').rows[0]!.right.some(
        (item) => item.id === 'guide',
      ),
    ).toBe(false);
  });

  test('deleted quick commands disappear while live ones remain', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    layout.rows[0]!.centre = [
      { id: 'quick:keep', display: 'label' },
      { id: 'quick:gone', display: 'icon' },
    ];
    expect(removeMissingQuickCommands(layout, new Set(['keep'])).rows[0]!.centre).toEqual([
      { id: 'quick:keep', display: 'label' },
    ]);
  });

  test('finds where a control sits, and reports an unplaced one', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    expect(findComposerItem(layout, 'menu')).toEqual({
      rowId: 'single-main',
      area: 'left',
      index: 1,
      item: { id: 'menu', display: 'icon' },
    });
    expect(findComposerItem(layout, 'checkpoint')).toBeNull();
  });

  test('inserting places a new control at the index and never duplicates', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    const next = insertComposerItem(layout, 'checkpoint', 'single-main', 'centre', 0);
    expect(next.rows[0]!.centre).toEqual([{ id: 'checkpoint', display: 'icon' }]);
    // Already placed: the layout comes back untouched rather than holding the id twice.
    expect(insertComposerItem(next, 'checkpoint', 'single-main', 'left')).toBe(next);
    expect(findComposerItem(next, 'menu')?.area).toBe('left');
  });

  test('inserting appends when the index is left out and clamps past the end', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    const once = insertComposerItem(layout, 'card', 'single-main', 'centre');
    const twice = insertComposerItem(once, 'context', 'single-main', 'centre', 99);
    expect(twice.rows[0]!.centre.map((item) => item.id)).toEqual(['card', 'context']);
  });

  test('rows are added, capped at three, and never duplicated', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    const twoRows = insertComposerRow(layout, 'second', 0);
    expect(twoRows.rows.map((row) => row.id)).toEqual(['second', 'single-main']);
    expect(insertComposerRow(twoRows, 'second', 0)).toBe(twoRows);
    const full = insertComposerRow(insertComposerRow(twoRows, 'third'), 'fourth');
    expect(full.rows).toHaveLength(3);
    expect(insertComposerRow(full, 'fourth')).toBe(full);
  });

  test('removing a row keeps the last one', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    expect(removeComposerRow(layout, 'single-main')).toBe(layout);
    const twoRows = insertComposerRow(layout, 'second');
    expect(removeComposerRow(twoRows, 'second').rows.map((row) => row.id)).toEqual(['single-main']);
    expect(removeComposerRow(twoRows, 'missing')).toBe(twoRows);
  });

  test('pruning drops blank rows but keeps one behind', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    const withBlank = insertComposerRow(layout, 'blank');
    expect(pruneEmptyComposerRows(withBlank).rows.map((row) => row.id)).toEqual(['single-main']);
    const allBlank = {
      rows: [
        { id: 'a', left: [], centre: [], right: [] },
        { id: 'b', left: [], centre: [], right: [] },
      ],
    };
    expect(pruneEmptyComposerRows(allBlank).rows.map((row) => row.id)).toEqual(['a']);
    // Nothing to prune: the same object comes back, so callers can skip a render.
    expect(pruneEmptyComposerRows(layout)).toBe(layout);
  });

  test('display style is set in place and ignored for an unplaced control', () => {
    const layout = structuredClone(DEFAULT_SINGLE_COMPOSER_LAYOUT);
    const labelled = setComposerItemDisplay(layout, 'menu', 'label');
    expect(findComposerItem(labelled, 'menu')?.item.display).toBe('label');
    expect(findComposerItem(labelled, 'persona')?.item.display).toBe('label');
    expect(setComposerItemDisplay(layout, 'checkpoint', 'label')).toBe(layout);
  });
});
