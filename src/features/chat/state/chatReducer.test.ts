import { describe, expect, test } from 'bun:test';
import { type MessageState, currentText, swipeCount } from '@shared/chat/message.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { Chat } from '@shared/types/chat.ts';
import {
  type ChatAction,
  type ChatState,
  chatReducer,
  initialChatState,
  toChatMessages,
  toPersistedChatMessages,
} from './chatReducer.ts';

function run(state: ChatState, ...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, state);
}

function chat(messages: Chat['messages'] = []): Chat {
  return {
    id: 'c1',
    characterId: 'Seraphina.png',
    title: 'Test',
    created: 0,
    modified: 0,
    revision: 0,
    metadata: { persona: null },
    messages,
  };
}

/** A loaded chat with one greeting carrying two alternates. */
function loaded(): ChatState {
  return run(initialChatState, {
    type: 'chat/loaded',
    chat: chat([
      {
        id: 'm0',
        name: 'Seraphina',
        is_user: false,
        is_system: false,
        mes: 'Hello.',
        send_date: 'a',
        swipes: ['Hello.', 'Greetings.', 'Well met.'],
        swipe_id: 0,
      },
    ]),
  });
}

/** The invariant, checked against the projection the rest of the app consumes. */
function assertConsistent(state: ChatState) {
  for (const message of state.messages) {
    expect(message.swipe_info.length).toBe(message.swipes.length);
    expect(message.swipe_id).toBeGreaterThanOrEqual(0);
    expect(message.swipe_id).toBeLessThan(message.swipes.length);
  }
  for (const [index, projected] of toChatMessages(state).entries()) {
    const source = state.messages[index]!;
    expect(projected.mes).toBe(source.swipes[source.swipe_id]!);
  }
}

function last(state: ChatState): MessageState {
  return state.messages[state.messages.length - 1]!;
}

describe('chat snapshots', () => {
  test('loading a legacy chat snapshots the supplied default and marks only that migration dirty', () => {
    const legacy = { ...chat(), revision: 7, metadata: {} };
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: legacy,
      defaultPersonaId: 'ari',
    });

    expect(state.metadata.persona).toBe('ari');
    expect(state.persistedRevision).toBe(7);
    expect(state.revision).toBe(8);
  });

  test('an explicit no-persona snapshot is never migrated back to the default', () => {
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: { ...chat(), revision: 7, metadata: { persona: null } },
      defaultPersonaId: 'ari',
    });

    expect(state.metadata.persona).toBeNull();
    expect(state.revision).toBe(7);
    expect(state.persistedRevision).toBe(7);
  });

  test('a server acknowledgement advances persisted revision without losing a newer local edit', () => {
    const edited = run(loaded(), { type: 'chat/renamed', title: 'First' });
    const newer = run(edited, { type: 'chat/renamed', title: 'Second' });
    const settled = run(newer, { type: 'chat/saved', chatId: 'c1', revision: edited.revision });

    expect(settled.persistedRevision).toBe(edited.revision);
    expect(settled.revision).toBe(newer.revision);
    expect(settled.title).toBe('Second');
  });

  test('a save started by a user edit excludes the transient assistant placeholder', () => {
    const withUser = run(loaded(), {
      type: 'message/appendUser',
      id: 'u1',
      name: 'Jack',
      text: 'Hello',
    });
    const generating = run(withUser, {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
      name: 'Seraphina',
    });

    expect(toPersistedChatMessages(generating)).toEqual(toChatMessages(withUser));
  });
});

