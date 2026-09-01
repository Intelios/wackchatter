import { describe, expect, test } from 'bun:test';
import { currentInfo, currentText, swipeCount } from '@shared/chat/message.ts';
import { emptyStash, setSlot } from '@shared/cocreator/stash.ts';
import type { CocreatorSession, StashProvenance } from '@shared/types/cocreator.ts';
import { DEFAULT_EXAMPLE_FIELDS } from '@shared/types/cocreator.ts';
import {
  ASSISTANT_NAME,
  type CocreatorAction,
  type CocreatorState,
  cocreatorReducer,
  hasUnsavedWork,
  initialCocreatorState,
  toPersistedMessages,
} from './cocreatorReducer.ts';

const provenance: StashProvenance = {
  messageId: 'a1',
  swipeIndex: 0,
  at: '2026-08-13T10:00:00.000Z',
  source: 'block',
};

function session(overrides: Partial<CocreatorSession> = {}): CocreatorSession {
  return {
    id: 's1',
    title: 'Gothic lighthouse keeper',
    created: 1,
    modified: 2,
    revision: 7,
    stash: emptyStash(),
    examples: { cards: [], fields: { ...DEFAULT_EXAMPLE_FIELDS } },
    settings: {},
    avatar: null,
    finishedAvatar: null,
    seedAvatar: null,
    messages: [],
    ...overrides,
  };
}

function run(state: CocreatorState, ...actions: CocreatorAction[]): CocreatorState {
  return actions.reduce(cocreatorReducer, state);
}

function opened(overrides: Partial<CocreatorSession> = {}): CocreatorState {
  return cocreatorReducer(initialCocreatorState, {
    type: 'session/loaded',
    session: session(overrides),
  });
}

/** A session with one exchange, sitting idle on the assistant's reply. */
function withExchange(): CocreatorState {
  return run(
    opened(),
    { type: 'message/appendUser', id: 'u1', text: 'Give me a greeting.' },
    { type: 'gen/started', mode: 'send', newId: 'a1' },
    { type: 'gen/streaming' },
    { type: 'gen/finished', text: 'The lamp room is cold.' },
  );
}

/** Every invariant `shared/chat/message.ts` guarantees, checked over a whole transcript. */
function assertConsistent(state: CocreatorState): void {
  for (const message of state.messages) {
    expect(message.swipes.length).toBeGreaterThan(0);
    expect(message.swipe_info).toHaveLength(message.swipes.length);
    expect(message.swipe_id).toBeGreaterThanOrEqual(0);
    expect(message.swipe_id).toBeLessThan(message.swipes.length);
  }
}

describe('opening and closing', () => {
  test('loading adopts the server revision on both counters, so nothing looks dirty', () => {
    const state = opened();

    expect(state.revision).toBe(7);
    expect(state.persistedRevision).toBe(7);
    expect(hasUnsavedWork(state)).toBe(false);
  });

  test('a save acknowledgement only ever moves the persisted revision forward', () => {
    const state = run(
      opened(),
      { type: 'message/appendUser', id: 'u1', text: 'Hi.' },
      { type: 'session/saved', sessionId: 's1', revision: 8 },
      { type: 'session/saved', sessionId: 's1', revision: 3 },
    );

    expect(state.persistedRevision).toBe(8);
    expect(hasUnsavedWork(state)).toBe(false);
  });

  test('an acknowledgement for a different session is ignored', () => {
    const state = opened();

    expect(
      cocreatorReducer(state, { type: 'session/saved', sessionId: 'other', revision: 99 }),
    ).toBe(state);
  });

  test('closing returns to the initial state', () => {
    expect(cocreatorReducer(withExchange(), { type: 'session/closed' })).toEqual(
      initialCocreatorState,
    );
  });
});

