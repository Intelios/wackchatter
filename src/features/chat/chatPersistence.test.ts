import { describe, expect, test } from 'bun:test';
import { type MessageState, userMessage } from '@shared/chat/message.ts';
import type { ChatSaveBody, ChatSaveRecord } from '@shared/chat/save.ts';
import { ApiError } from '../../lib/api.ts';
import { ChatSaveQueue } from './chatPersistence.ts';

function state(id: string, text = 'hi'): MessageState {
  return userMessage(id, 'User', text, null);
}

function record(
  chatId: string,
  revision: number,
  states: MessageState[],
  overrides: Partial<ChatSaveRecord> = {},
): ChatSaveRecord {
  return {
    chatId,
    revision,
    saveId: `save-${chatId}-${revision}`,
    title: `${chatId} title`,
    metadata: { persona: 'p1' },
    states,
    ...overrides,
  };
}

function staleError(currentRevision: number): ApiError {
  return new ApiError('Chat changed elsewhere.', 409, {
    code: 'stale_revision',
    currentRevision,
  });
}

describe('ChatSaveQueue', () => {
  test('after adopt, a save ships only the changed messages', async () => {
    const bodies: ChatSaveBody[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
    }, 60_000);

    const a = state('a');
    const b = state('b');
    const c = state('c');
    const metadata = { persona: 'p1' };
    queue.adopt('chat', 2, { title: 'chat title', metadata, states: [a, b] });
    queue.schedule(record('chat', 3, [a, { ...b, swipes: ['edited'] }, c], { metadata }));

    await queue.flush('chat');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ revision: 3, baseRevision: 2 });
    expect(bodies[0]!.order).toEqual(['a', 'b', 'c']);
    expect(bodies[0]!.upsert?.map((m) => m.id).sort()).toEqual(['b', 'c']);
    // Unchanged head fields are not shipped either.
    expect(bodies[0]!.title).toBeUndefined();
    expect(bodies[0]!.metadata).toBeUndefined();
  });

  test('a metadata-only change sends no transcript fields', async () => {
    const bodies: ChatSaveBody[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
    }, 60_000);

    const a = state('a');
    queue.adopt('chat', 1, { title: 'chat title', metadata: { persona: 'p1' }, states: [a] });
    queue.schedule(record('chat', 2, [a], { metadata: { persona: 'other' } }));

    await queue.flush('chat');

    expect(bodies[0]).toMatchObject({ revision: 2, metadata: { persona: 'other' } });
    expect(bodies[0]!.order).toBeUndefined();
    expect(bodies[0]!.upsert).toBeUndefined();
  });

  test('serializes revisions and diffs each against the last acknowledged save', async () => {
    const bodies: ChatSaveBody[] = [];
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
      if (body.revision === 1) await firstSave;
    }, 60_000);
    const metadata = { persona: 'p1' };
    queue.adopt('chat', 0, { title: 'chat title', metadata, states: [] });

    const a = state('a');
    const b = state('b');
    queue.schedule(record('chat', 1, [a], { metadata }));
    const flushing = queue.flush('chat');
    await Promise.resolve();
    queue.schedule(record('chat', 2, [a, b], { metadata }));
    releaseFirst();
    await flushing;

    expect(bodies.map((body) => body.revision)).toEqual([1, 2]);
    // The second save is a delta on the first, not a resend.
    expect(bodies[1]).toMatchObject({ baseRevision: 1, order: ['a', 'b'] });
    expect(bodies[1]!.upsert?.map((m) => m.id)).toEqual(['b']);
  });

  test('a stale delta retries once as the whole document at the reported revision', async () => {
    const bodies: ChatSaveBody[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
      // The lost-ack case: the server holds an older revision than our base claims.
      if (bodies.length === 1) throw staleError(1);
    }, 60_000);
    const metadata = { persona: 'p1' };
    const a = state('a');
    const b = state('b');
    queue.adopt('chat', 2, { title: 'chat title', metadata, states: [a] });
    queue.schedule(record('chat', 3, [a, b], { metadata }));

    await queue.flush('chat');

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.baseRevision).toBe(2);
    expect(bodies[1]).toMatchObject({
      baseRevision: 1,
      title: 'chat title',
      metadata,
      order: ['a', 'b'],
    });
    expect(bodies[1]!.upsert).toHaveLength(2);
  });

  test('a stale answer at the save\u2019s own revision is a real conflict, not retried', async () => {
    let attempts = 0;
    const queue = new ChatSaveQueue(async () => {
      attempts++;
      throw staleError(3);
    }, 60_000);
    queue.adopt('chat', 2, { title: 'chat title', metadata: {}, states: [] });
    queue.schedule(record('chat', 3, [state('a')]));

    await expect(queue.flush('chat')).rejects.toThrow('Chat changed elsewhere.');
    expect(attempts).toBe(1);
  });

  test('a failed save keeps its record and its idempotency token for the retry', async () => {
    const bodies: ChatSaveBody[] = [];
    let attempts = 0;
    const failures: string[] = [];
    const queue = new ChatSaveQueue(
      async (_chatId, body) => {
        attempts++;
        bodies.push(body);
        if (attempts === 1) throw new Error('offline');
      },
      60_000,
      { onFailed: (_chatId, error) => failures.push(error.message) },
    );
    queue.adopt('chat', 0, { title: 'chat title', metadata: {}, states: [] });
    queue.schedule(record('chat', 1, [state('a')]));

    await expect(queue.flush('chat')).rejects.toThrow('offline');
    await queue.retry('chat');

    expect(attempts).toBe(2);
    expect(failures).toEqual(['offline']);
    // Same save unit, same token — the retry is replay-safe by construction.
    expect(bodies.map((body) => body.saveId)).toEqual(['save-chat-1', 'save-chat-1']);
  });

  test('a keepalive redelivery carries the same token the flush does', async () => {
    const sends: { body: ChatSaveBody; options?: Pick<RequestInit, 'keepalive'> }[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body, options) => {
      sends.push({ body, options });
    }, 60_000);
    queue.adopt('chat', 0, { title: 'chat title', metadata: {}, states: [] });
    queue.schedule(record('chat', 1, [state('a')]));

    queue.flushForPagehide();
    await Promise.resolve();
    await queue.flush('chat');

    // Pagehide is best-effort, then the debounced flush may send the same record again:
    // only the shared token keeps that redelivery from conflicting with itself.
    expect(sends.map(({ body }) => body.saveId)).toEqual(['save-chat-1', 'save-chat-1']);
    expect(sends[0]!.options).toEqual({ keepalive: true });
  });

  test('a late adopt offer while dirty is ignored', async () => {
    const bodies: ChatSaveBody[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
    }, 60_000);
    const a = state('a');
    queue.schedule(record('chat', 1, [a]));
    // Dirt already queued: a load landing now cannot be the document the queued save
    // was computed against.
    queue.adopt('chat', 0, { title: 'chat title', metadata: {}, states: [state('old')] });

    await queue.flush('chat');

    // No trusted base, so the whole document goes — the adopt was not applied.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.order).toEqual(['a']);
    expect(bodies[0]!.upsert).toHaveLength(1);
    expect(bodies[0]!.metadata).toBeDefined();
  });

  test('a save scheduled before any adopt is the whole document', async () => {
    const bodies: ChatSaveBody[] = [];
    const queue = new ChatSaveQueue(async (_chatId, body) => {
      bodies.push(body);
    }, 60_000);
    queue.adopt('chat', 0);
    queue.schedule(record('chat', 1, [state('a')]));

    await queue.flush('chat');

    expect(bodies[0]).toMatchObject({ baseRevision: 0, order: ['a'] });
    expect(bodies[0]!.upsert).toHaveLength(1);
    expect(bodies[0]!.title).toBe('chat title');
    expect(bodies[0]!.metadata).toBeDefined();
  });
});