describe('sending', () => {
  test('send then finish leaves one assistant message with a single swipe', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', text: 'Where am I?' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'Seraphina' },
      { type: 'gen/streaming' },
      { type: 'gen/finished', text: 'Eldoria.', extra: { model: 'gpt-4o' } },
    );

    expect(state.messages.length).toBe(3);
    expect(currentText(last(state))).toBe('Eldoria.');
    expect(swipeCount(last(state))).toBe(1);
    expect(state.status).toBe('idle');
    expect(state.streamingId).toBeNull();
    assertConsistent(state);
  });

  test('the placeholder starts empty so it excludes itself from its own prompt', () => {
    // assemble.ts skips blank content, which is what keeps the message being generated
    // out of the history it is generated from.
    const state = run(loaded(), { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' });
    expect(currentText(last(state))).toBe('');
  });

  test('a failed send removes the placeholder entirely', () => {
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );

    expect(state.messages.length).toBe(before.messages.length);
    expect(state.error).toBe('Rate limited.');
    assertConsistent(state);
  });

  test('an aborted send with partial text keeps it and marks it truncated', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/streaming' },
      { type: 'gen/aborted', text: 'The lantern gut' },
    );

    expect(currentText(last(state))).toBe('The lantern gut');
    expect(last(state).swipe_info[0]?.extra?.truncated).toBe(true);
    assertConsistent(state);
  });

  test('a second generation cannot start while one is running', () => {
    const running = run(loaded(), { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' });
    const again = chatReducer(running, {
      type: 'gen/started',
      mode: 'send',
      newId: 'a2',
      name: 'S',
    });
    expect(again).toBe(running);
  });
});

describe('swiping', () => {
  test('selecting an existing swipe changes the text and generates nothing', () => {
    const state = run(loaded(), { type: 'swipe/select', id: 'm0', index: 2 });
    expect(currentText(state.messages[0]!)).toBe('Well met.');
    expect(state.status).toBe('idle');
    assertConsistent(state);
  });

  test('an overswipe appends an empty swipe and selects it', () => {
    const state = run(loaded(), { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' });
    expect(swipeCount(state.messages[0]!)).toBe(4);
    expect(state.messages[0]!.swipe_id).toBe(3);
    expect(currentText(state.messages[0]!)).toBe('');
    assertConsistent(state);
  });

  test('a finished overswipe fills the new swipe and keeps the alternates', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/finished', text: 'A fourth take.' },
    );

    expect(state.messages[0]!.swipes).toEqual([
      'Hello.',
      'Greetings.',
      'Well met.',
      'A fourth take.',
    ]);
    assertConsistent(state);
  });

  test('a FAILED overswipe leaves no blank swipe behind', () => {
    // Without this the array grows by one dead entry on every network hiccup — the
    // single most common bug in a reimplementation of this model.
    const before = loaded();
    const state = run(
      before,
      { type: 'swipe/select', id: 'm0', index: 2 },
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/failed', message: 'Connection lost.' },
    );

    expect(swipeCount(state.messages[0]!)).toBe(3);
    expect(state.messages[0]!.swipe_id).toBe(2);
    expect(currentText(state.messages[0]!)).toBe('Well met.');
    assertConsistent(state);
  });

  test('an aborted overswipe with partial text keeps the swipe', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/aborted', text: 'Half a th' },
    );

    expect(swipeCount(state.messages[0]!)).toBe(4);
    expect(currentText(state.messages[0]!)).toBe('Half a th');
    assertConsistent(state);
  });

  test('the selection cannot move while a generation is in flight', () => {
    // A generation writes into whichever swipe is selected when it settles. Letting the
    // selection move mid-flight lands the reply in the wrong slot and leaves a blank
    // swipe behind — observed in the browser before this guard existed.
    const running = run(loaded(), { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' });
    expect(chatReducer(running, { type: 'swipe/select', id: 'm0', index: 0 })).toBe(running);
  });

  test('the reply lands in the swipe that was current when it started', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'swipe/select', id: 'm0', index: 0 }, // ignored
      { type: 'gen/finished', text: 'Fourth.' },
    );

    expect(state.messages[0]!.swipes).toEqual(['Hello.', 'Greetings.', 'Well met.', 'Fourth.']);
    expect(state.messages[0]!.swipe_id).toBe(3);
    expect(currentText(state.messages[0]!)).toBe('Fourth.');
    assertConsistent(state);
  });

  test('swiping targets the last assistant message, not the last message', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', text: 'Hi' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/finished', text: 'Reply.' },
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
    );

    expect(state.streamingId).toBe('a1');
    expect(swipeCount(state.messages[0]!)).toBe(3);
  });
});

