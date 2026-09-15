import { describe, expect, test } from 'bun:test';
import { matchRanges } from './searchHighlight.ts';

describe('matchRanges', () => {
  test('marks every non-overlapping occurrence, case-insensitively', () => {
    expect(matchRanges('Astrolabe, brass astrolabe, ASTROLABE', 'astrolabe')).toEqual([
      { start: 0, end: 9 },
      { start: 17, end: 26 },
      { start: 28, end: 37 },
    ]);
  });

  test('"aa" in "aaaa" is two hits, not three', () => {
    expect(matchRanges('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  test('a query under the threshold marks nothing, however often it occurs', () => {
    expect(matchRanges('banana', 'a')).toEqual([]);
    expect(matchRanges('banana', '  ')).toEqual([]);
  });

  test('a record that matched on cues or names, not text, marks nothing', () => {
    expect(matchRanges('Ines left for the coast', 'brass')).toEqual([]);
  });

  test('the query is trimmed before matching', () => {
    expect(matchRanges('the astrolabe', ' astrolabe ')).toEqual([{ start: 4, end: 13 }]);
  });
});
