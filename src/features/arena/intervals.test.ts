import { describe, expect, test } from 'bun:test';
import type { ArenaRound, Verdict } from '@shared/types/arena.ts';
import { replayRatings, START_RATING } from './elo.ts';
import { ratingIntervals } from './intervals.ts';

let clock = 0;

function round(left: string, right: string, verdict: Verdict): ArenaRound {
  clock += 1;
  return {
    id: `r${clock}`,
    created: clock,
    characterId: 'Seraphina.png',
    probe: 'Hello.',
    left: { contenderId: left, model: `${left}-model`, provider: 'openrouter', text: 'a' },
    right: { contenderId: right, model: `${right}-model`, provider: 'openrouter', text: 'b' },
    verdict,
  };
}

function ratingFor(rows: ReturnType<typeof replayRatings>, id: string): number {
  const row = rows.find((entry) => entry.contenderId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row.rating;
}

function intervalFor(map: ReturnType<typeof ratingIntervals>, id: string) {
  const interval = map.get(id);
  if (!interval) throw new Error(`no interval for ${id}`);
  return interval;
}

/** a beats b in four of five rounds, scripted so the win rate is 80% at any prefix length. */
function dominantHistory(repeats: number): ArenaRound[] {
  const history: ArenaRound[] = [];
  for (let i = 0; i < repeats; i++) {
    history.push(round('a', 'b', 'left'));
    history.push(round('a', 'b', 'left'));
    history.push(round('a', 'b', 'left'));
    history.push(round('a', 'b', 'left'));
    history.push(round('b', 'a', 'left'));
  }
  return history;
}

describe('ratingIntervals', () => {
  test('is deterministic — same rounds, same whiskers', () => {
    const history = dominantHistory(4);

    expect(ratingIntervals(history)).toEqual(ratingIntervals(history));
  });

  test('is deterministic however the caller assembled the list', () => {
    // The resampling walks the rounds in created order, like replay does, so an array
    // handed over backwards cannot shift the draw sequence.
    const history = dominantHistory(4);

    expect(ratingIntervals([...history].reverse())).toEqual(ratingIntervals(history));
  });

  test('an empty history has no intervals', () => {
    expect(ratingIntervals([]).size).toBe(0);
  });

  test('a history of only rejected rounds has no intervals', () => {
    // A `bad` verdict is recorded evidence that nothing comparative happened. Resampling
    // it would narrow every interval with information that does not exist, so it is not
    // resampled at all — and a history with no rated rounds has nothing to say.
    const history = [round('a', 'b', 'bad'), round('a', 'b', 'bad')];

    expect(ratingIntervals(history).size).toBe(0);
  });

  test('covers every contender that played a rated round', () => {
    const history = [round('a', 'b', 'left'), round('b', 'c', 'right'), round('a', 'c', 'tie')];

    const intervals = ratingIntervals(history);

    expect([...intervals.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a single round cannot be resampled into uncertainty', () => {
    // With one observation, every resample draws that same round: the bootstrap's honest
    // answer is a degenerate band, and the provisional `?` in the UI is what says so.
    const history = [round('a', 'b', 'left')];

    const interval = intervalFor(ratingIntervals(history), 'a');

    expect(interval.low).toBe(interval.high);
    expect(interval.low).toBe(ratingFor(replayRatings(history), 'a'));
  });

  test('a contested history produces a band with width', () => {
    const history: ArenaRound[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(round('a', 'b', i % 2 === 0 ? 'left' : 'right'));
    }

    const intervals = ratingIntervals(history);

    expect(intervalFor(intervals, 'a').high).toBeGreaterThan(intervalFor(intervals, 'a').low);
    expect(intervalFor(intervals, 'b').high).toBeGreaterThan(intervalFor(intervals, 'b').low);
  });

  test('a dominant model is settled apart from its victim', () => {
    // 80% over 100 rounds is a real gap, and the bands must say so without touching —
    // this separation is the whole reason a forest plot beats a column of point ratings.
    const intervals = ratingIntervals(dominantHistory(20));

    expect(intervalFor(intervals, 'a').low).toBeGreaterThan(intervalFor(intervals, 'b').high);
  });

  test('matched contenders produce overlapping bands', () => {
    // A 50/50 split leaves the two ratings genuinely indistinguishable, and the honest
    // picture is bands that overlap — "not settled apart", not a false precision gap.
    const history: ArenaRound[] = [];
    for (let i = 0; i < 12; i++) {
      history.push(round('a', 'b', i % 2 === 0 ? 'left' : 'right'));
    }

    const intervals = ratingIntervals(history);

    expect(intervalFor(intervals, 'a').high).toBeGreaterThan(intervalFor(intervals, 'b').low);
    expect(intervalFor(intervals, 'b').high).toBeGreaterThan(intervalFor(intervals, 'a').low);
  });

  test('a mirror history gives mirrored bands', () => {
    // Every decisive round is zero-sum, so in any resample a's final plus b's final is
    // exactly twice the start. The 2.5th percentile of one is the 97.5th of the other —
    // the whole pipeline (resample, shared update, percentile) in one assertion.
    const history: ArenaRound[] = [];
    for (let i = 0; i < 8; i++) {
      history.push(round('a', 'b', i % 3 === 0 ? 'right' : 'left'));
      history.push(round('b', 'a', i % 3 === 0 ? 'right' : 'left'));
    }

    const intervals = ratingIntervals(history);
    const a = intervalFor(intervals, 'a');
    const b = intervalFor(intervals, 'b');

    // Integer rounding of a half-integer pair can miss the exact mirror by one.
    expect(Math.abs(a.low + b.high - START_RATING * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.high + b.low - START_RATING * 2)).toBeLessThanOrEqual(1);
  });
});
