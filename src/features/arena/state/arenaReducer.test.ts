import { describe, expect, test } from 'bun:test';
import {
  type ArenaAction,
  type ArenaState,
  arenaReducer,
  type EntrySeed,
  initialArenaState,
  isBusy,
  isRunSettled,
} from './arenaReducer.ts';

const seeds: EntrySeed[] = [
  { contenderId: 'a', name: 'Sonnet', model: 'anthropic/sonnet', provider: 'openrouter' },
  { contenderId: 'b', name: 'Local', model: 'llama-3', provider: 'custom' },
];

function start(overrides: Partial<Extract<ArenaAction, { type: 'run/started' }>> = {}) {
  return {
    type: 'run/started' as const,
    runId: 'run-1',
    characterId: 'Seraphina.png',
    probe: 'Who are you?',
    at: 1000,
    entries: seeds,
    ...overrides,
  };
}

function started(): ArenaState {
  return arenaReducer(initialArenaState, start());
}

function entry(state: ArenaState, contenderId: string, runId = 'run-1') {
  const found = state.runs
    .find((run) => run.id === runId)
    ?.entries.find((item) => item.contenderId === contenderId);
  if (!found) throw new Error(`no entry ${contenderId}`);
  return found;
}

describe('run/started', () => {
  test('seeds one pending entry per contender', () => {
    const state = started();

    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.entries.map((item) => item.status)).toEqual(['pending', 'pending']);
    expect(entry(state, 'a').name).toBe('Sonnet');
    expect(entry(state, 'a').attempt).toBe(0);
  });

  test('runs stack, newest last', () => {
    const state = arenaReducer(started(), start({ runId: 'run-2', probe: 'Again.' }));

    expect(state.runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
  });

  test('replace drops earlier runs, for the blind round', () => {
    const state = arenaReducer(started(), start({ runId: 'run-2', replace: true }));

    expect(state.runs.map((run) => run.id)).toEqual(['run-2']);
  });

  test('a duplicate run id is refused rather than appended', () => {
    // Two runs sharing an id would share one set of stream stores.
    const state = started();
    expect(arenaReducer(state, start())).toBe(state);
  });

  test('the scene is kept per run, so an old comparison still says what it answered', () => {
    const state = arenaReducer(started(), start({ runId: 'run-2', probe: 'Something else.' }));

    expect(state.runs[0]?.probe).toBe('Who are you?');
    expect(state.runs[1]?.probe).toBe('Something else.');
  });
});

describe('entry lifecycle', () => {
  test('streaming records the time to first token', () => {
    const state = arenaReducer(started(), {
      type: 'entry/streaming',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      ms: 240,
    });

    expect(entry(state, 'a').status).toBe('streaming');
    expect(entry(state, 'a').firstTokenMs).toBe(240);
    // The other column is untouched.
    expect(entry(state, 'b').status).toBe('pending');
  });

  test('settling stores the text, metrics and the served model', () => {
    const state = arenaReducer(started(), {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'She looks up.',
      reasoning: 'thinking',
      model: 'anthropic/sonnet-4.5',
      completionTokens: 42,
      ms: 1800,
    });

    expect(entry(state, 'a')).toMatchObject({
      status: 'done',
      text: 'She looks up.',
      reasoning: 'thinking',
      model: 'anthropic/sonnet-4.5',
      completionTokens: 42,
      elapsedMs: 1800,
      error: null,
    });
  });

  test('a blank served model leaves the requested one in place', () => {
    const state = arenaReducer(started(), {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'x',
      reasoning: '',
      model: '   ',
      completionTokens: null,
      ms: 10,
    });

    expect(entry(state, 'a').model).toBe('anthropic/sonnet');
  });

  test('a failure keeps whatever arrived before it', () => {
    const state = arenaReducer(started(), {
      type: 'entry/failed',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      message: 'Rate limited by the provider.',
      text: 'She looks',
      reasoning: '',
      ms: 900,
    });

    expect(entry(state, 'a').status).toBe('failed');
    expect(entry(state, 'a').text).toBe('She looks');
    expect(entry(state, 'a').error).toBe('Rate limited by the provider.');
  });

  test('one column failing leaves the others alone', () => {
    const failed = arenaReducer(started(), {
      type: 'entry/failed',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      message: 'no',
      text: '',
      reasoning: '',
      ms: 5,
    });
    const settled = arenaReducer(failed, {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'b',
      attempt: 0,
      text: 'A full reply.',
      reasoning: '',
      completionTokens: null,
      ms: 20,
    });

    expect(entry(settled, 'b').status).toBe('done');
    expect(entry(settled, 'a').status).toBe('failed');
    expect(isRunSettled(settled.runs[0]!)).toBe(true);
  });

  test('an abort keeps the partial text', () => {
    const state = arenaReducer(started(), {
      type: 'entry/aborted',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'Half a',
      reasoning: '',
      ms: 300,
    });

    expect(entry(state, 'a').status).toBe('aborted');
    expect(entry(state, 'a').text).toBe('Half a');
  });

  test('a second first-token callback cannot reopen a settled column', () => {
    const settled = arenaReducer(started(), {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'done',
      reasoning: '',
      completionTokens: null,
      ms: 10,
    });
    const after = arenaReducer(settled, {
      type: 'entry/streaming',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      ms: 20,
    });

    expect(entry(after, 'a').status).toBe('done');
  });
});

