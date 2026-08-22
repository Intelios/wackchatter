import { describe, expect, test } from 'bun:test';
import type { ArenaRound, Verdict } from '@shared/types/arena.ts';
import { allPairings, headToHead, matchupOf, unplayedPairings, winRate } from './matchups.ts';

let clock = 0;

function round(left: string, right: string, verdict: Verdict): ArenaRound {
  clock += 1;
  return {
    id: `r${clock}`,
    created: clock,
    characterId: 'card.png',
    probe: 'probe',
    left: { contenderId: left, model: left, provider: 'openai', text: 'a' },
    right: { contenderId: right, model: right, provider: 'openai', text: 'b' },
    verdict,
  };
}

describe('headToHead', () => {
  test('records a win from both sides', () => {
    const table = headToHead([round('a', 'b', 'left')]);
    expect(matchupOf(table, 'a', 'b')).toMatchObject({ wins: 1, losses: 0, played: 1 });
    expect(matchupOf(table, 'b', 'a')).toMatchObject({ wins: 0, losses: 1, played: 1 });
  });

  test('a right-side win is a win for the right contender', () => {
    const table = headToHead([round('a', 'b', 'right')]);
    expect(matchupOf(table, 'b', 'a').wins).toBe(1);
    expect(matchupOf(table, 'a', 'b').losses).toBe(1);
  });

  test('a tie counts for both', () => {
    const table = headToHead([round('a', 'b', 'tie')]);
    expect(matchupOf(table, 'a', 'b').ties).toBe(1);
    expect(matchupOf(table, 'b', 'a').ties).toBe(1);
  });

  test('a rejected round is counted but never scored', () => {
    const table = headToHead([round('a', 'b', 'bad')]);
    const entry = matchupOf(table, 'a', 'b');
    expect(entry.rejected).toBe(1);
    expect(entry.played).toBe(0);
    expect(entry.wins + entry.losses + entry.ties).toBe(0);
  });

  test('sides are symmetric however the coin flip landed', () => {
    const table = headToHead([round('a', 'b', 'left'), round('b', 'a', 'left')]);
    // a beat b once; then b beat a once. One win each.
    expect(matchupOf(table, 'a', 'b')).toMatchObject({ wins: 1, losses: 1, played: 2 });
    expect(matchupOf(table, 'b', 'a')).toMatchObject({ wins: 1, losses: 1, played: 2 });
  });

  test('keeps pairings apart', () => {
    const table = headToHead([round('a', 'b', 'left'), round('a', 'c', 'right')]);
    expect(matchupOf(table, 'a', 'b').wins).toBe(1);
    expect(matchupOf(table, 'a', 'c').losses).toBe(1);
    expect(matchupOf(table, 'b', 'c').played).toBe(0);
  });

  test('an unmet pairing reads as empty, not as a loss', () => {
    const table = headToHead([]);
    expect(matchupOf(table, 'a', 'b')).toMatchObject({ played: 0, wins: 0, losses: 0 });
  });

  test('ignores a round a contender somehow played against itself', () => {
    const table = headToHead([round('a', 'a', 'left')]);
    expect(matchupOf(table, 'a', 'a').played).toBe(0);
  });
});

describe('winRate', () => {
  test('is null when they have never had a scored round', () => {
    expect(winRate({ wins: 0, losses: 0, ties: 0, played: 0, rejected: 3 })).toBeNull();
  });

  test('counts a tie as half, matching the Elo score', () => {
    expect(winRate({ wins: 1, losses: 1, ties: 2, played: 4, rejected: 0 })).toBe(0.5);
  });

  test('a clean sweep is 1', () => {
    expect(winRate({ wins: 3, losses: 0, ties: 0, played: 3, rejected: 0 })).toBe(1);
  });
});

describe('pairings', () => {
  test('enumerates each unordered pair once', () => {
    expect(allPairings(['a', 'b', 'c'])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  test('a single entrant has no pairings', () => {
    expect(allPairings(['a'])).toEqual([]);
  });

  test('counts the pairings still to be played', () => {
    const table = headToHead([round('a', 'b', 'left')]);
    expect(unplayedPairings(table, ['a', 'b', 'c'])).toBe(2);
  });

  test('a rejected round leaves the pairing unplayed, because it settled nothing', () => {
    const table = headToHead([round('a', 'b', 'bad')]);
    expect(unplayedPairings(table, ['a', 'b'])).toBe(1);
  });
});
