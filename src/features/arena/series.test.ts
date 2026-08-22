import { describe, expect, test } from 'bun:test';
import type { Contender } from '@shared/types/arena.ts';
import { fallbackSlot, poolSlots, SERIES_COUNT, seriesToken, viewSeries } from './series.ts';

function contender(id: string): Contender {
  return { id, name: '', connectionId: 'c', model: 'm', enabled: true };
}

describe('seriesToken', () => {
  test('is one-based, matching the tokens in tokens.css', () => {
    expect(seriesToken(0)).toBe('var(--wc-series-1)');
    expect(seriesToken(7)).toBe('var(--wc-series-8)');
  });

  test('wraps rather than running off the end of the palette', () => {
    expect(seriesToken(SERIES_COUNT)).toBe(seriesToken(0));
    expect(seriesToken(-1)).toBe(seriesToken(SERIES_COUNT - 1));
  });
});

describe('poolSlots', () => {
  test('assigns by pool order, so dragging the roster moves the colour', () => {
    const slots = poolSlots([contender('a'), contender('b'), contender('c')]);
    expect(slots.get('a')).toBe(0);
    expect(slots.get('b')).toBe(1);
    expect(slots.get('c')).toBe(2);
  });

  test('wraps past the palette', () => {
    const many = Array.from({ length: 10 }, (_, index) => contender(`c${index}`));
    expect(poolSlots(many).get('c8')).toBe(0);
  });
});

describe('fallbackSlot', () => {
  test('is stable for an id, so a deleted contender keeps its colour as ratings move', () => {
    expect(fallbackSlot('deleted-entrant')).toBe(fallbackSlot('deleted-entrant'));
  });

  test('lands inside the palette for any id', () => {
    for (const id of ['', 'a', 'x'.repeat(200), '💥', crypto.randomUUID()]) {
      const slot = fallbackSlot(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SERIES_COUNT);
    }
  });
});

describe('viewSeries', () => {
  test('honours the pool position when it is free', () => {
    const pool = poolSlots([contender('a'), contender('b')]);
    const colours = viewSeries(['a', 'b'], pool);
    expect(colours.get('a')).toBe('var(--wc-series-1)');
    expect(colours.get('b')).toBe('var(--wc-series-2)');
  });

  test('two entrants on screen together never share a colour', () => {
    // Nine in the pool: the ninth prefers slot 0, which the first already holds.
    const pool = poolSlots(Array.from({ length: 9 }, (_, index) => contender(`c${index}`)));
    const colours = viewSeries(['c0', 'c8'], pool);
    expect(colours.get('c0')).not.toBe(colours.get('c8'));
  });

  test('a view of eight uses every token exactly once', () => {
    const pool = poolSlots(Array.from({ length: 8 }, (_, index) => contender(`c${index}`)));
    const ids = Array.from({ length: 8 }, (_, index) => `c${index}`);
    const colours = viewSeries(ids, pool);
    expect(new Set(colours.values()).size).toBe(SERIES_COUNT);
  });

  test('past eight it repeats rather than dropping an entrant', () => {
    const pool = poolSlots(Array.from({ length: 9 }, (_, index) => contender(`c${index}`)));
    const ids = Array.from({ length: 9 }, (_, index) => `c${index}`);
    const colours = viewSeries(ids, pool);
    expect(colours.size).toBe(9);
    for (const id of ids) expect(colours.get(id)).toMatch(/^var\(--wc-series-[1-8]\)$/);
  });

  test('adding an entrant does not move the ones already placed', () => {
    const pool = poolSlots([contender('a'), contender('b'), contender('c')]);
    const before = viewSeries(['a', 'b'], pool);
    const after = viewSeries(['a', 'b', 'c'], pool);
    expect(after.get('a')).toBe(before.get('a'));
    expect(after.get('b')).toBe(before.get('b'));
  });

  test('an id with no pool entry still gets a colour', () => {
    const colours = viewSeries(['ghost'], new Map());
    expect(colours.get('ghost')).toMatch(/^var\(--wc-series-[1-8]\)$/);
  });

  test('is order-stable: the same ids give the same answer twice', () => {
    const pool = poolSlots([contender('a'), contender('b')]);
    expect([...viewSeries(['b', 'a'], pool)]).toEqual([...viewSeries(['b', 'a'], pool)]);
  });

  test('ignores a repeated id rather than assigning it twice', () => {
    const pool = poolSlots([contender('a')]);
    const colours = viewSeries(['a', 'a'], pool);
    expect(colours.size).toBe(1);
  });
});
