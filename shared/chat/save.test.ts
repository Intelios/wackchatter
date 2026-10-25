import { describe, expect, test } from 'bun:test';
import { type MessageState, userMessage } from './message.ts';
import { buildChatSaveBody, type ChatSaveBase, type ChatSaveRecord } from './save.ts';

function state(id: string, text: string): MessageState {
  return userMessage(id, 'User', text, null);
}

function record(overrides: Partial<ChatSaveRecord> = {}): ChatSaveRecord {
  return {
    chatId: 'chat-1',
    revision: 3,
    saveId: 'save-3',
    title: 'A chat',
    metadata: { persona: 'jack' },
    states: [],
    ...overrides,
  };
}

function base(overrides: Partial<ChatSaveBase> = {}): ChatSaveBase {
  return {
    revision: 2,
    title: 'A chat',
    metadata: { persona: 'jack' },
    states: [],
    ...overrides,
  };
}

describe('buildChatSaveBody', () => {
  test('a message edit ships only the changed message plus the order', () => {
    const a = state('a', 'one');
    const b = state('b', 'two');
    const edited = { ...b, swipes: ['two, revised'] };
    const metadata = { persona: 'jack' };
    const body = buildChatSaveBody(
      record({ states: [a, edited], metadata }),
      base({ states: [a, b], metadata }),
    );

    expect(body).toMatchObject({ revision: 3, saveId: 'save-3', baseRevision: 2 });
    expect(body.order).toEqual(['a', 'b']);
    // The diff is by identity, so an untouched neighbour never leaves the client.
    expect(body.upsert).toHaveLength(1);
    expect(body.upsert![0]).toMatchObject({ id: 'b', mes: 'two, revised' });
    // Head fields are unchanged and stay home.
    expect(body.title).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  test('an append ships the order and just the new message', () => {
    const a = state('a', 'one');
    const b = state('b', 'two');
    const body = buildChatSaveBody(record({ states: [a, b] }), base({ states: [a] }));

    expect(body.order).toEqual(['a', 'b']);
    expect(body.upsert?.map((m) => m.id)).toEqual(['b']);
  });

  test('a deletion ships the new order and no upserts', () => {
    const a = state('a', 'one');
    const b = state('b', 'two');
    const body = buildChatSaveBody(record({ states: [a] }), base({ states: [a, b] }));

    expect(body.order).toEqual(['a']);
    expect(body.upsert).toBeUndefined();
  });

  test('a metadata-only change is a head-only body', () => {
    const a = state('a', 'one');
    const metadata = { persona: 'alex' };
    const body = buildChatSaveBody(record({ states: [a], metadata }), base({ states: [a] }));

    expect(body.metadata).toBe(metadata);
    expect(body.title).toBeUndefined();
    expect(body.order).toBeUndefined();
    expect(body.upsert).toBeUndefined();
  });

  test('an identical record produces a head-only empty body', () => {
    const a = state('a', 'one');
    const metadata = { persona: 'jack' };
    const body = buildChatSaveBody(
      record({ states: [a], metadata }),
      base({ states: [a], metadata }),
    );

    expect(body.title).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.order).toBeUndefined();
    expect(body.upsert).toBeUndefined();
  });

  test('without a base every save is the whole document', () => {
    const a = state('a', 'one');
    const body = buildChatSaveBody(record({ states: [a] }), undefined, {
      baseRevision: 4,
    });

    expect(body.baseRevision).toBe(4);
    expect(body.title).toBe('A chat');
    expect(body.metadata).toEqual({ persona: 'jack' });
    expect(body.order).toEqual(['a']);
    expect(body.upsert).toHaveLength(1);
    expect(body.upsert![0]!.mes).toBe('one');
  });

  test('a forced full save resends everything even against a base', () => {
    const a = state('a', 'one');
    const body = buildChatSaveBody(record({ states: [a] }), base({ states: [a] }), {
      full: true,
      baseRevision: 5,
    });

    expect(body.baseRevision).toBe(5);
    expect(body.title).toBe('A chat');
    expect(body.order).toEqual(['a']);
    expect(body.upsert).toHaveLength(1);
  });

  test('an empty transcript is an empty order, not a missing one', () => {
    const a = state('a', 'one');
    const body = buildChatSaveBody(record({ states: [] }), base({ states: [a] }));

    expect(body.order).toEqual([]);
    expect(body.upsert).toBeUndefined();
  });
});