describe('retrying', () => {
  /** A transcript still owed a reply — what a failed send leaves behind. */
  function awaitingReply() {
    return run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', text: 'Where am I?' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );
  }

  test('a failed send leaves the user message in place to retry from', () => {
    const state = awaitingReply();
    expect(state.messages.map((m) => m.is_user)).toEqual([false, true]);
    expect(currentText(last(state))).toBe('Where am I?');
    expect(state.error).toBe('Rate limited.');
  });

  test('regenerate after a failure generates a reply instead of replacing anything', () => {
    // With no reply to replace, regenerate is a retry — SillyTavern does the same.
    const state = run(
      awaitingReply(),
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'Seraphina' },
      { type: 'gen/finished', text: 'Eldoria.' },
    );

    expect(state.messages.length).toBe(3);
    expect(currentText(state.messages[1]!)).toBe('Where am I?');
    expect(currentText(last(state))).toBe('Eldoria.');
    assertConsistent(state);
  });

  test('a retry must not destroy the earlier reply it is not replacing', () => {
    // The bug this guards: lastAssistantIndex would find the greeting and overwrite it.
    const before = awaitingReply();
    const state = run(before, {
      type: 'gen/started',
      mode: 'regenerate',
      newId: 'a2',
      name: 'S',
    });

    expect(currentText(state.messages[0]!)).toBe('Hello.');
    expect(state.messages[0]!.swipes.length).toBe(3);
    expect(state.discarded).toBeNull();
  });

  test('a failed retry removes its placeholder, leaving the transcript retryable again', () => {
    const state = run(
      awaitingReply(),
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'S' },
      { type: 'gen/failed', message: 'Again.' },
    );

    expect(state.messages.length).toBe(2);
    expect(last(state).is_user).toBe(true);
    assertConsistent(state);
  });

  test('swiping and continuing do nothing while a reply is owed', () => {
    const state = awaitingReply();
    for (const mode of ['swipe', 'continue'] as const) {
      expect(chatReducer(state, { type: 'gen/started', mode, newId: 'x', name: 'S' })).toBe(state);
    }
  });
});

/*
 * Guided generations reuse `send` and `swipe` wholesale — the guidance never reaches the
 * reducer, it is an argument to assembly. These pin that the reuse is safe, so nobody
 * "simplifies" the guided paths into something that settles differently.
 */
describe('guided generations', () => {
  test('a guided response appends a reply without a user message before it', () => {
    // The whole point: the instruction steers the reply without becoming part of the story.
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'send', newId: 'g1', name: 'S' },
      { type: 'gen/finished', text: 'Guided reply.' },
    );

    expect(state.messages.length).toBe(before.messages.length + 1);
    expect(last(state).is_user).toBe(false);
    expect(currentText(last(state))).toBe('Guided reply.');
    expect(state.messages.some((message) => message.is_user)).toBe(false);
    assertConsistent(state);
  });

  test('a failed guided response leaves no empty message behind', () => {
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'send', newId: 'g1', name: 'S' },
      { type: 'gen/failed', message: 'Nope.' },
    );

    expect(state.messages.length).toBe(before.messages.length);
    assertConsistent(state);
  });

  test('a failed guided swipe leaves no blank alternate behind', () => {
    // Every network hiccup would otherwise leave an empty alternate on the reply, and they
    // accumulate silently — the swipe counter climbs while nothing new is there to read.
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'swipe', newId: 'g1', name: 'S' },
      { type: 'gen/failed', message: 'Nope.' },
    );

    expect(swipeCount(last(state))).toBe(swipeCount(last(before)));
    assertConsistent(state);
  });

  test('a guided swipe from a middle alternate appends rather than overwriting', () => {
    const before = run(loaded(), { type: 'swipe/select', id: 'm0', index: 1 });
    const state = run(
      before,
      { type: 'gen/started', mode: 'swipe', newId: 'g1', name: 'S' },
      { type: 'gen/finished', text: 'A fourth.' },
    );

    expect(swipeCount(last(state))).toBe(swipeCount(last(before)) + 1);
    expect(currentText(last(state))).toBe('A fourth.');
    expect(last(state).swipes).toContain('Greetings.');
    assertConsistent(state);
  });
});

