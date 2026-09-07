import { describe, expect, test } from 'bun:test';
import { currentText, type MessageState, swipeCount } from '@shared/chat/message.ts';
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
      personaId: 'ari',
    });

    expect(state.metadata.persona).toBe('ari');
    expect(state.persistedRevision).toBe(7);
    expect(state.revision).toBe(8);
  });

  test('an explicit no-persona snapshot is never migrated back to the default', () => {
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: { ...chat(), revision: 7, metadata: { persona: null } },
      personaId: 'ari',
    });

    expect(state.metadata.persona).toBeNull();
    expect(state.revision).toBe(7);
    expect(state.persistedRevision).toBe(7);
  });

  test('loading stamps legacy user messages with the chat persona and marks the migration dirty', () => {
    // Messages from before speakers were recorded were sent as whoever the chat's persona
    // is. Freezing that at load keeps a later persona switch from re-facing the transcript.
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: {
        ...chat([
          {
            id: 'm0',
            name: 'Seraphina',
            is_user: false,
            is_system: false,
            mes: 'Hello.',
            send_date: 'a',
          },
          { id: 'u1', name: 'Jack', is_user: true, is_system: false, mes: 'Hi.', send_date: 'b' },
        ]),
        revision: 4,
        metadata: { persona: 'ari' },
      },
    });

    expect(state.messages[0]!.persona_id).toBeUndefined();
    expect(state.messages[1]!.persona_id).toBe('ari');
    expect(state.persistedRevision).toBe(4);
    expect(state.revision).toBe(5);
  });

  test('a recorded speaker is never re-stamped by the migration', () => {
    // A transcript that changed persona mid-conversation keeps both faces, and a message
    // sent with no persona keeps its explicit null. Nothing to migrate, no dirty revision.
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: {
        ...chat([
          {
            id: 'u1',
            name: 'Jack',
            is_user: true,
            is_system: false,
            persona_id: 'old-face',
            mes: 'a',
            send_date: 'a',
          },
          {
            id: 'u2',
            name: 'Jack',
            is_user: true,
            is_system: false,
            persona_id: null,
            mes: 'b',
            send_date: 'b',
          },
        ]),
        revision: 4,
        metadata: { persona: 'ari' },
      },
    });

    expect(state.messages[0]!.persona_id).toBe('old-face');
    expect(state.messages[1]!.persona_id).toBeNull();
    expect(state.revision).toBe(4);
    expect(state.persistedRevision).toBe(4);
  });

  test('a legacy chat with no persona key migrates metadata and speakers in one revision bump', () => {
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: {
        ...chat([
          { id: 'u1', name: 'Jack', is_user: true, is_system: false, mes: 'Hi.', send_date: 'a' },
        ]),
        revision: 7,
        metadata: {},
      },
      personaId: 'ari',
    });

    expect(state.metadata.persona).toBe('ari');
    expect(state.messages[0]!.persona_id).toBe('ari');
    expect(state.revision).toBe(8);
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
      personaId: null,
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
  test('a sent message records the persona speaking at that moment', () => {
    const state = run(loaded(), {
      type: 'message/appendUser',
      id: 'u1',
      name: 'Jack',
      personaId: 'ari',
      text: 'Hello',
    });

    expect(last(state).persona_id).toBe('ari');
    // The wire form carries it too — that is how it reaches storage.
    expect(toChatMessages(state).at(-1)?.persona_id).toBe('ari');
  });

  test('send then finish leaves one assistant message with a single swipe', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Where am I?' },
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

  test('a reasoning-only finish keeps the assistant message', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Think.' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'Seraphina' },
      { type: 'gen/streaming' },
      { type: 'gen/finished', text: '', extra: { reasoning: 'A complete train of thought.' } },
    );

    expect(state.messages.length).toBe(3);
    expect(currentText(last(state))).toBe('');
    expect(last(state).swipe_info[0]?.extra?.reasoning).toBe('A complete train of thought.');
    expect(state.status).toBe('idle');
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

  test('a finish_reason of length marks the reply truncated', () => {
    // The provider cut the reply at openai_max_tokens. Without the badge it is visually
    // identical to a complete reply, and "should I press Continue?" is unanswerable.
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Go on.' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'Seraphina' },
      { type: 'gen/streaming' },
      {
        type: 'gen/finished',
        text: 'and so the lantern',
        finishReason: 'length',
        extra: { model: 'gpt-4o' },
      },
    );

    expect(currentText(last(state))).toBe('and so the lantern');
    expect(last(state).swipe_info[0]?.extra?.truncated).toBe(true);
    // The badge rides beside the rest of the swipe's extra, not instead of it.
    expect(last(state).swipe_info[0]?.extra?.model).toBe('gpt-4o');
    assertConsistent(state);
  });

  test('a clean finish is never marked truncated', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Hi' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'Seraphina' },
      { type: 'gen/streaming' },
      { type: 'gen/finished', text: 'Eldoria.', finishReason: 'stop', extra: { model: 'gpt-4o' } },
    );

    expect(last(state).swipe_info[0]?.extra?.truncated).toBeUndefined();
    expect(last(state).swipe_info[0]?.extra?.model).toBe('gpt-4o');
    assertConsistent(state);
  });

  test('a stopped generation records its id, so the usage log can be reconciled', () => {
    // Without this the same generation is accounted for twice: once from the log line
    // written when it was stopped, and once as an unidentified swipe read back out of
    // the transcript later.
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/streaming' },
      { type: 'gen/aborted', text: 'The lantern gut', generationId: 'gen-7' },
    );

    expect(last(state).swipe_info[0]?.extra?.generation_id).toBe('gen-7');
    expect(last(state).swipe_info[0]?.extra?.truncated).toBe(true);
    assertConsistent(state);
  });

  test('a failed generation that kept partial text records its id too', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/streaming' },
      { type: 'gen/failed', message: 'Upstream died.', text: 'Half a th', generationId: 'gen-8' },
    );

    expect(last(state).swipe_info[0]?.extra?.generation_id).toBe('gen-8');
    expect(state.error).toBe('Upstream died.');
    assertConsistent(state);
  });

  test('a generation that produced nothing records no extra at all', () => {
    // No text and no reasoning means no swipe worth annotating — an id on an empty
    // alternate would claim a generation that left nothing behind.
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'S' },
      { type: 'gen/aborted', text: '', generationId: 'gen-9' },
    );

    expect(last(state).swipe_info[0]?.extra).toBeUndefined();
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
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Hi' },
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
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Where am I?' },
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