describe('seeding from the Studio', () => {
  /** A stash as `seedStash` builds one: pre-filed from the card, provenance 'seed'. */
  function seededStash() {
    return setSlot(emptyStash(), 'description', 'A healer of the deep wood.', {
      ...provenance,
      source: 'seed',
    });
  }

  test('the seed lands as one user turn plus the whole stash, at the cost of one revision', () => {
    const stash = seededStash();
    const state = run(opened(), {
      type: 'session/seeded',
      id: 'seed1',
      text: '### The character — Seraphina\n…',
      stash,
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: 'seed1', is_user: true });
    expect(currentText(state.messages[0]!)).toContain('Seraphina');
    expect(state.stash).toBe(stash);
    expect(state.stash.description?.provenance.source).toBe('seed');
    expect(state.revision).toBe(8);
    expect(hasUnsavedWork(state)).toBe(true);
    assertConsistent(state);
  });

  test('the seed turn is durable — a mid-flight save projects it, not transient state', () => {
    const seeded = run(opened(), {
      type: 'session/seeded',
      id: 'seed1',
      text: 'The character.',
      stash: seededStash(),
    });
    const generating = run(seeded, { type: 'gen/started', mode: 'send', newId: 'a1' });

    expect(toPersistedMessages(seeded)).toHaveLength(1);
    expect(toPersistedMessages(generating)).toHaveLength(1);
  });

  test('a second dispatch is a no-op — the guard makes double-seeding impossible', () => {
    const action = {
      type: 'session/seeded',
      id: 'seed2',
      text: 'Again.',
      stash: seededStash(),
    } as const;
    const first = run(opened(), action);

    expect(cocreatorReducer(first, action)).toBe(first);
  });

  test('seeding is refused once the session has any content of its own', () => {
    const withMessage = run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' });

    expect(
      cocreatorReducer(withMessage, {
        type: 'session/seeded',
        id: 'seed1',
        text: 'The character.',
        stash: seededStash(),
      }),
    ).toBe(withMessage);

    const withStashOnly = run(opened(), {
      type: 'stash/set',
      slot: 'description',
      text: 'Filed by hand.',
      provenance,
    });

    expect(
      cocreatorReducer(withStashOnly, {
        type: 'session/seeded',
        id: 'seed1',
        text: 'The character.',
        stash: seededStash(),
      }),
    ).toBe(withStashOnly);
  });
});

describe('avatar and finish bookkeeping', () => {
  test('adopting artwork costs no revision — the server write is already durable', () => {
    const state = run(opened(), { type: 'avatar/set', filename: 's1.png' });

    expect(state.avatar).toBe('s1.png');
    expect(state.revision).toBe(7);
    expect(hasUnsavedWork(state)).toBe(false);
  });

  test('clearing artwork costs no revision either', () => {
    const withAvatar = run(opened({ avatar: 's1.png' }), { type: 'avatar/set', filename: 'x' });
    const state = cocreatorReducer(withAvatar, { type: 'avatar/cleared' });

    expect(state.avatar).toBeNull();
    expect(state.revision).toBe(withAvatar.revision);
  });

  test('recording the finished card is a real document change, so it does cost one', () => {
    const state = run(opened(), { type: 'finished/recorded', avatar: 'Elowen.png' });

    expect(state.finishedAvatar).toBe('Elowen.png');
    expect(state.revision).toBe(8);
    expect(hasUnsavedWork(state)).toBe(true);
  });
});

describe('generation: the happy path', () => {
  test('a typed Co-Creator action is persisted on the visible user turn', () => {
    const state = run(opened(), {
      type: 'message/appendUser',
      id: 'u1',
      text: 'Custom analysis wording.',
      extra: { coCreatorAction: 'analyseExamples' },
    });

    expect(currentText(state.messages[0]!)).toBe('Custom analysis wording.');
    expect(currentInfo(state.messages[0]!).extra?.coCreatorAction).toBe('analyseExamples');
  });

  test('send appends a placeholder without bumping the revision', () => {
    const afterUser = run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' });
    const started = cocreatorReducer(afterUser, { type: 'gen/started', mode: 'send', newId: 'a1' });

    expect(started.messages).toHaveLength(2);
    expect(currentText(started.messages[1]!)).toBe('');
    expect(started.messages[1]!.name).toBe(ASSISTANT_NAME);
    expect(started.status).toBe('connecting');
    expect(started.revision).toBe(afterUser.revision);
  });

  test('a finished reply lands in the placeholder and bumps the revision', () => {
    const state = withExchange();

    expect(currentText(state.messages[1]!)).toBe('The lamp room is cold.');
    expect(state.status).toBe('idle');
    expect(state.streamingId).toBeNull();
    expect(state.mode).toBeNull();
    assertConsistent(state);
  });

  test('re-rolling appends a swipe and lands the new take in it', () => {
    const state = run(
      withExchange(),
      { type: 'gen/started', mode: 'swipe', newId: 'ignored' },
      { type: 'gen/finished', text: 'You find the door already open.' },
    );
    const reply = state.messages[1]!;

    expect(swipeCount(reply)).toBe(2);
    expect(reply.swipe_id).toBe(1);
    expect(reply.swipes).toEqual(['The lamp room is cold.', 'You find the door already open.']);
    assertConsistent(state);
  });

  test('the model is recorded per swipe, so free model swapping stays traceable', () => {
    const state = run(
      withExchange(),
      { type: 'gen/started', mode: 'swipe', newId: 'ignored' },
      { type: 'gen/finished', text: 'Another take.', extra: { model: 'gpt-5.6-sol' } },
    );
    const reply = state.messages[1]!;

    expect(reply.swipe_info[1]!.extra?.model).toBe('gpt-5.6-sol');
    expect(reply.swipe_info[0]!.extra?.model).toBeUndefined();
  });
});

