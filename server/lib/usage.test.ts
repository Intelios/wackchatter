import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_LOG_MAX_BYTES, type UsageRecord } from '../../shared/types/usage.ts';
import { appendUsage, libraryPointerPath, publishLibraryPointer, usageLogPath } from './usage.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wc-usage-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 1,
    id: 'gen-1',
    ts: '2026-08-31T10:00:05.000Z',
    feature: 'chat',
    session_id: 'chat-a',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5',
    input_tokens: 8421,
    output_tokens: 612,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    duration_ms: 9210,
    estimated: false,
    aborted: false,
    ...overrides,
  };
}

function lines(): string[] {
  return readFileSync(usageLogPath(home), 'utf8').split('\n').filter(Boolean);
}

describe('appendUsage', () => {
  test('creates the directory and appends one line per record', () => {
    expect(appendUsage(record(), home)).toBe(true);
    expect(appendUsage(record({ id: 'gen-2' }), home)).toBe(true);

    const written = lines();
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!)).toEqual(record());
    expect(JSON.parse(written[1]!).id).toBe('gen-2');
  });

  test('each line is self-contained JSON, so a reader can tail it', () => {
    appendUsage(record(), home);
    const raw = readFileSync(usageLogPath(home), 'utf8');
    // Trailing newline matters: a reader that stops at the last \n must not be left
    // holding a complete record it decided was partial.
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\n')).toBe(true);
    expect(raw.trimEnd().includes('\n')).toBe(false);
  });

  test('the log is owner-readable only — it names models and characters', () => {
    appendUsage(record(), home);
    expect(statSync(usageLogPath(home)).mode & 0o777).toBe(0o600);
  });

  test('rotates once past the size cap and starts a fresh log', () => {
    const path = usageLogPath(home);
    appendUsage(record(), home);
    writeFileSync(path, 'x'.repeat(USAGE_LOG_MAX_BYTES + 1));

    appendUsage(record({ id: 'after-rotation' }), home);

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!).id).toBe('after-rotation');
  });

  test('a log below the cap is left alone', () => {
    appendUsage(record(), home);
    appendUsage(record({ id: 'gen-2' }), home);
    expect(existsSync(`${usageLogPath(home)}.1`)).toBe(false);
  });

  test('reports failure rather than throwing when the path is unusable', () => {
    // A file where the directory has to go: mkdir cannot succeed, and a generation must
    // not be taken down by it.
    writeFileSync(join(home, '.wackchatter'), 'not a directory');
    expect(appendUsage(record(), home)).toBe(false);
  });
});

describe('publishLibraryPointer', () => {
  test('writes a versioned pointer at the fixed path', () => {
    publishLibraryPointer(home);

    const pointer = JSON.parse(readFileSync(libraryPointerPath(home), 'utf8'));
    expect(pointer.version).toBe(1);
    expect(typeof pointer.dataDir).toBe('string');
    expect(pointer.dataDir.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(pointer.updated))).toBe(false);
  });

  test('is idempotent — a second boot overwrites rather than appending', () => {
    publishLibraryPointer(home);
    publishLibraryPointer(home);
    expect(JSON.parse(readFileSync(libraryPointerPath(home), 'utf8')).version).toBe(1);
  });
});