describe('multiple completions', () => {
  test('a send lands the reply first and the spares behind it', () => {
    const state = run(
      loaded(),
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Hi' },
      { type: 'gen/started', mode: 'send', newId: 'a1', name: 'Seraphina' },
      { type: 'gen/streaming' },
      {
        type: 'gen/finished',
        text: 'The first.',
        extra: { model: 'gpt-4o' },
        alternates: [{ text: 'The second.' }, { text: 'The third.', extra: { model: 'gpt-4o' } }],
      },
    );

    const reply = last(state);
    expect(reply.swipes).toEqual(['The first.', 'The second.', 'The third.']);
    // The reply the user watched stream in is the one still on screen.
    expect(reply.swipe_id).toBe(0);
    expect(currentText(reply)).toBe('The first.');
    expect(reply.swipe_info[2]?.extra?.model).toBe('gpt-4o');
    assertConsistent(state);
  });

  test('an overswipe keeps the selection on the take that streamed in', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/finished', text: 'A fourth take.', alternates: [{ text: 'A fifth take.' }] },
    );

    expect(state.messages[0]!.swipes).toEqual([
      'Hello.',
      'Greetings.',
      'Well met.',
      'A fourth take.',
      'A fifth take.',
    ]);
    expect(state.messages[0]!.swipe_id).toBe(3);
    expect(currentText(state.messages[0]!)).toBe('A fourth take.');
    assertConsistent(state);
  });

  test('the alternates share the start time of the request that produced them', () => {
    const started = run(loaded(), { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' });
    const genStarted = started.messages[0]!.swipe_info[3]?.gen_started;
    const state = run(started, {
      type: 'gen/finished',
      text: 'Fourth.',
      alternates: [{ text: 'Fifth.' }],
    });

    expect(genStarted).toBeTruthy();
    expect(state.messages[0]!.swipe_info[4]?.gen_started).toBe(genStarted!);
  });

  test('a length-cut alternate wears the truncated badge too', () => {
    // Each choice carries its own finish_reason: a spare stopped at the token limit must
    // not present as a clean take once the reader swipes to it.
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      {
        type: 'gen/finished',
        text: 'Fourth.',
        finishReason: 'stop',
        alternates: [{ text: 'A fifth take, cut sh', finishReason: 'length' }],
      },
    );

    expect(state.messages[0]!.swipe_info[3]?.extra?.truncated).toBeUndefined();
    expect(state.messages[0]!.swipe_info[4]?.extra?.truncated).toBe(true);
    assertConsistent(state);
  });

  test('a failed multi-choice swipe leaves no alternates behind', () => {
    // Only `gen/finished` can carry alternates — an abort or a failure has nothing but
    // half-written spares — so the undo here is the same total one as always.
    const before = loaded();
    const state = run(
      before,
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/failed', message: 'Rate limited.' },
    );

    expect(state.messages[0]!.swipes).toEqual(before.messages[0]!.swipes);
    assertConsistent(state);
  });

  test('the swipes reach the wire form the transcript is saved from', () => {
    const state = run(
      loaded(),
      { type: 'gen/started', mode: 'swipe', newId: 'x', name: 'S' },
      { type: 'gen/finished', text: 'Fourth.', alternates: [{ text: 'Fifth.' }] },
    );

    const saved = toChatMessages(state)[0]!;
    expect(saved.swipes).toEqual(['Hello.', 'Greetings.', 'Well met.', 'Fourth.', 'Fifth.']);
    expect(saved.mes).toBe('Fourth.');
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

  test('a reasoning edit rewrites only the selected swipe extra, never the reply text', () => {
    const withReasoning = run(loaded(), {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
      name: 'S',
    });
    const settled = run(withReasoning, {
      type: 'gen/finished',
      text: 'The answer.',
      extra: { reasoning: 'Rambling chain of thought.' },
    });

    const state = run(settled, {
      type: 'message/reasoningEdited',
      id: 'a1',
      reasoning: 'Tidied thinking.',
    });

    const message = state.messages.find((m) => m.id === 'a1')!;
    expect(message.swipes[message.swipe_id]).toBe('The answer.');
    expect(message.swipe_info[message.swipe_id]!.extra?.reasoning).toBe('Tidied thinking.');
    // The greeting's swipe was not touched by an edit on another message.
    expect(state.messages[0]!.swipes).toEqual(['Hello.', 'Greetings.', 'Well met.']);
    assertConsistent(state);
  });

  test('an empty reasoning edit clears the thinking block, other extra survives', () => {
    const withReasoning = run(loaded(), {
      type: 'gen/started',
      mode: 'send',
      newId: 'a1',
      name: 'S',
    });
    const settled = run(withReasoning, {
      type: 'gen/finished',
      text: 'The answer.',
      extra: { reasoning: 'Scratchpad.', api: 'custom', model: 'm' },
    });

    const state = run(settled, { type: 'message/reasoningEdited', id: 'a1', reasoning: '' });

    const message = state.messages.find((m) => m.id === 'a1')!;
    const extra = message.swipe_info[message.swipe_id]!.extra;
    expect(extra?.reasoning).toBeFalsy();
    expect(extra?.api).toBe('custom');
    expect(extra?.model).toBe('m');
    assertConsistent(state);
  });

  test('hiding a message keeps it in the transcript', () => {
    const state = run(loaded(), { type: 'message/toggleHidden', id: 'm0' });
    expect(state.messages.length).toBe(1);
    expect(state.messages[0]!.is_system).toBe(true);

    const shown = chatReducer(state, { type: 'message/toggleHidden', id: 'm0' });
    expect(shown.messages[0]!.is_system).toBe(false);
  });

  test('a range hides exactly its messages in one revision', () => {
    const three = run(
      initialChatState,
      {
        type: 'chat/loaded',
        chat: chat([
          { id: 'm0', name: 'S', is_user: false, is_system: false, mes: 'a', send_date: '1' },
          {
            id: 'u1',
            name: 'J',
            is_user: true,
            is_system: false,
            persona_id: null,
            mes: 'b',
            send_date: '2',
          },
          { id: 'm2', name: 'S', is_user: false, is_system: false, mes: 'c', send_date: '3' },
        ]),
      },
      { type: 'message/setHidden', ids: ['m0', 'u1'], hidden: true },
    );

    expect(three.revision).toBe(1);
    expect(three.messages.map((m) => m.is_system)).toEqual([true, true, false]);
  });

  test('re-hiding an already hidden range is a no-op that leaves the revision alone', () => {
    const hidden = run(
      loaded(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true },
      { type: 'message/setHidden', ids: ['m0'], hidden: true },
    );
    expect(hidden.messages[0]!.is_system).toBe(true);
    expect(hidden.revision).toBe(1);
  });

  test('unhiding flips a range back without touching the rest', () => {
    const three = run(
      initialChatState,
      {
        type: 'chat/loaded',
        chat: chat([
          { id: 'm0', name: 'S', is_user: false, is_system: true, mes: 'a', send_date: '1' },
          { id: 'u1', name: 'J', is_user: true, is_system: true, mes: 'b', send_date: '2' },
          { id: 'm2', name: 'S', is_user: false, is_system: false, mes: 'c', send_date: '3' },
        ]),
      },
      { type: 'message/setHidden', ids: ['m0', 'm2'], hidden: false },
    );

    expect(three.messages.map((m) => m.is_system)).toEqual([false, true, false]);
  });

  test('an empty range changes nothing', () => {
    const before = loaded();
    expect(chatReducer(before, { type: 'message/setHidden', ids: [], hidden: true })).toBe(before);
  });

  test('deleting removes the message', () => {
    const state = run(loaded(), { type: 'message/deleted', id: 'm0' });
    expect(state.messages).toEqual([]);
  });

  test('every transcript change bumps revision so it reaches the database', () => {
    const before = loaded();
    for (const action of [
      { type: 'message/appendUser', id: 'u', name: 'J', personaId: null, text: 'x' },
      { type: 'message/edited', id: 'm0', text: 'y' },
      { type: 'message/reasoningEdited', id: 'm0', reasoning: 'z' },
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

  test('a metadata patch with no chat open is swallowed whole', () => {
    // The Memory panel's mode selector dispatches chat/metadata with no chat loaded.
    // The patch must change nothing — banking it on the closed state would leak it
    // into whichever chat opens next.
    const closed = run(loaded(), { type: 'chat/closed' });
    const next = chatReducer(closed, { type: 'chat/metadata', patch: { memoryMode: 'nexus' } });

    expect(next).toBe(closed);
    expect(next.metadata).toEqual({});
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
      { type: 'message/appendUser', id: 'u1', name: 'Jack', personaId: null, text: 'Where am I?' },
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

describe('memory hide provenance', () => {
  function threeMessages(): ChatState {
    return run(initialChatState, {
      type: 'chat/loaded',
      chat: chat([
        { id: 'm0', name: 'S', is_user: false, is_system: false, mes: 'a', send_date: '1' },
        { id: 'u1', name: 'J', is_user: true, is_system: false, mes: 'b', send_date: '2' },
        { id: 'm2', name: 'S', is_user: false, is_system: false, mes: 'c', send_date: '3' },
      ]),
    });
  }

  test('hiding on behalf of a memory stamps the messages it hid', () => {
    const state = run(threeMessages(), {
      type: 'message/setHidden',
      ids: ['m0', 'u1'],
      hidden: true,
      memoryId: 'mem-1',
    });
    expect(state.messages.map((m) => m.hiddenBy)).toEqual(['mem-1', 'mem-1', undefined]);
  });

  test('a memory unhiding only reveals what it stamped', () => {
    // The manual hide on m2 must survive the memory being deleted, which is the whole
    // reason the stamp exists.
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0', 'u1'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/setHidden', ids: ['m2'], hidden: true },
      { type: 'message/setHidden', ids: ['m0', 'u1', 'm2'], hidden: false, memoryId: 'mem-1' },
    );
    expect(state.messages.map((m) => m.is_system)).toEqual([false, false, true]);
  });

  test('one memory cannot reveal what another hid', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/setHidden', ids: ['m0'], hidden: false, memoryId: 'mem-2' },
    );
    expect(state.messages[0]!.is_system).toBe(true);
    expect(state.messages[0]!.hiddenBy).toBe('mem-1');
  });

  test('a person may unhide anything, memory-hidden or not', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/setHidden', ids: ['m0'], hidden: false },
    );
    expect(state.messages[0]!.is_system).toBe(false);
    expect(state.messages[0]!.hiddenBy).toBeUndefined();
  });

  test('toggling by hand takes ownership away from the memory', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/toggleHidden', id: 'm0' },
      { type: 'message/toggleHidden', id: 'm0' },
    );
    expect(state.messages[0]!.is_system).toBe(true);
    expect(state.messages[0]!.hiddenBy).toBeUndefined();
  });

  test('re-hiding an already memory-hidden range stays a no-op', () => {
    const once = run(threeMessages(), {
      type: 'message/setHidden',
      ids: ['m0'],
      hidden: true,
      memoryId: 'mem-1',
    });
    expect(
      chatReducer(once, {
        type: 'message/setHidden',
        ids: ['m0'],
        hidden: true,
        memoryId: 'mem-1',
      }),
    ).toBe(once);
  });

  test('a memory hide cannot overwrite an existing manual hide', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true },
      { type: 'message/setHidden', ids: ['m0', 'u1'], hidden: true, memoryId: 'mem-1' },
    );
    expect(state.messages[0]!.is_system).toBe(true);
    expect(state.messages[0]!.hiddenBy).toBeUndefined();
    expect(state.messages[1]!.is_system).toBe(true);
    expect(state.messages[1]!.hiddenBy).toBe('mem-1');

    // Deleting or revealing mem-1 must not unhide m0
    const afterUnhide = run(state, {
      type: 'message/setHidden',
      ids: ['m0', 'u1'],
      hidden: false,
      memoryId: 'mem-1',
    });
    expect(afterUnhide.messages[0]!.is_system).toBe(true);
    expect(afterUnhide.messages[0]!.hiddenBy).toBeUndefined();
    expect(afterUnhide.messages[1]!.is_system).toBe(false);
  });

  test('a memory hide cannot overwrite another memory stamp', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-2' },
    );
    expect(state.messages[0]!.hiddenBy).toBe('mem-1');

    // mem-2 revealing m0 is refused
    const afterMem2 = run(state, {
      type: 'message/setHidden',
      ids: ['m0'],
      hidden: false,
      memoryId: 'mem-2',
    });
    expect(afterMem2.messages[0]!.is_system).toBe(true);
    expect(afterMem2.messages[0]!.hiddenBy).toBe('mem-1');

    // mem-1 revealing m0 unhides it
    const afterMem1 = run(afterMem2, {
      type: 'message/setHidden',
      ids: ['m0'],
      hidden: false,
      memoryId: 'mem-1',
    });
    expect(afterMem1.messages[0]!.is_system).toBe(false);
    expect(afterMem1.messages[0]!.hiddenBy).toBeUndefined();
  });

  test('a person manually hiding a memory-hidden message takes ownership', () => {
    const state = run(
      threeMessages(),
      { type: 'message/setHidden', ids: ['m0'], hidden: true, memoryId: 'mem-1' },
      { type: 'message/setHidden', ids: ['m0'], hidden: true },
    );
    expect(state.messages[0]!.is_system).toBe(true);
    expect(state.messages[0]!.hiddenBy).toBeUndefined();

    // mem-1 unhiding m0 is now refused
    const afterMem1 = run(state, {
      type: 'message/setHidden',
      ids: ['m0'],
      hidden: false,
      memoryId: 'mem-1',
    });
    expect(afterMem1.messages[0]!.is_system).toBe(true);
  });
});