describe('generation: the failure paths', () => {
  test('a failed send removes the placeholder and leaves the transcript as it was', () => {
    const before = run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' });
    const after = run(
      before,
      { type: 'gen/started', mode: 'send', newId: 'a1' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );

    expect(after.messages).toEqual(before.messages);
    expect(after.error).toBe('Rate limited.');
    expect(after.status).toBe('idle');
  });

  test('a failed re-roll leaves NO blank alternate behind', () => {
    const before = withExchange();
    const after = run(
      before,
      { type: 'gen/started', mode: 'swipe', newId: 'ignored' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );
    const reply = after.messages[1]!;

    expect(swipeCount(reply)).toBe(1);
    expect(reply.swipes).toEqual(['The lamp room is cold.']);
    assertConsistent(after);
  });

  test('a failed re-roll returns the selection to the take the reader was on', () => {
    const twoTakes = run(
      withExchange(),
      { type: 'gen/started', mode: 'swipe', newId: 'x' },
      { type: 'gen/finished', text: 'Second.' },
      { type: 'swipe/select', id: 'a1', index: 0 },
    );
    expect(twoTakes.messages[1]!.swipe_id).toBe(0);

    const after = run(
      twoTakes,
      { type: 'gen/started', mode: 'swipe', newId: 'y' },
      { type: 'gen/aborted', text: '' },
    );

    expect(swipeCount(after.messages[1]!)).toBe(2);
    expect(after.messages[1]!.swipe_id).toBe(0);
  });

  test('an abort with partial text keeps it and marks it truncated', () => {
    const after = run(
      run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' }),
      { type: 'gen/started', mode: 'send', newId: 'a1' },
      { type: 'gen/aborted', text: 'The lamp room is' },
    );
    const reply = after.messages[1]!;

    expect(currentText(reply)).toBe('The lamp room is');
    expect(reply.swipe_info[0]!.extra?.truncated).toBe(true);
  });

  test('a finish_reason of length marks the reply truncated', () => {
    // The provider cut the take at its token limit — the badge is the only thing telling
    // it apart from a complete one.
    const after = run(
      run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' }),
      { type: 'gen/started', mode: 'send', newId: 'a1' },
      {
        type: 'gen/finished',
        text: 'The lamp room is',
        finishReason: 'length',
        extra: { model: 'gpt-5.6-sol' },
      },
    );
    const reply = after.messages[1]!;

    expect(currentText(reply)).toBe('The lamp room is');
    expect(reply.swipe_info[0]!.extra?.truncated).toBe(true);
    expect(reply.swipe_info[0]!.extra?.model).toBe('gpt-5.6-sol');
  });

  test('reasoning with no content is still a result, so it is kept', () => {
    const after = run(
      run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' }),
      { type: 'gen/started', mode: 'send', newId: 'a1' },
      { type: 'gen/failed', message: 'Length limit.', reasoning: 'Considering three openings…' },
    );

    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]!.swipe_info[0]!.extra?.reasoning).toBe('Considering three openings…');
  });

  test('a late frame cannot revive a settled generation', () => {
    const settled = withExchange();

    expect(cocreatorReducer(settled, { type: 'gen/streaming' })).toBe(settled);
    expect(cocreatorReducer(settled, { type: 'gen/finished', text: 'ghost' })).toBe(settled);
    expect(cocreatorReducer(settled, { type: 'gen/aborted', text: 'ghost' })).toBe(settled);
  });

  test('a second generation cannot start while one is running', () => {
    const running = run(run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' }), {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
    });

    expect(cocreatorReducer(running, { type: 'gen/started', mode: 'send', newId: 'a2' })).toBe(
      running,
    );
  });

  test('re-rolling with a user turn last is a no-op — that case is a plain send', () => {
    const awaiting = run(withExchange(), { type: 'message/appendUser', id: 'u2', text: 'Again.' });

    expect(cocreatorReducer(awaiting, { type: 'gen/started', mode: 'swipe', newId: 'x' })).toBe(
      awaiting,
    );
  });

  test('re-rolling an empty transcript is a no-op', () => {
    const empty = opened();

    expect(cocreatorReducer(empty, { type: 'gen/started', mode: 'swipe', newId: 'x' })).toBe(empty);
  });
});

