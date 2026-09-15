import { describe, expect, test } from 'bun:test';
import type { ArenaRound, Contender, Verdict } from '@shared/types/arena.ts';
import type { LeaderboardRow } from './elo.ts';
import { replay } from './elo.ts';
import { applyMerges, canonicalId, canonicalMap, drawable, withoutContender } from './merges.ts';

let clock = 0;

function round(
  left: string,
  right: string,
  verdict: Verdict = 'left',
  model = 'shared-model',
): ArenaRound {
  clock += 1;
  return {
    id: `r${clock}`,
    created: clock,
    characterId: 'Seraphina.png',
    probe: 'Hello.',
    left: { contenderId: left, model: `${model}-a`, provider: 'openrouter', text: 'a' },
    right: { contenderId: right, model: `${model}-b`, provider: 'custom', text: 'b' },
    verdict,
  };
}

function contender(id: string, model = 'shared-model'): Contender {
  return { id, name: id, connectionId: 'or', model, enabled: true };
}

function rowFor(rows: readonly LeaderboardRow[], id: string): LeaderboardRow | null {
  return rows.find((entry) => entry.contenderId === id) ?? null;
}

describe('canonicalMap', () => {
  test('an empty map resolves nothing', () => {
    expect(canonicalMap({}).size).toBe(0);
  });

  test('a folded id resolves to its target, and the target to itself', () => {
    const canonical = canonicalMap({ b: 'a' });
    expect(canonicalId(canonical, 'b')).toBe('a');
    expect(canonicalId(canonical, 'a')).toBe('a');
  });

  test('an id the map never mentions resolves to itself', () => {
    expect(canonicalId(canonicalMap({ b: 'a' }), 'z')).toBe('z');
  });

  test('a chain follows to its root', () => {
    const canonical = canonicalMap({ c: 'b', b: 'a' });
    expect(canonicalId(canonical, 'c')).toBe('a');
    expect(canonicalId(canonical, 'b')).toBe('a');
  });

  test('a loop resolves to one id whichever way the walk enters it', () => {
    // Whichever entry point the walk uses, the loop is cut at the smallest id in the cycle
    // ('a'), so two readers cannot disagree about which of the two is the root.
    const forward = canonicalMap({ a: 'b', b: 'a' });
    expect(canonicalId(forward, 'a')).toBe('a');
    expect(canonicalId(forward, 'b')).toBe('a');

    const backward = canonicalMap({ b: 'a', a: 'b' });
    expect(canonicalId(backward, 'a')).toBe('a');
    expect(canonicalId(backward, 'b')).toBe('a');
  });
});