describe('regenerating', () => {
  test('regenerate replaces the message and drops its alternates', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'Seraphina' },
      { type: 'gen/finished', text: 'A fresh reply.' },
    );

    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.swipes).toEqual(['A fresh reply.']);
    assertConsistent(state);
  });

  test('a FAILED regenerate restores the original message with its alternates intact', () => {
    // A deliberate divergence: SillyTavern destroys the swipe array before generating,
    // so a 429 loses every alternate permanently.
    const before = loaded();
    const state = run(
      before,
      { type: 'swipe/select', id: 'm0', index: 1 },
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'S' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );

    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.id).toBe('m0');
    expect(state.messages[0]!.swipes).toEqual(['Hello.', 'Greetings.', 'Well met.']);
    expect(state.messages[0]!.swipe_id).toBe(1);
    expect(state.discarded).toBeNull();
    assertConsistent(state);
  });

  test('an aborted regenerate with partial text keeps the partial, not the original', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'S' },
      { type: 'gen/aborted', text: 'Partial.' },
    );

    expect(state.messages[0]!.id).toBe('a2');
    expect(currentText(state.messages[0]!)).toBe('Partial.');
    assertConsistent(state);
  });
});

describe('continuing', () => {
  test('continue extends the existing text in place without adding a swipe', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'continue', newId: 'x', name: 'S' },
      // The stream store seeds with the existing text, so the final text is the whole.
      { type: 'gen/finished', text: 'Hello. And welcome.' },
    );

    expect(state.messages.length).toBe(1);
    expect(swipeCount(state.messages[0]!)).toBe(3);
    expect(currentText(state.messages[0]!)).toBe('Hello. And welcome.');
    assertConsistent(state);
  });

  test('a failed continue leaves the message exactly as it was', () => {
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'continue', newId: 'x', name: 'S' },
      { type: 'gen/failed', message: 'Nope.' },
    );

    expect(state.messages[0]!.swipes).toEqual(before.messages[0]!.swipes);
    assertConsistent(state);
  });
});

describe('editing the transcript', () => {
  test('an edit writes only the selected swipe', () => {
    const state = run(
      loaded(),
      { type: 'swipe/select', id: 'm0', index: 1 },
      { type: 'message/edited', id: 'm0', text: 'Rewritten.' },
    );

    expect(state.messages[0]!.swipes).toEqual(['Hello.', 'Rewritten.', 'Well met.']);
    assertConsistent(state);
  });

  test('hiding a message keeps it in the transcript', () => {
    const state = run(loaded(), { type: 'message/toggleHidden', id: 'm0' });
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.is_system).toBe(true);

    const shown = chatReducer(state, { type: 'message/toggleHidden', id: 'm0' });
    expect(shown.messages[0]!.is_system).toBe(false);
  });

  test('deleting removes the message', () => {
    const state = run(loaded(), { type: 'message/deleted', id: 'm0' });
    expect(state.messages).toEqual([]);
  });

  test('every transcript change bumps revision so it reaches the database', () => {
    const before = loaded();
    for (const action of [
      { type: 'message/appendUser', id: 'u', name: 'J', text: 'x' },
      { type: 'message/edited', id: 'm0', text: 'y' },
      { type: 'message/deleted', id: 'm0' },
      { type: 'message/toggleHidden', id: 'm0' },
      { type: 'swipe/select', id: 'm0', index: 1 },
      { type: 'chat/renamed', title: 'New' },
    ] satisfies ChatAction[]) {
      expect(chatReducer(before, action).revision).toBe(before.revision + 1);
    }
  });

  test('starting a generation does NOT bump revision — a tick must not reach the disk', () => {
    const before = loaded();
    const started = chatReducer(before, {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
      name: 'S',
    });
    expect(started.revision).toBe(before.revision);
    expect(chatReducer(started, { type: 'gen/streaming' }).revision).toBe(before.revision);
  });
});