describe('memory staleness', () => {
  function withMemory(): ChatState {
    const state = run(initialChatState, {
      type: 'chat/loaded',
      chat: chat([
        { id: 'm0', name: 'S', is_user: false, is_system: false, mes: 'a', send_date: '1' },
        { id: 'u1', name: 'J', is_user: true, is_system: false, mes: 'b', send_date: '2' },
        { id: 'm2', name: 'S', is_user: false, is_system: false, mes: 'c', send_date: '3' },
      ]),
    });
    return chatReducer(state, {
      type: 'chat/metadata',
      patch: {
        memories: [
          {
            id: 'mem-1',
            title: 'First Meeting',
            text: 'They met.',
            keywords: [],
            range: { startId: 'm0', endId: 'u1' },
            pinned: false,
            enabled: true,
            source: 'generated',
            edited: false,
            generatedAt: 0,
          },
        ],
      },
    });
  }

  test('editing a covered message marks its memory stale', () => {
    const state = chatReducer(withMemory(), { type: 'message/edited', id: 'u1', text: 'new' });
    expect(state.metadata.memories?.[0]?.stale).toBe('edited');
  });

  test('deleting a covered message marks its memory stale', () => {
    const state = chatReducer(withMemory(), { type: 'message/deleted', id: 'm0' });
    expect(state.metadata.memories?.[0]?.stale).toBe('deleted');
  });

  test('editing a message outside every range leaves the metadata object identical', () => {
    const before = withMemory();
    const state = chatReducer(before, { type: 'message/edited', id: 'm2', text: 'new' });
    expect(state.metadata).toBe(before.metadata);
  });

  test('a chat with no memories is untouched', () => {
    const before = loaded();
    const state = chatReducer(before, { type: 'message/edited', id: 'm0', text: 'new' });
    expect(state.metadata).toBe(before.metadata);
  });
});
