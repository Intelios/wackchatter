import { describe, expect, test } from 'bun:test';
import { KeyedSerialQueue, resolveInitialChat } from './chatInit.ts';

describe('KeyedSerialQueue', () => {
  test('returning A after starting B still waits for the original A task', async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const firstA = queue.run('A', async () => {
      order.push('A1:start');
      await aGate;
      order.push('A1:end');
    });
    const b = queue.run('B', async () => {
      order.push('B');
    });
    const secondA = queue.run('A', async () => {
      order.push('A2');
    });

    await b;
    expect(order).toContain('B');
    expect(order).not.toContain('A2');

    releaseA();
    await Promise.all([firstA, secondA]);
    expect(order.indexOf('A2')).toBeGreaterThan(order.indexOf('A1:end'));
  });

  test('a rejected task does not poison the next task for the key', async () => {
    const queue = new KeyedSerialQueue();
    await expect(queue.run('A', async () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    await expect(queue.run('A', async () => 42)).resolves.toBe(42);
  });
});

describe('resolveInitialChat', () => {
  test('a list failure never falls through to chat creation', async () => {
    let creates = 0;
    await expect(
      resolveInitialChat(
        {
          list: async () => Promise.reject(new Error('list failed')),
          get: async () => {
            throw new Error('not reached');
          },
          create: async () => {
            creates++;
            throw new Error('not reached');
          },
        },
        'A.png',
        { persona: null },
        () => true,
      ),
    ).rejects.toThrow('list failed');
    expect(creates).toBe(0);
  });

  test('an empty successful list creates only when the pass is still current', async () => {
    let creates = 0;
    const api = {
      list: async () => [],
      get: async () => {
        throw new Error('not reached');
      },
      create: async () => {
        creates++;
        return chat('new');
      },
    };

    expect(await resolveInitialChat(api, 'A.png', {}, () => false)).toEqual({
      chat: null,
      summaries: [],
      created: false,
    });
    expect(creates).toBe(0);

    expect((await resolveInitialChat(api, 'A.png', {}, () => true)).chat?.id).toBe('new');
    expect(creates).toBe(1);
  });
});

function chat(id: string) {
  return {
    id,
    characterId: 'A.png',
    title: 'New chat',
    created: 1,
    modified: 1,
    revision: 0,
    metadata: {},
    messages: [],
  };
}
