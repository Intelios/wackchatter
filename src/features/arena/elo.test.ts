import { describe, expect, test } from 'bun:test';
import type { ArenaRound, Contender, Verdict } from '@shared/types/arena.ts';
import {
  K_FACTOR,
  PROVISIONAL_ROUNDS,
  previewVerdict,
  replay,
  replayRatings,
  START_RATING,
} from './elo.ts';

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

function contender(id: string): Contender {
  return { id, name: id, connectionId: 'or', model: `${id}-model`, enabled: true };
}

function rowFor(rows: ReturnType<typeof replayRatings>, id: string) {
  const row = rows.find((entry) => entry.contenderId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe('replayRatings', () => {
  test('no rounds leaves the pool level and provisional', () => {
    const rows = replayRatings([], [contender('a'), contender('b')]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.rating === START_RATING)).toBe(true);
    expect(rows.every((row) => row.provisional)).toBe(true);
    expect(rows.every((row) => row.rounds === 0)).toBe(true);
  });

  test('a first win between equals moves exactly half of K', () => {
    // Equal ratings mean an expected score of 0.5 each, so the winner gains K * 0.5.
    const rows = replayRatings([round('a', 'b', 'left')], [contender('a'), contender('b')]);

    expect(rowFor(rows, 'a').rating).toBe(START_RATING + K_FACTOR / 2);
    expect(rowFor(rows, 'b').rating).toBe(START_RATING - K_FACTOR / 2);
  });

  test('ratings are zero-sum across a round', () => {
    const rows = replayRatings(
      [round('a', 'b', 'left'), round('b', 'a', 'left'), round('a', 'b', 'tie')],
      [contender('a'), contender('b')],
    );

    expect(rowFor(rows, 'a').rating + rowFor(rows, 'b').rating).toBe(START_RATING * 2);
  });

  test('a tie between equals moves nothing', () => {
    const rows = replayRatings([round('a', 'b', 'tie')], [contender('a'), contender('b')]);

    expect(rowFor(rows, 'a').rating).toBe(START_RATING);
    expect(rowFor(rows, 'a').ties).toBe(1);
    expect(rowFor(rows, 'b').ties).toBe(1);
  });

  test('a tie against a stronger opponent still moves both ratings', () => {
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left'), round('a', 'b', 'tie')];
    const rows = replayRatings(history, [contender('a'), contender('b')]);

    // a is now favoured, so drawing costs it and earns b.
    expect(rowFor(rows, 'a').rating).toBeLessThan(START_RATING + K_FACTOR);
    expect(rowFor(rows, 'b').rating).toBeGreaterThan(START_RATING - K_FACTOR);
  });

  test('"both bad" records the round and moves no ratings at all', () => {
    // The rule the whole verdict exists for: it is not a draw. Two models can fail one card
    // for unrelated reasons, and rating that as equality would drag a strong model down.
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left')];
    const before = replayRatings(history, [contender('a'), contender('b')]);
    const after = replayRatings(
      [...history, round('a', 'b', 'bad')],
      [contender('a'), contender('b')],
    );

    expect(rowFor(after, 'a').rating).toBe(rowFor(before, 'a').rating);
    expect(rowFor(after, 'b').rating).toBe(rowFor(before, 'b').rating);
    expect(rowFor(after, 'a').rejected).toBe(1);
    expect(rowFor(after, 'b').rejected).toBe(1);
    // And it does not count toward the rated total either, so it cannot quietly graduate a
    // contender out of provisional.
    expect(rowFor(after, 'a').rounds).toBe(rowFor(before, 'a').rounds);
  });

  test('the replay is deterministic — same rounds, same ratings', () => {
    const history = [
      round('a', 'b', 'left'),
      round('b', 'c', 'right'),
      round('a', 'c', 'tie'),
      round('c', 'a', 'left'),
    ];
    const pool = [contender('a'), contender('b'), contender('c')];

    expect(replayRatings(history, pool)).toEqual(replayRatings(history, pool));
  });

  test('order matters, and is taken from created rather than array position', () => {
    const first = round('a', 'b', 'left');
    const second = round('a', 'b', 'right');
    const pool = [contender('a'), contender('b')];

    // Elo is path-dependent, so a shuffled array must still replay chronologically.
    expect(replayRatings([second, first], pool)).toEqual(replayRatings([first, second], pool));
  });

  test('a round is provisional until PROVISIONAL_ROUNDS rated rounds are behind it', () => {
    const history = Array.from({ length: PROVISIONAL_ROUNDS - 1 }, () => round('a', 'b', 'left'));
    expect(rowFor(replayRatings(history), 'a').provisional).toBe(true);

    history.push(round('a', 'b', 'left'));
    const row = rowFor(replayRatings(history), 'a');
    expect(row.rounds).toBe(PROVISIONAL_ROUNDS);
    expect(row.provisional).toBe(false);
  });

  test('established ratings rank above provisional ones whatever the number says', () => {
    // `new` wins its only round and outrates nobody; `veteran` has a real history. Sorting
    // on rating alone would put the two-round entrant on top and read as a ranking.
    const history: ArenaRound[] = [];
    for (let i = 0; i < PROVISIONAL_ROUNDS; i++) history.push(round('veteran', 'filler', 'left'));
    history.push(round('newcomer', 'filler', 'left'));

    const rows = replayRatings(history);
    expect(rows[0]?.contenderId).toBe('veteran');
    expect(rowFor(rows, 'newcomer').provisional).toBe(true);
  });

  test('a contender deleted from the pool keeps its history, labelled by what it ran', () => {
    // Only `a` is still in the pool; `ghost` fought and was removed.
    const rows = replayRatings([round('a', 'ghost', 'right')], [contender('a')]);

    const ghost = rowFor(rows, 'ghost');
    expect(ghost.wins).toBe(1);
    expect(ghost.model).toBe('ghost-model');
    expect(ghost.provider).toBe('openrouter');
  });

  test('a pool entry that has never fought carries no model label to fall back to', () => {
    expect(rowFor(replayRatings([], [contender('a')]), 'a').model).toBe('');
  });

  test('the model label follows the most recent round, not the first', () => {
    const early = round('a', 'b', 'left');
    const late = round('a', 'b', 'left');
    late.left.model = 'repointed/model';

    expect(rowFor(replayRatings([early, late]), 'a').model).toBe('repointed/model');
  });

  test('wins, losses and ties add up to the rated round count', () => {
    const rows = replayRatings([
      round('a', 'b', 'left'),
      round('a', 'b', 'right'),
      round('a', 'b', 'tie'),
      round('a', 'b', 'bad'),
    ]);

    const a = rowFor(rows, 'a');
    expect(a.wins + a.losses + a.ties).toBe(a.rounds);
    expect(a.rounds).toBe(3);
    expect(a.rejected).toBe(1);
  });
});

describe('replay history', () => {
  function seriesFor(result: ReturnType<typeof replay>, id: string) {
    const found = result.series.find((entry) => entry.contenderId === id);
    if (!found) throw new Error(`no series for ${id}`);
    return found;
  }

  test('every line has one point per round, plus the starting point', () => {
    const history = [round('a', 'b', 'left'), round('a', 'b', 'right'), round('a', 'b', 'tie')];
    const result = replay(history, [contender('a'), contender('b')]);

    for (const series of result.series) {
      expect(series.points).toHaveLength(history.length + 1);
      expect(series.points[0]).toEqual({ index: 0, rating: START_RATING, delta: 0 });
    }
  });

  test('lines are all the same length, so they can be read against each other', () => {
    // `late` first appears at round three; its line still has to start at round zero.
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left'), round('a', 'late', 'left')];
    const result = replay(history, [contender('a'), contender('b')]);

    const lengths = new Set(result.series.map((entry) => entry.points.length));
    expect(lengths).toEqual(new Set([history.length + 1]));
  });

  test('a contender that appears late is backfilled at the starting rating', () => {
    const history = [round('a', 'b', 'left'), round('a', 'late', 'left')];
    const late = seriesFor(replay(history), 'late');

    expect(late.points.slice(0, 2).map((point) => point.rating)).toEqual([
      START_RATING,
      START_RATING,
    ]);
    expect(late.points.slice(0, 2).every((point) => point.delta === 0)).toBe(true);
    // And it really did lose the round it finally played.
    expect(late.points[2]?.delta).toBeLessThan(0);
  });

  test('the last point on a line is exactly the rating on the table', () => {
    const history = [
      round('a', 'b', 'left'),
      round('b', 'c', 'right'),
      round('a', 'c', 'tie'),
      round('c', 'a', 'left'),
    ];
    const result = replay(history, [contender('a'), contender('b'), contender('c')]);

    for (const row of result.rows) {
      expect(seriesFor(result, row.contenderId).points.at(-1)?.rating).toBe(row.rating);
    }
  });

  test('a first win between equals moves the line by half of K', () => {
    const result = replay([round('a', 'b', 'left')], [contender('a'), contender('b')]);

    expect(seriesFor(result, 'a').points[1]).toEqual({
      index: 1,
      rating: START_RATING + K_FACTOR / 2,
      delta: K_FACTOR / 2,
    });
    expect(seriesFor(result, 'b').points[1]?.delta).toBe(-K_FACTOR / 2);
  });

  test('a round a contender sat out records a point with no movement', () => {
    // `c` is in the pool but never plays, so its line is flat at the starting rating.
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left')];
    const result = replay(history, [contender('a'), contender('b'), contender('c')]);

    const c = seriesFor(result, 'c');
    expect(c.points).toHaveLength(3);
    expect(c.points.every((point) => point.delta === 0)).toBe(true);
    expect(c.points.every((point) => point.rating === START_RATING)).toBe(true);
  });

  test('a rejected round still takes a slot on the axis but moves nothing', () => {
    // The x axis counts rounds judged, and a rejected round cost the same to judge.
    const history = [round('a', 'b', 'left'), round('a', 'b', 'bad')];
    const result = replay(history, [contender('a'), contender('b')]);

    const a = seriesFor(result, 'a');
    expect(a.points).toHaveLength(3);
    expect(a.points[2]?.delta).toBe(0);
    expect(a.points[2]?.rating).toBe(a.points[1]?.rating);
  });

  test('deltas sum to the distance travelled from the starting rating', () => {
    const history = [
      round('a', 'b', 'left'),
      round('a', 'b', 'right'),
      round('a', 'b', 'left'),
      round('a', 'b', 'tie'),
    ];
    const a = seriesFor(replay(history), 'a');
    const travelled = a.points.reduce((total, point) => total + point.delta, 0);

    expect(START_RATING + travelled).toBe(a.points.at(-1)?.rating ?? 0);
  });

  test('series follow the table order, so chart and rows read the same way', () => {
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left')];
    const result = replay(history, [contender('a'), contender('b')]);

    expect(result.series.map((entry) => entry.contenderId)).toEqual(
      result.rows.map((row) => row.contenderId),
    );
  });

  test('the replayed order is chronological, whatever order it was handed', () => {
    const first = round('a', 'b', 'left');
    const second = round('a', 'b', 'right');

    expect(replay([second, first]).ordered.map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  test('replayRatings still answers exactly what replay does', () => {
    const history = [round('a', 'b', 'left'), round('a', 'b', 'tie')];
    expect(replayRatings(history)).toEqual(replay(history).rows);
  });
});

describe('previewVerdict', () => {
  const sides = (left: string, right: string) => ({
    characterId: 'Seraphina.png',
    probe: 'Hello.',
    left: { contenderId: left, model: `${left}-model`, provider: 'openrouter', text: 'a' },
    right: { contenderId: right, model: `${right}-model`, provider: 'openrouter', text: 'b' },
  });

  test('a first win moves both ratings away from the start, symmetrically', () => {
    const preview = previewVerdict([], [], { ...sides('a', 'b'), verdict: 'left' });
    expect(preview.left.before).toBe(START_RATING);
    expect(preview.right.before).toBe(START_RATING);
    expect(preview.left.delta).toBeGreaterThan(0);
    expect(preview.right.delta).toBeLessThan(0);
    expect(preview.left.delta).toBe(-preview.right.delta);
  });

  test('after equals before plus delta, so the reveal reconciles with itself', () => {
    const preview = previewVerdict([], [], { ...sides('a', 'b'), verdict: 'right' });
    expect(preview.left.after).toBe(preview.left.before + preview.left.delta);
    expect(preview.right.after).toBe(preview.right.before + preview.right.delta);
  });

  test('a rejected round moves nothing, exactly as the replay scores it', () => {
    const preview = previewVerdict([], [], { ...sides('a', 'b'), verdict: 'bad' });
    expect(preview.left.delta).toBe(0);
    expect(preview.right.delta).toBe(0);
  });

  test('agrees with the leaderboard once the round is actually recorded', () => {
    const history = [round('a', 'b', 'left'), round('a', 'b', 'left')];
    const preview = previewVerdict(history, [], { ...sides('a', 'b'), verdict: 'right' });

    const recorded: ArenaRound = {
      ...sides('a', 'b'),
      verdict: 'right',
      id: 'real',
      created: 9_999_999,
    };
    const rows = replayRatings([...history, recorded]);
    expect(rowFor(rows, 'a').rating).toBe(preview.left.after);
    expect(rowFor(rows, 'b').rating).toBe(preview.right.after);
  });

  test('appends after the history however the clock behaved', () => {
    const history = [round('a', 'b', 'left')];
    const preview = previewVerdict(history, [], { ...sides('a', 'b'), verdict: 'left' });
    // `a` already won once, so it enters this round as the favourite.
    expect(preview.left.before).toBeGreaterThan(START_RATING);
    expect(preview.right.before).toBeLessThan(START_RATING);
  });

  test('seeds pool entrants so an unfought contender is not invented mid-round', () => {
    const preview = previewVerdict([], [contender('a'), contender('b'), contender('c')], {
      ...sides('a', 'b'),
      verdict: 'left',
    });
    expect(preview.left.before).toBe(START_RATING);
  });
});