describe('swipe selection', () => {
  test('selecting is refused mid-flight, so a reply cannot land in the wrong slot', () => {
    const running = run(withExchange(), { type: 'gen/started', mode: 'swipe', newId: 'x' });

    expect(cocreatorReducer(running, { type: 'swipe/select', id: 'a1', index: 0 })).toBe(running);
  });

  test('selecting an out-of-range index changes nothing', () => {
    const state = withExchange();
    const after = cocreatorReducer(state, { type: 'swipe/select', id: 'a1', index: 9 });

    expect(after.messages).toEqual(state.messages);
  });
});

describe('editing the transcript', () => {
  test('an edit writes only the selected swipe', () => {
    const before = run(
      withExchange(),
      { type: 'gen/started', mode: 'swipe', newId: 'x' },
      { type: 'gen/finished', text: 'Second.' },
      { type: 'swipe/select', id: 'a1', index: 0 },
    );
    const state = cocreatorReducer(before, {
      type: 'message/edited',
      id: 'a1',
      text: 'Rewritten.',
    });

    expect(state.messages[1]!.swipes).toEqual(['Rewritten.', 'Second.']);
    expect(state.revision).toBe(before.revision + 1);
    assertConsistent(state);
  });

  test('editing a user message replaces its only swipe', () => {
    const base = withExchange();
    const state = run(base, { type: 'message/edited', id: 'u1', text: 'Changed.' });

    expect(currentText(state.messages[0]!)).toBe('Changed.');
    assertConsistent(state);
  });
});

describe('what a mid-flight save is allowed to make durable', () => {
  test('a send in flight projects the transcript without its placeholder', () => {
    const running = run(run(opened(), { type: 'message/appendUser', id: 'u1', text: 'Hi.' }), {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
    });

    expect(toPersistedMessages(running).map((message) => message.id)).toEqual(['u1']);
  });

  test('a re-roll in flight projects the reply without its blank alternate', () => {
    const running = run(withExchange(), { type: 'gen/started', mode: 'swipe', newId: 'x' });
    const persisted = toPersistedMessages(running);

    expect(persisted).toHaveLength(2);
    expect(persisted[1]!.swipes).toEqual(['The lamp room is cold.']);
    expect(persisted[1]!.mes).toBe('The lamp room is cold.');
  });

  test('a re-roll launched from an earlier take persists that take as the selected one', () => {
    const running = run(
      withExchange(),
      { type: 'gen/started', mode: 'swipe', newId: 'x' },
      { type: 'gen/finished', text: 'Second.' },
      { type: 'swipe/select', id: 'a1', index: 0 },
      { type: 'gen/started', mode: 'swipe', newId: 'y' },
    );
    const persisted = toPersistedMessages(running);

    expect(persisted[1]!.swipes).toEqual(['The lamp room is cold.', 'Second.']);
    expect(persisted[1]!.swipe_id).toBe(0);
    expect(persisted[1]!.mes).toBe('The lamp room is cold.');
  });

  test('at rest the projection is simply the transcript', () => {
    const state = withExchange();

    expect(toPersistedMessages(state).map((message) => message.mes)).toEqual([
      'Give me a greeting.',
      'The lamp room is cold.',
    ]);
  });
});

