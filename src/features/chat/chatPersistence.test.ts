import { describe, expect, test } from 'bun:test';
import type { ChatSaveSnapshot } from '@shared/types/chat.ts';
import { ChatSaveQueue } from './chatPersistence.ts';

function snapshot(chatId: string, revision: number, text: string): ChatSaveSnapshot {
  return {
    chatId,
    revision,
    title: `${chatId} title`,
    metadata: { persona: 'p1' },
    messages: [
      {
        id: `${chatId}-${revision}`,
        name: 'User',
        is_user: true,
        is_system: false,
        mes: text,
        send_date: '',
      },
    ],
  };
}

describe('ChatSaveQueue', () => {
  test('owns an immutable snapshot for each chat', async () => {
    const writes: ChatSaveSnapshot[] = [];
    const queue = new ChatSaveQueue(async (item) => {
      writes.push(item);
    }, 60_000);
    queue.adopt('a', 0);
    queue.adopt('b', 0);

    const a = snapshot('a', 1, 'A transcript');
    const b = snapshot('b', 1, 'B transcript');
    queue.schedule(a);
    queue.schedule(b);
    a.messages[0]!.mes = 'mutated after enqueue';
    b.metadata.persona = 'other';

    await queue.flush('a');
    await queue.flush('b');

    expect(
      writes.map((item) => [item.chatId, item.messages[0]?.mes, item.metadata.persona]),
    ).toEqual([
      ['a', 'A transcript', 'p1'],
      ['b', 'B transcript', 'p1'],
    ]);
  });

  test('serializes revisions for one chat and saves a newer revision after a slow one', async () => {
    const writes: number[] = [];
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new ChatSaveQueue(async (item) => {
      writes.push(item.revision);
      if (item.revision === 1) {
        await firstSave;
      }
    }, 60_000);
    queue.adopt('a', 0);
    queue.schedule(snapshot('a', 1, 'one'));

    const flushing = queue.flush('a');
    await Promise.resolve();
    queue.schedule(snapshot('a', 2, 'two'));
    releaseFirst();
    await flushing;

    expect(writes).toEqual([1, 2]);
  });

  test('retains a failed snapshot for Retry', async () => {
    let attempts = 0;
    const failures: string[] = [];
    const queue = new ChatSaveQueue(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('offline');
      },
      60_000,
      { onFailed: (_, error) => failures.push(error.message) },
    );
    queue.adopt('a', 0);
    queue.schedule(snapshot('a', 1, 'keep me'));

    await expect(queue.flush('a')).rejects.toThrow('offline');
    await queue.retry('a');

    expect(attempts).toBe(2);
    expect(failures).toEqual(['offline']);
  });

  test('uses keepalive for the best-effort pagehide snapshot', async () => {
    const options: Array<Pick<RequestInit, 'keepalive'> | undefined> = [];
    const queue = new ChatSaveQueue(async (_, requestOptions) => {
      options.push(requestOptions);
    }, 60_000);
    queue.adopt('a', 0);
    queue.schedule(snapshot('a', 1, 'last edit'));

    queue.flushForPagehide();
    await Promise.resolve();
    expect(options).toEqual([{ keepalive: true }]);

    // Clean up the debounce timer owned by this test.
    await queue.flush('a');
  });
});
