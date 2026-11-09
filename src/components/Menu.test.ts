import { describe, expect, test } from 'bun:test';
import { groupMenuEntries, type MenuAction, type MenuHeader } from './Menu.tsx';

describe('groupMenuEntries', () => {
  const action = (label: string): MenuAction => ({ label, onSelect: () => {} });
  const header = (label: string, hue?: MenuHeader['hue']): MenuHeader => ({
    kind: 'header',
    label,
    hue,
  });

  test('entries before the first header form an implicit untinted run', () => {
    const groups = groupMenuEntries([action('Loose'), header('Chat'), action('New chat')]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.header).toBeUndefined();
    expect(groups[0]!.entries.map((entry) => entry.label)).toEqual(['Loose']);
    expect(groups[1]!.header?.label).toBe('Chat');
  });

  test('a separator stands alone and starts a fresh run for what follows', () => {
    const groups = groupMenuEntries([
      header('Chat'),
      action('New chat'),
      { kind: 'separator' },
      action('Close chat'),
    ]);
    expect(
      groups.map((group) => (group.separator ? 'sep' : (group.header?.label ?? 'run'))),
    ).toEqual(['Chat', 'sep', 'run']);
    expect(groups[2]!.entries.map((entry) => entry.label)).toEqual(['Close chat']);
  });

  test('an empty list groups to nothing', () => {
    expect(groupMenuEntries([])).toEqual([]);
  });
});
