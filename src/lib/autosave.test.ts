import { describe, expect, test } from 'bun:test';
import { AutosaveQueue } from './autosave.ts';

describe('AutosaveQueue', () => {
  test('owns an immutable snapshot per entity', async () => {
    const writes: Array<[string, { text: string }]> = [];
    const queue = new AutosaveQueue<{ text: string }>(async (id, snapshot) => {
      writes.push([id, snapshot]);
    }, 60_000);

    const a = { text: 'A' };
    const b = { text: 'B' };
    queue.schedule('a', 1, a);
    queue.schedule('b', 1, b);
    a.text = 'mutated after enqueue';
    b.text = 'mutated too';

    await queue.flushAll();

    expect(writes).toEqual([
      ['a', { text: 'A' }],
      ['b', { text: 'B' }],
    ]);
  });

  test('coalesces only updates to the same entity', async () => {
    const writes: Array<[string, number]> = [];
    const queue = new AutosaveQueue<number>(async (id, snapshot) => {
      writes.push([id, snapshot]);
    }, 60_000);

    queue.schedule('a', 1, 1);
    queue.schedule('a', 2, 2);
    queue.schedule('b', 1, 10);

    await queue.flushAll();

    // 'a' coalesced to its newest revision; 'b' was untouched by 'a's edits.
    expect(writes).toEqual([
      ['a', 2],
      ['b', 10],
    ]);
  });

  test('ignores a stale revision scheduled after a newer one', async () => {
    const writes: number[] = [];
    const queue = new AutosaveQueue<number>(async (_id, snapshot) => {
      writes.push(snapshot);
    }, 60_000);

    queue.schedule('a', 5, 5);
    queue.schedule('a', 3, 3);

    await queue.flush('a');
    expect(writes).toEqual([5]);
  });

  test('serializes writes so a slow older save lands before the newer one', async () => {
    const writes: number[] = [];
    let releaseFirst!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new AutosaveQueue<number>(async (_id, snapshot) => {
      writes.push(snapshot);
      if (snapshot === 1) await firstSave;
    }, 60_000);

    queue.schedule('a', 1, 1);
    const flushing = queue.flush('a');
    await waitFor(() => writes.includes(1));
    queue.schedule('a', 2, 2);
    releaseFirst();
    await flushing;

    expect(writes).toEqual([1, 2]);
  });

  test('retains a failed snapshot for retry', async () => {
    let attempts = 0;
    const failures: string[] = [];
    const queue = new AutosaveQueue<number>(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('offline');
      },
      60_000,
      { onFailed: (_id, error) => failures.push(error.message) },
    );

    queue.schedule('a', 1, 1);
    await expect(queue.flush('a')).rejects.toThrow('offline');
    await queue.retry('a');

    expect(attempts).toBe(2);
    expect(failures).toEqual(['offline']);
    expect(queue.isDirty('a')).toBe(false);
  });

  test('passes the transport result to onSaved', async () => {
    const results: Array<[string, string]> = [];
    const queue = new AutosaveQueue<number, string>(
      async (id, snapshot) => `${id}:${snapshot}`,
      60_000,
      { onSaved: (id, _snapshot, result) => results.push([id, result]) },
    );

    queue.schedule('a', 1, 7);
    await queue.flush('a');

    expect(results).toEqual([['a', 'a:7']]);
  });

  test('discard drops pending work and recorded revision', async () => {
    const writes: number[] = [];
    const queue = new AutosaveQueue<number>(async (_id, snapshot) => {
      writes.push(snapshot);
    }, 60_000);

    queue.schedule('a', 1, 1);
    queue.discard('a');
    await queue.flushAll();

    expect(writes).toEqual([]);
    expect(queue.isDirty('a')).toBe(false);
  });

  test('nextRevision outranks a saved revision, so a restarted consumer cannot stall', async () => {
    const writes: string[] = [];
    const queue = new AutosaveQueue<string>(async (_id, snapshot) => {
      writes.push(snapshot);
    }, 60_000);

    queue.schedule('a', queue.nextRevision('a'), 'first burst');
    await queue.flush('a');

    // The regression: an editor that owned its own counter restarted it here — its sync
    // effect re-ran on the fresh detail the save handed back — and every later edit below
    // the queue's high-water mark was dropped unsent, invisible to flush.
    queue.schedule('a', queue.nextRevision('a'), 'short edit after a save');
    await queue.flush('a');

    expect(writes).toEqual(['first burst', 'short edit after a save']);
    expect(queue.isDirty('a')).toBe(false);
  });

  test('nextRevision outranks an unsent queued revision', () => {
    const queue = new AutosaveQueue<string>(async () => {}, 60_000);

    queue.schedule('a', queue.nextRevision('a'), 'first');
    queue.schedule('a', queue.nextRevision('a'), 'second');

    expect(queue.isDirty('a')).toBe(true);
  });

  test('flushAll saves every entity and reports failures after all settle', async () => {
    const saved: string[] = [];
    const queue = new AutosaveQueue<number>(async (id) => {
      if (id === 'bad') throw new Error('nope');
      saved.push(id);
    }, 60_000);

    queue.schedule('bad', 1, 1);
    queue.schedule('good', 1, 1);
    await expect(queue.flushAll()).rejects.toThrow('One or more autosaves failed');

    expect(saved).toEqual(['good']);
  });

  test('runSerialized drains pending saves and blocks new ones until the task settles', async () => {
    const order: string[] = [];
    let releaseSave1!: () => void;
    const save1Gate = new Promise<void>((resolve) => {
      releaseSave1 = resolve;
    });
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    const queue = new AutosaveQueue<number>(async (_id, snapshot) => {
      order.push(`save:${snapshot}:start`);
      if (snapshot === 1) await save1Gate;
      order.push(`save:${snapshot}:end`);
    }, 60_000);

    queue.schedule('a', 1, 1);
    const running = queue.runSerialized('a', async () => {
      order.push('task:start');
      await taskGate;
      order.push('task:end');
      return 'done';
    });

    // The drain starts save:1, which blocks; the task cannot start until it settles.
    await waitFor(() => order.includes('save:1:start'));
    expect(order).toEqual(['save:1:start']);

    releaseSave1();
    await waitFor(() => order.includes('task:start'));
    expect(order).toEqual(['save:1:start', 'save:1:end', 'task:start']);

    // A save scheduled mid-task must wait for the task to settle.
    queue.schedule('a', 2, 2);
    releaseTask();
    const result = await running;
    await queue.flush('a');

    expect(result).toBe('done');
    expect(order).toEqual([
      'save:1:start',
      'save:1:end',
      'task:start',
      'task:end',
      'save:2:start',
      'save:2:end',
    ]);
  });

  test('runSerialized serializes two structural tasks even when there is no dirty save', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new AutosaveQueue<number>(async () => {}, 60_000);

    const first = queue.runSerialized('a', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.runSerialized('a', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await waitFor(() => order.includes('first:start'));
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  test('flushAll waits for an in-flight structural task with no dirty snapshot', async () => {
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let taskFinished = false;
    const queue = new AutosaveQueue<number>(async () => {}, 60_000);

    const task = queue.runSerialized('a', async () => {
      await taskGate;
      taskFinished = true;
    });
    const flushing = queue.flushAll();
    await Promise.resolve();
    expect(taskFinished).toBe(false);
    releaseTask();
    await Promise.all([task, flushing]);
    expect(taskFinished).toBe(true);
  });

  test('a failed pending save aborts a destructive serialized task', async () => {
    let taskRan = false;
    const queue = new AutosaveQueue<number>(async () => {
      throw new Error('offline');
    }, 60_000);
    queue.schedule('a', 1, 1);

    await expect(
      queue.runSerialized('a', async () => {
        taskRan = true;
      }),
    ).rejects.toThrow('offline');
    expect(taskRan).toBe(false);
    expect(queue.isDirty('a')).toBe(true);
  });

  test('does not publish an older response after a newer revision is queued', async () => {
    const published: number[] = [];
    const started: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new AutosaveQueue<number, number>(
      async (_id, snapshot) => {
        started.push(snapshot);
        if (snapshot === 1) await firstGate;
        return snapshot;
      },
      60_000,
      { onSaved: (_id, _snapshot, result) => published.push(result) },
    );

    queue.schedule('a', 1, 1);
    const flushing = queue.flush('a');
    await waitFor(() => started.includes(1));
    queue.schedule('a', 2, 2);
    releaseFirst();
    await flushing;

    expect(published).toEqual([2]);
  });
});

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor timed out');
}
