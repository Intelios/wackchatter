import { describe, expect, test } from 'bun:test';
import { columnLeaders, lengthRatios } from './runStats.ts';
import type { EntryStatus, RunEntry } from './state/arenaReducer.ts';

function entry(patch: Partial<RunEntry> & { contenderId: string }): RunEntry {
  return {
    name: patch.contenderId,
    model: 'm',
    provider: 'openai',
    status: 'done' as EntryStatus,
    attempt: 0,
    text: '',
    reasoning: '',
    error: null,
    firstTokenMs: null,
    elapsedMs: null,
    completionTokens: null,
    ...patch,
  };
}

describe('columnLeaders', () => {
  test('the fastest to first token wins that measure', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 400 }),
      entry({ contenderId: 'b', firstTokenMs: 4000 }),
    ]);
    expect(leaders.firstToken).toBe('a');
  });

  test('the fastest overall wins the total', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', elapsedMs: 20_000 }),
      entry({ contenderId: 'b', elapsedMs: 9_000 }),
    ]);
    expect(leaders.total).toBe('b');
  });

  test('the highest throughput wins the rate', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', elapsedMs: 10_000, completionTokens: 100 }),
      entry({ contenderId: 'b', elapsedMs: 10_000, completionTokens: 400 }),
    ]);
    expect(leaders.rate).toBe('b');
  });

  test('length is never given a winner', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', completionTokens: 100, elapsedMs: 1000 }),
      entry({ contenderId: 'b', completionTokens: 900, elapsedMs: 1000 }),
    ]);
    expect(leaders).not.toHaveProperty('tokens');
  });

  test('figures that display the same are a dead heat, whatever the raw values were', () => {
    // 118ms and 143ms both print "0.1s". A lime 0.1s beside a plain 0.1s reads as a bug.
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 118 }),
      entry({ contenderId: 'b', firstTokenMs: 143 }),
    ]);
    expect(leaders.firstToken).toBeUndefined();
  });

  test('a difference big enough to show still wins', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 118 }),
      entry({ contenderId: 'b', firstTokenMs: 460 }),
    ]);
    expect(leaders.firstToken).toBe('a');
  });

  test('throughput ties at the displayed decimal place', () => {
    // 100.02 tok/s and 100.04 tok/s both print "100.0".
    const leaders = columnLeaders([
      entry({ contenderId: 'a', elapsedMs: 10_000, completionTokens: 1000 }),
      entry({ contenderId: 'b', elapsedMs: 9998, completionTokens: 1000 }),
    ]);
    expect(leaders.rate).toBeUndefined();
  });

  test('a dead heat has no winner', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 500 }),
      entry({ contenderId: 'b', firstTokenMs: 500 }),
    ]);
    expect(leaders.firstToken).toBeUndefined();
  });

  test('a single column is not a comparison', () => {
    expect(columnLeaders([entry({ contenderId: 'a', firstTokenMs: 100 })])).toEqual({});
  });

  test('ignores columns that did not settle', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 900 }),
      entry({ contenderId: 'b', firstTokenMs: 100, status: 'failed' }),
      entry({ contenderId: 'c', firstTokenMs: 950 }),
    ]);
    expect(leaders.firstToken).toBe('a');
  });

  test('a missing measure simply has no leader', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', elapsedMs: 1000 }),
      entry({ contenderId: 'b', elapsedMs: 2000 }),
    ]);
    expect(leaders.total).toBe('a');
    expect(leaders.firstToken).toBeUndefined();
    expect(leaders.rate).toBeUndefined();
  });

  test('one column reporting a measure the other does not is not a win', () => {
    const leaders = columnLeaders([
      entry({ contenderId: 'a', firstTokenMs: 500 }),
      entry({ contenderId: 'b' }),
    ]);
    // Only one candidate, so nothing was actually beaten.
    expect(leaders.firstToken).toBe('a');
  });
});

describe('lengthRatios', () => {
  test('the longest reply is the full bar', () => {
    const ratios = lengthRatios([
      entry({ contenderId: 'a', text: 'x'.repeat(50) }),
      entry({ contenderId: 'b', text: 'x'.repeat(100) }),
    ]);
    expect(ratios.get('b')).toBe(1);
    expect(ratios.get('a')).toBe(0.5);
  });

  test('an empty run does not divide by zero', () => {
    const ratios = lengthRatios([entry({ contenderId: 'a' }), entry({ contenderId: 'b' })]);
    expect(ratios.get('a')).toBe(0);
    expect(ratios.get('b')).toBe(0);
  });

  test('covers every column, including a failed one', () => {
    const ratios = lengthRatios([
      entry({ contenderId: 'a', text: 'hello' }),
      entry({ contenderId: 'b', status: 'failed' }),
    ]);
    expect(ratios.size).toBe(2);
    expect(ratios.get('b')).toBe(0);
  });
});
