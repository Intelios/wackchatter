import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROUP_COMPOSER_LAYOUT,
  DEFAULT_SINGLE_COMPOSER_LAYOUT,
  moveComposerItem,
  normalizeComposerLayout,
  removeComposerItem,
  removeMissingQuickCommands,
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
});