describe('late callbacks are inert', () => {
  test('an action for an unknown run changes nothing', () => {
    const state = started();
    expect(
      arenaReducer(state, {
        type: 'entry/settled',
        runId: 'gone',
        contenderId: 'a',
        attempt: 0,
        text: 'x',
        reasoning: '',
        completionTokens: null,
        ms: 1,
      }),
    ).toBe(state);
  });

  test('an action for an unknown column changes nothing', () => {
    const state = started();
    expect(
      arenaReducer(state, {
        type: 'entry/streaming',
        runId: 'run-1',
        contenderId: 'nobody',
        attempt: 0,
        ms: 1,
      }),
    ).toBe(state);
  });

  test('the abandoned request cannot overwrite the re-roll the user asked for', () => {
    // The case the attempt counter exists for. Re-roll column a, then let the FIRST
    // request settle late. Without the guard it would replace the pending re-roll.
    const rerolled = arenaReducer(started(), {
      type: 'entry/restarted',
      runId: 'run-1',
      contenderId: 'a',
    });
    expect(entry(rerolled, 'a').attempt).toBe(1);

    const late = arenaReducer(rerolled, {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'the rejected reply',
      reasoning: '',
      completionTokens: null,
      ms: 10,
    });

    expect(late).toBe(rerolled);
    expect(entry(late, 'a').status).toBe('pending');
    expect(entry(late, 'a').text).toBe('');
  });

  test('the current attempt still settles normally', () => {
    const rerolled = arenaReducer(started(), {
      type: 'entry/restarted',
      runId: 'run-1',
      contenderId: 'a',
    });
    const state = arenaReducer(rerolled, {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 1,
      text: 'the new reply',
      reasoning: '',
      completionTokens: null,
      ms: 10,
    });

    expect(entry(state, 'a').text).toBe('the new reply');
  });
});

describe('entry/restarted', () => {
  test('clears the previous result so the column reads as pending, not stale', () => {
    const settled = arenaReducer(started(), {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'old',
      reasoning: 'r',
      completionTokens: 9,
      ms: 100,
    });
    const state = arenaReducer(settled, {
      type: 'entry/restarted',
      runId: 'run-1',
      contenderId: 'a',
    });

    expect(entry(state, 'a')).toMatchObject({
      status: 'pending',
      text: '',
      reasoning: '',
      error: null,
      firstTokenMs: null,
      elapsedMs: null,
      completionTokens: null,
    });
    // The label survives — it identifies the column, not the reply.
    expect(entry(state, 'a').name).toBe('Sonnet');
  });
});

describe('isRunSettled and isBusy', () => {
  test('a fresh run is busy until every column stops', () => {
    const state = started();
    expect(isBusy(state)).toBe(true);
    expect(isRunSettled(state.runs[0]!)).toBe(false);

    const half = arenaReducer(state, {
      type: 'entry/settled',
      runId: 'run-1',
      contenderId: 'a',
      attempt: 0,
      text: 'x',
      reasoning: '',
      completionTokens: null,
      ms: 1,
    });
    expect(isBusy(half)).toBe(true);

    const done = arenaReducer(half, {
      type: 'entry/aborted',
      runId: 'run-1',
      contenderId: 'b',
      attempt: 0,
      text: '',
      reasoning: '',
      ms: 2,
    });
    expect(isBusy(done)).toBe(false);
    expect(isRunSettled(done.runs[0]!)).toBe(true);
  });
});

describe('log management', () => {
  test('a run can be removed on its own', () => {
    const state = arenaReducer(started(), start({ runId: 'run-2' }));

    expect(arenaReducer(state, { type: 'run/removed', runId: 'run-1' }).runs).toHaveLength(1);
  });

  test('clearing empties the log', () => {
    expect(arenaReducer(started(), { type: 'log/cleared' })).toEqual(initialArenaState);
  });
});