describe('greetings', () => {
  const card: CardDataV2 = {
    name: 'Seraphina',
    description: '',
    personality: '',
    scenario: '',
    first_mes: 'Hello, traveller.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['Well met.', 'You again.'],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
  };

  test('a greeting seeds an empty chat with its alternates as swipes', () => {
    const state = run(
      { ...initialChatState, chatId: 'c1' },
      { type: 'chat/greeting', id: 'm0', card },
    );

    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.swipes).toEqual(['Hello, traveller.', 'Well met.', 'You again.']);
    assertConsistent(state);
  });

  test('a greeting never overwrites an existing transcript', () => {
    const before = loaded();
    expect(chatReducer(before, { type: 'chat/greeting', id: 'm0', card })).toBe(before);
  });

  test('a card with no first_mes and no alternates seeds nothing', () => {
    const state = run(
      { ...initialChatState },
      {
        type: 'chat/greeting',
        id: 'm0',
        card: { ...card, first_mes: '', alternate_greetings: [] },
      },
    );
    expect(state.messages).toEqual([]);
  });
});

describe('late and stray actions', () => {
  test('a result arriving after the generation settled is ignored', () => {
    const settled = run(
      loaded(),
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/aborted', text: 'kept' },
    );

    const late = chatReducer(settled, { type: 'gen/finished', text: 'should not appear' });
    expect(late).toBe(settled);
  });

  test('swiping with no assistant message present is a no-op', () => {
    const empty = { ...initialChatState, chatId: 'c1' };
    expect(chatReducer(empty, { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' })).toBe(
      empty,
    );
  });

  test('closing a chat clears state but keeps the inspection history', () => {
    const state = run(
      loaded(),
      {
        type: 'gen/inspected',
        inspection: {
          at: 1,
          generationType: 'normal',
          messages: [],
          tokenCounts: {},
          totalTokens: 0,
          droppedMessages: 0,
          macroWarnings: [],
          body: {},
        },
      },
      { type: 'chat/closed' },
    );

    expect(state.messages).toEqual([]);
    expect(state.chatId).toBeNull();
    expect(state.inspections.length).toBe(1);
  });

  test('the inspection history is bounded', () => {
    let state = loaded();
    for (let i = 0; i < 25; i++) {
      state = chatReducer(state, {
        type: 'gen/inspected',
        inspection: {
          at: i,
          generationType: 'normal',
          messages: [],
          tokenCounts: {},
          totalTokens: 0,
          droppedMessages: 0,
          macroWarnings: [],
          body: {},
        },
      });
    }
    expect(state.inspections.length).toBe(10);
    // Newest first.
    expect(state.inspections[0]?.at).toBe(24);
  });
});

describe('the invariant holds across a long mixed session', () => {
  test('mes always equals the selected swipe, after every action', () => {
    let state = loaded();

    const script: ChatAction[] = [
      { type: 'message/appendUser', id: 'u1', name: 'Jack', text: 'Where am I?' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/streaming' },
      { type: 'gen/finished', text: 'Eldoria.' },
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/finished', text: 'The forest of Eldoria.' },
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/failed', message: 'boom' },
      { type: 'swipe/select', id: 'a1', index: 0 },
      { type: 'gen/started', mode: 'continue', newId: 'x', name: 'S' },
      { type: 'gen/aborted', text: 'Eldoria. A gla' },
      { type: 'gen/started', mode: 'regenerate', newId: 'a2', name: 'S' },
      { type: 'gen/failed', message: 'boom again' },
      { type: 'message/edited', id: 'a1', text: 'Hand-written.' },
      { type: 'message/toggleHidden', id: 'u1' },
      { type: 'gen/started', mode: 'regenerate', newId: 'a3', name: 'S' },
      { type: 'gen/finished', text: 'Final answer.' },
      { type: 'message/deleted', id: 'u1' },
    ];

    for (const action of script) {
      state = chatReducer(state, action);
      assertConsistent(state);
    }

    expect(state.status).toBe('idle');
    expect(state.streamingId).toBeNull();
    expect(state.discarded).toBeNull();
    expect(currentText(last(state))).toBe('Final answer.');
  });
});
