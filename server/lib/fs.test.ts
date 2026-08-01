import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, withFileLock } from './fs.ts';

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
