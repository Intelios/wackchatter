import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, drainLocks, withFileLock } from './fs.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-fs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomic file operations', () => {
  test('atomicWrite replaces the destination and leaves no temporary sibling', async () => {
    const path = join(dir, 'value.json');
    writeFileSync(path, 'old');

    await atomicWrite(path, 'new');

    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['value.json']);
  });

  test('withFileLock serializes the read, transform and replacement as one operation', async () => {
    const path = join(dir, 'value.json');
    writeFileSync(path, JSON.stringify({ a: 0, b: 0 }));

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const order: string[] = [];

    const first = withFileLock(path, async (replace) => {
      order.push('first:read');
      markFirstStarted();
      const value = JSON.parse(readFileSync(path, 'utf8')) as { a: number; b: number };
      value.a = 1;
      await firstGate;
      await replace(JSON.stringify(value));
      order.push('first:wrote');
    });

    const second = withFileLock(path, async (replace) => {
      order.push('second:read');
      const value = JSON.parse(readFileSync(path, 'utf8')) as { a: number; b: number };
      value.b = 1;
      await replace(JSON.stringify(value));
      order.push('second:wrote');
    });

    await firstStarted;
    expect(order).toEqual(['first:read']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1, b: 1 });
    expect(order).toEqual(['first:read', 'first:wrote', 'second:read', 'second:wrote']);
  });

  test('a failed locked operation does not poison the next one', async () => {
    const path = join(dir, 'value.txt');
    writeFileSync(path, 'old');

    await expect(
      withFileLock(path, async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');

    await withFileLock(path, (replace) => replace('recovered'));
    expect(readFileSync(path, 'utf8')).toBe('recovered');
  });
});

describe('drainLocks', () => {
  test('resolves once nothing is in flight', async () => {
    expect(await drainLocks(1000)).toBe(true);
  });

  test('waits for an in-flight write to settle', async () => {
    const path = join(dir, 'slow.txt');
    let released = false;

    const writing = withFileLock(path, async (replace) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await replace('done');
      released = true;
    });

    expect(await drainLocks(2000)).toBe(true);
    // The point of draining: nothing is half-written by the time it returns.
    expect(released).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('done');
    await writing;
  });

  test('a failed operation still counts as settled', async () => {
    const failing = withFileLock(join(dir, 'bad.txt'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('nope');
    });

    expect(await drainLocks(2000)).toBe(true);
    await expect(failing).rejects.toThrow('nope');
  });

  /*
   * Returning false rather than pressing on is deliberate: copying a tree mid-atomicWrite
   * captures the old file and strands the new one, and making the user retry beats that.
   */
  test('gives up rather than waiting forever', async () => {
    let unblock!: () => void;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const stuck = withFileLock(join(dir, 'stuck.txt'), () => held);

    expect(await drainLocks(60)).toBe(false);

    unblock();
    await stuck;
  });
});
