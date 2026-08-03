import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage } from '../types/chat.ts';
import {
  appendSwipe,
  assistantPlaceholder,
  currentText,
  fromChatMessage,
  greetingMessage,
  type MessageState,
  removeSwipe,
  resetSwipes,
  selectSwipe,
  setText,
  toChatMessage,
  userMessage,
} from './message.ts';

function card(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: '',
    personality: '',
    scenario: '',
    first_mes: 'Hello, traveller.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

/** The invariant, asserted directly. */
function assertConsistent(message: MessageState) {
  expect(message.swipes.length).toBeGreaterThan(0);
  expect(message.swipe_info.length).toBe(message.swipes.length);
  expect(message.swipe_id).toBeGreaterThanOrEqual(0);
  expect(message.swipe_id).toBeLessThan(message.swipes.length);
  expect(toChatMessage(message).mes).toBe(message.swipes[message.swipe_id]!);
}

describe('adopting a stored message', () => {
  test('a message with no swipe array becomes a single-swipe message', () => {
    const state = fromChatMessage({
      id: '1',
      name: 'Seraphina',
      is_user: false,
      is_system: false,
      mes: 'Only take.',
      send_date: '2026-01-01T00:00:00.000Z',
    });

    expect(state.swipes).toEqual(['Only take.']);
    expect(state.swipe_id).toBe(0);
    assertConsistent(state);
  });

  test('a stored mes that disagrees with its swipe slot wins', () => {
    // This is the desync SillyTavern's syncMesToSwipe exists to prevent. Whatever the
    // cause, `mes` is what the user last saw, so it is the one to keep.
    const state = fromChatMessage({
      id: '1',
      name: 'Seraphina',
      is_user: false,
      is_system: false,
      mes: 'Edited text.',
      send_date: '2026-01-01T00:00:00.000Z',
      swipes: ['Stale text.', 'Other take.'],
      swipe_id: 0,
    });

    expect(state.swipes[0]).toBe('Edited text.');
    expect(state.swipes[1]).toBe('Other take.');
    assertConsistent(state);
  });

  test('an out-of-range swipe_id is clamped', () => {
    const high = fromChatMessage({
      id: '1',
      name: 'A',
      is_user: false,
      is_system: false,
      mes: 'x',
      send_date: 'd',
      swipes: ['a', 'b'],
      swipe_id: 47,
    });
    expect(high.swipe_id).toBe(1);
    assertConsistent(high);

    const negative = fromChatMessage({
      id: '1',
      name: 'A',
      is_user: false,
      is_system: false,
      mes: 'x',
      send_date: 'd',
      swipes: ['a', 'b'],
      swipe_id: -3,
    });
    expect(negative.swipe_id).toBe(0);
    assertConsistent(negative);
  });

  test('a short swipe_info array is padded to match swipes', () => {
    // Under noUncheckedIndexedAccess a short array turns into undefined at the first
    // swipe-right, so padding here is what keeps the rest of the module total.
    const state = fromChatMessage({
      id: '1',
      name: 'A',
      is_user: false,
      is_system: false,
      mes: 'a',
      send_date: '2026-01-01T00:00:00.000Z',
      swipes: ['a', 'b', 'c'],
      swipe_id: 0,
      swipe_info: [{ send_date: '2026-01-01T00:00:00.000Z' }],
    });

    expect(state.swipe_info.length).toBe(3);
    expect(state.swipe_info[2]?.send_date).toBeTruthy();
    assertConsistent(state);
  });

  test('top-level metadata is folded into the active swipe', () => {
    const state = fromChatMessage({
      id: '1',
      name: 'A',
      is_user: false,
      is_system: false,
      mes: 'b',
      send_date: '2026-01-02T00:00:00.000Z',
      gen_finished: '2026-01-02T00:00:05.000Z',
      extra: { model: 'gpt-4o', token_count: 12 },
      swipes: ['a', 'b'],
      swipe_id: 1,
    });

    expect(state.swipe_info[1]?.extra?.model).toBe('gpt-4o');
    expect(state.swipe_info[1]?.gen_finished).toBe('2026-01-02T00:00:05.000Z');
    // Swipe 0's metadata is untouched by the active swipe's.
    expect(state.swipe_info[0]?.extra).toBeUndefined();
  });

  test('a well-formed message round-trips unchanged', () => {
    const original: ChatMessage = {
      id: 'm1',
      name: 'Seraphina',
      is_user: false,
      is_system: false,
      mes: 'second',
      send_date: '2026-01-01T00:00:00.000Z',
      gen_started: '2026-01-01T00:00:01.000Z',
      gen_finished: '2026-01-01T00:00:04.000Z',
      swipes: ['first', 'second'],
      swipe_id: 1,
      swipe_info: [
        { send_date: '2026-01-01T00:00:00.000Z' },
        {
          send_date: '2026-01-01T00:00:00.000Z',
          gen_started: '2026-01-01T00:00:01.000Z',
          gen_finished: '2026-01-01T00:00:04.000Z',
          extra: { model: 'gpt-4o' },
        },
      ],
      extra: { model: 'gpt-4o' },
    };

    expect(toChatMessage(fromChatMessage(original))).toEqual(original);
  });

  test('a recorded speaker survives the round trip, null included', () => {
    // Null is the message "sent with no persona" and must not collapse into the missing
    // key that means "legacy, speaker unknown".
    const withPersona: ChatMessage = {
      id: 'u1',
      name: 'Jack',
      is_user: true,
      is_system: false,
      persona_id: 'persona-1',
      mes: 'hi',
      send_date: '2026-01-01T00:00:00.000Z',
      swipes: ['hi'],
      swipe_id: 0,
      swipe_info: [{ send_date: '2026-01-01T00:00:00.000Z' }],
    };
    expect(toChatMessage(fromChatMessage(withPersona))).toEqual(withPersona);

    const noPersona: ChatMessage = { ...withPersona, persona_id: null };
    expect(toChatMessage(fromChatMessage(noPersona))).toEqual(noPersona);
    expect(Object.hasOwn(toChatMessage(fromChatMessage(noPersona)), 'persona_id')).toBe(true);
  });

  test('a legacy message without a speaker keeps no key at all', () => {
    const legacy: ChatMessage = {
      id: 'u1',
      name: 'Jack',
      is_user: true,
      is_system: false,
      mes: 'hi',
      send_date: '2026-01-01T00:00:00.000Z',
      swipes: ['hi'],
      swipe_id: 0,
      swipe_info: [{ send_date: '2026-01-01T00:00:00.000Z' }],
    };
    expect(toChatMessage(fromChatMessage(legacy))).toEqual(legacy);
    expect(Object.hasOwn(toChatMessage(fromChatMessage(legacy)), 'persona_id')).toBe(false);
  });

  test('a nonsense speaker value degrades to unknown, an empty one to none', () => {
    const garbage = fromChatMessage({
      id: 'u1',
      name: 'Jack',
      is_user: true,
      is_system: false,
      persona_id: 42 as unknown as string,
      mes: 'hi',
      send_date: 'd',
    });
    expect(garbage.persona_id).toBeUndefined();

    const blank = fromChatMessage({
      id: 'u1',
      name: 'Jack',
      is_user: true,
      is_system: false,
      persona_id: '',
      mes: 'hi',
      send_date: 'd',
    });
    expect(blank.persona_id).toBeNull();
  });

  test('a foreign message with a nonsense swipe entry survives', () => {
    const state = fromChatMessage({
      id: '1',
      name: 'A',
      is_user: false,
      is_system: false,
      mes: 'a',
      send_date: 'd',
      swipes: ['a', 42 as unknown as string, 'c'],
      swipe_id: 0,
    });

    expect(state.swipes).toEqual(['a', 'c']);
    assertConsistent(state);
  });
});

describe('swipe mutation', () => {
  const base = fromChatMessage({
    id: '1',
    name: 'Seraphina',
    is_user: false,
    is_system: false,
    mes: 'one',
    send_date: '2026-01-01T00:00:00.000Z',
    swipes: ['one', 'two', 'three'],
    swipe_id: 0,
  });

  test('setText only touches the current swipe', () => {
    const edited = setText(base, 'edited');
    expect(edited.swipes).toEqual(['edited', 'two', 'three']);
    assertConsistent(edited);
  });

  test('setText merges extra rather than replacing it', () => {
    const first = setText(base, 'x', { extra: { model: 'gpt-4o' } });
    const second = setText(first, 'x', { extra: { token_count: 9 } });
    expect(second.swipe_info[0]?.extra).toEqual({ model: 'gpt-4o', token_count: 9 });
  });

  test('selectSwipe is a pure index change — the swipes array keeps its identity', () => {
    const moved = selectSwipe(base, 2);
    expect(moved.swipe_id).toBe(2);
    expect(moved.swipes).toBe(base.swipes);
    assertConsistent(moved);
  });

  test('selectSwipe ignores out-of-range indices', () => {
    expect(selectSwipe(base, 9)).toBe(base);
    expect(selectSwipe(base, -1)).toBe(base);
  });

  test('appendSwipe grows both arrays in lockstep and selects the new one', () => {
    const grown = appendSwipe(base, 'four');
    expect(grown.swipes.length).toBe(4);
    expect(grown.swipe_info.length).toBe(4);
    expect(grown.swipe_id).toBe(3);
    expect(currentText(grown)).toBe('four');
    assertConsistent(grown);
  });

  test('removeSwipe shifts the selection back when it removes at or before it', () => {
    const at2 = selectSwipe(base, 2);
    const removed = removeSwipe(at2, 1);
    expect(removed.swipes).toEqual(['one', 'three']);
    expect(removed.swipe_id).toBe(1);
    expect(currentText(removed)).toBe('three');
    assertConsistent(removed);
  });

  test('removing the selected last swipe falls back to the previous one', () => {
    // This is the failed-overswipe path: append a blank swipe, generation fails,
    // remove it, and the user must land back where they were.
    const overswiped = appendSwipe(base, '');
    const restored = removeSwipe(overswiped, overswiped.swipe_id);
    expect(restored.swipes).toEqual(['one', 'two', 'three']);
    expect(restored.swipe_id).toBe(2);
    assertConsistent(restored);
  });

  test('the final swipe is emptied rather than removed', () => {
    const single = userMessage('1', 'Jack', 'hi', null);
    const removed = removeSwipe(single, 0);
    expect(removed.swipes).toEqual(['']);
    assertConsistent(removed);
  });

  test('resetSwipes collapses to one empty swipe — regenerate loses alternates', () => {
    const reset = resetSwipes(base);
    expect(reset.swipes).toEqual(['']);
    expect(reset.swipe_info.length).toBe(1);
    expect(reset.swipe_id).toBe(0);
    assertConsistent(reset);
  });
});

describe('construction', () => {
  test('a greeting turns alternate_greetings into swipes', () => {
    const message = greetingMessage(
      'm0',
      card({ alternate_greetings: ['Alt one.', 'Alt two.', 'Alt three.'] }),
    );

    expect(message.swipes).toEqual(['Hello, traveller.', 'Alt one.', 'Alt two.', 'Alt three.']);
    expect(message.swipe_info.length).toBe(4);
    expect(message.swipe_id).toBe(0);
    expect(message.is_user).toBe(false);
    assertConsistent(message);
  });

  test('a card with no alternates gives a single-swipe greeting', () => {
    const message = greetingMessage('m0', card());
    expect(message.swipes).toEqual(['Hello, traveller.']);
    assertConsistent(message);
  });

  test('an empty first_mes with alternates drops the empty slot', () => {
    const message = greetingMessage(
      'm0',
      card({ first_mes: '', alternate_greetings: ['Only this.'] }),
    );
    expect(message.swipes).toEqual(['Only this.']);
    assertConsistent(message);
  });

  test('macros in a greeting are left unresolved for the assembler', () => {
    const message = greetingMessage('m0', card({ first_mes: 'Hello {{user}}.' }));
    expect(currentText(message)).toBe('Hello {{user}}.');
  });

  test('a user message records the persona it was sent as', () => {
    // Captured at construction, like `name`: a later persona switch must not re-face
    // the transcript.
    const spoken = userMessage('u1', 'Jack', 'hi', 'persona-1');
    expect(spoken.persona_id).toBe('persona-1');
    assertConsistent(spoken);

    const unspoken = userMessage('u2', 'You', 'hi', null);
    expect(unspoken.persona_id).toBeNull();
    expect(Object.hasOwn(toChatMessage(unspoken), 'persona_id')).toBe(true);
  });

  test('assistant messages carry no speaker key', () => {
    expect(greetingMessage('m0', card()).persona_id).toBeUndefined();
    expect(assistantPlaceholder('m1', 'Seraphina').persona_id).toBeUndefined();
    expect(
      Object.hasOwn(toChatMessage(assistantPlaceholder('m1', 'Seraphina')), 'persona_id'),
    ).toBe(false);
  });

  test('a placeholder starts empty so the assembler skips it', () => {
    // assemble.ts drops messages whose content is blank, which is how the message being
    // regenerated or swiped excludes itself from its own prompt.
    const placeholder = assistantPlaceholder('m1', 'Seraphina');
    expect(currentText(placeholder)).toBe('');
    expect(placeholder.swipe_info[0]?.gen_started).toBeTruthy();
    assertConsistent(placeholder);
  });
});

describe('the invariant holds across arbitrary action sequences', () => {
  test('mes always equals the selected swipe', () => {
    let message = greetingMessage('m0', card({ alternate_greetings: ['b', 'c'] }));

    const operations: ((m: MessageState) => MessageState)[] = [
      (m) => setText(m, 'edited'),
      (m) => appendSwipe(m, 'appended'),
      (m) => selectSwipe(m, 1),
      (m) => removeSwipe(m, 0),
      (m) => selectSwipe(m, 0),
      (m) => appendSwipe(m, ''),
      (m) => removeSwipe(m, m.swipe_id),
      (m) => resetSwipes(m),
      (m) => setText(m, 'after reset'),
      (m) => appendSwipe(m, 'again'),
      (m) => selectSwipe(m, 42),
      (m) => removeSwipe(m, -1),
    ];

    for (const operation of operations) {
      message = operation(message);
      assertConsistent(message);
      // And the projection survives a trip through storage unchanged.
      expect(fromChatMessage(toChatMessage(message)).swipes).toEqual(message.swipes);
    }
  });
});