describe('the stash', () => {
  test('filing bumps the revision', () => {
    const before = withExchange();
    const after = cocreatorReducer(before, {
      type: 'stash/set',
      slot: 'first_mes',
      text: 'The lamp room is cold.',
      provenance,
    });

    expect(after.stash.first_mes?.text).toBe('The lamp room is cold.');
    expect(after.revision).toBe(before.revision + 1);
  });

  test('a stash edit that changes nothing costs no revision', () => {
    const state = withExchange();

    expect(cocreatorReducer(state, { type: 'stash/clear', slot: 'description' })).toBe(state);
    expect(cocreatorReducer(state, { type: 'stash/editGreeting', index: 0, text: 'x' })).toBe(
      state,
    );
    expect(cocreatorReducer(state, { type: 'stash/removeTag', index: 3 })).toBe(state);
  });
});

describe('examples', () => {
  test('attaching and detaching are idempotent', () => {
    const one = cocreatorReducer(opened(), { type: 'examples/add', avatar: 'Seraphina.png' });

    expect(one.examples.cards).toEqual(['Seraphina.png']);
    expect(cocreatorReducer(one, { type: 'examples/add', avatar: 'Seraphina.png' })).toBe(one);
    expect(cocreatorReducer(one, { type: 'examples/remove', avatar: 'Nobody.png' })).toBe(one);
    expect(
      cocreatorReducer(one, { type: 'examples/remove', avatar: 'Seraphina.png' }).examples.cards,
    ).toEqual([]);
  });

  test('reordering is a permutation and out-of-range is identity', () => {
    const three = run(
      opened(),
      { type: 'examples/add', avatar: 'A.png' },
      { type: 'examples/add', avatar: 'B.png' },
      { type: 'examples/add', avatar: 'C.png' },
    );

    expect(
      cocreatorReducer(three, { type: 'examples/reorder', from: 0, to: 2 }).examples.cards,
    ).toEqual(['B.png', 'C.png', 'A.png']);
    expect(cocreatorReducer(three, { type: 'examples/reorder', from: 0, to: 9 })).toBe(three);
  });

  test('setting a field to the value it already has costs no revision', () => {
    const state = opened();

    expect(
      cocreatorReducer(state, { type: 'examples/setField', field: 'description', on: true }),
    ).toBe(state);
    expect(
      cocreatorReducer(state, { type: 'examples/setField', field: 'mes_example', on: true })
        .examples.fields.mes_example,
    ).toBe(true);
  });

  test('applying an example set replaces cards and fields atomically', () => {
    const initial = run(
      opened(),
      { type: 'examples/add', avatar: 'Old1.png' },
      { type: 'examples/add', avatar: 'Old2.png' },
    );

    const customFields = {
      ...DEFAULT_EXAMPLE_FIELDS,
      description: false,
      alternate_greetings: true,
    };

    const next = cocreatorReducer(initial, {
      type: 'examples/applySet',
      cards: ['New1.png', 'New2.png', 'New3.png'],
      fields: customFields,
    });

    expect(next.examples.cards).toEqual(['New1.png', 'New2.png', 'New3.png']);
    expect(next.examples.fields).toEqual(customFields);
    expect(next.revision).toBe(initial.revision + 1);
  });
});

describe('the swipe invariant survives arbitrary action sequences', () => {
  test('a long mixed run leaves every message consistent', () => {
    let state = opened();
    const script: CocreatorAction[] = [];
    for (let turn = 0; turn < 12; turn += 1) {
      script.push({ type: 'message/appendUser', id: `u${turn}`, text: `turn ${turn}` });
      script.push({ type: 'gen/started', mode: 'send', newId: `a${turn}` });
      // Alternate between a clean finish, an empty failure and a truncated abort.
      if (turn % 3 === 0) script.push({ type: 'gen/finished', text: `reply ${turn}` });
      else if (turn % 3 === 1) script.push({ type: 'gen/failed', message: 'nope' });
      else script.push({ type: 'gen/aborted', text: `partial ${turn}` });

      script.push({ type: 'gen/started', mode: 'swipe', newId: `s${turn}` });
      script.push(
        turn % 2 === 0
          ? { type: 'gen/finished', text: `alt ${turn}` }
          : { type: 'gen/aborted', text: '' },
      );
      script.push({ type: 'swipe/select', id: `a${turn}`, index: turn % 3 });
    }

    for (const action of script) {
      state = cocreatorReducer(state, action);
      assertConsistent(state);
      expect(state.status).toMatch(/^(idle|connecting|streaming)$/);
    }

    // No blank swipe ever survived a failure.
    for (const message of state.messages) {
      if (message.is_user) continue;
      expect(message.swipes.filter((swipe) => swipe === '')).toHaveLength(0);
    }
  });
});