describe('applyMerges', () => {
  test('nothing merged hands back exactly what it was given', () => {
    const rounds = [round('a', 'b')];
    const pool = [contender('a'), contender('b')];
    const view = applyMerges(rounds, pool, {});

    expect(view.rounds).toBe(rounds);
    expect(view.contenders).toBe(pool);
    expect(view.collapsed).toBe(0);
  });

  test('both sides fold to one identity on every reader', () => {
    // Two providers of one model: `b` is the same LLM behind another endpoint.
    const history = [round('b', 'c'), round('a', 'c')];
    const view = applyMerges(history, [contender('a'), contender('b'), contender('c')], {
      b: 'a',
    });

    const rows = replay(view.rounds, view.contenders).rows;
    expect(rows.map((row) => row.contenderId).sort()).toEqual(['a', 'c']);

    // `a`'s row now carries both of its providers' rounds, not just its own.
    const merged = rowFor(rows, 'a');
    expect(merged?.rounds).toBe(2);
    expect(merged?.wins).toBe(2);
  });

  test('the folded contender is absent from the seeded pool', () => {
    const view = applyMerges([], [contender('a'), contender('b')], { b: 'a' });
    expect(view.contenders.map((entry) => entry.id)).toEqual(['a']);
  });

  test('a round between two providers of one model is collapsed, not double-counted', () => {
    // Recorded before the merge: it is a self-pair in the merged view, and evidence of
    // nothing the board measures.
    const history = [round('a', 'b'), round('a', 'c')];
    const view = applyMerges(history, [contender('a'), contender('b'), contender('c')], {
      b: 'a',
    });

    expect(view.collapsed).toBe(1);
    expect(view.rounds).toHaveLength(1);

    const rows = replay(view.rounds, view.contenders).rows;
    const merged = rowFor(rows, 'a');
    // One round behind it, not two: the self-pair contributed no rating movement at all.
    expect(merged?.rounds).toBe(1);
  });

  test('a collapsed round moves no rating, so the merged rating is the honest one', () => {
    const solo = [round('a', 'c')];
    const withSelfPair = [round('a', 'b'), round('a', 'c')];
    const pool = [contender('a'), contender('b'), contender('c')];

    const folded = applyMerges(withSelfPair, pool, { b: 'a' });
    const alone = applyMerges(solo, pool, {});

    const foldedRows = replay(folded.rounds, folded.contenders).rows;
    const aloneRows = replay(alone.rounds, alone.contenders).rows;
    expect(rowFor(foldedRows, 'a')?.rating).toBe(rowFor(aloneRows, 'a')?.rating);
  });

  test('unmerging restores the split exactly', () => {
    const history = [round('a', 'c'), round('b', 'c', 'right')];
    const pool = [contender('a'), contender('b'), contender('c')];

    const merged = applyMerges(history, pool, { b: 'a' });
    const mergedRows = replay(merged.rounds, merged.contenders).rows;
    expect(rowFor(mergedRows, 'a')?.rounds).toBe(2);
    expect(rowFor(mergedRows, 'b')).toBeNull();

    // The rounds were never rewritten, so dropping the link is the whole of the undo. The
    // split board is not the merged board's numbers redistributed; it is the board the same
    // rounds gave before anyone said the two were one model.
    const split = applyMerges(history, pool, {});
    expect(split.rounds).toBe(history);
    const splitRows = replay(split.rounds, split.contenders).rows;
    expect(rowFor(splitRows, 'a')?.rounds).toBe(1);
    expect(rowFor(splitRows, 'b')?.rounds).toBe(1);
    expect(rowFor(splitRows, 'a')).toEqual(rowFor(replay(history, pool).rows, 'a'));
  });

  test('a chain folds every link into the root', () => {
    const history = [round('c', 'z'), round('b', 'z'), round('a', 'z')];
    const pool = [contender('a'), contender('b'), contender('c'), contender('z')];
    const view = applyMerges(history, pool, { c: 'b', b: 'a' });

    const rows = replay(view.rounds, view.contenders).rows;
    expect(rowFor(rows, 'a')?.rounds).toBe(3);
    expect(rowFor(rows, 'b')).toBeNull();
    expect(rowFor(rows, 'c')).toBeNull();
  });

  test('the label follows the root, which is the surviving pool entry', () => {
    const history = [round('b', 'z')];
    const view = applyMerges(history, [contender('a'), contender('b'), contender('z')], {
      b: 'a',
    });
    const rows = replay(view.rounds, view.contenders).rows;

    // Last seen wins on the folded id, exactly as it does for a repointed contender.
    expect(rowFor(rows, 'a')?.model).toBe('shared-model-a');
    expect(rowFor(rows, 'a')?.provider).toBe('openrouter');
  });
});

describe('drawable', () => {
  test('a standalone contender may be drawn; a folded one may not', () => {
    const canonical = canonicalMap({ b: 'a' });
    expect(drawable(canonical, 'a')).toBe(true);
    expect(drawable(canonical, 'z')).toBe(true);
    // Drawing a folded contender would have the merged model fight itself, and the round it
    // produced would be discarded by every reader — two paid generations for nothing.
    expect(drawable(canonical, 'b')).toBe(false);
  });
});

describe('withoutContender', () => {
  test('drops the links it owns and the links pointing at it', () => {
    expect(withoutContender({ b: 'a', c: 'a', d: 'c' }, 'a')).toEqual({ d: 'c' });
  });

  test('leaves an unrelated map alone', () => {
    expect(withoutContender({ b: 'a' }, 'zzz')).toEqual({ b: 'a' });
  });
});
