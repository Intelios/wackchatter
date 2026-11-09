import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODEL_SLOTS } from '@shared/models/slots.ts';
import type { Connection } from '@shared/providers/types.ts';
import {
  backupAge,
  backupIsStale,
  connectionHealth,
  connectionUses,
  endpointLabel,
  SETTING_INDEX,
  SETTINGS_CHAPTERS,
} from './settings.ts';

const ref = (connectionId: string) => ({ connectionId, modelId: 'm' });

describe('connections', () => {
  test('a connection serves the slots that run on it, slots following chat included', () => {
    const models = {
      ...DEFAULT_MODEL_SLOTS,
      chat: ref('or'),
      nexus: ref('or'),
      sideChat: ref('ol'),
    };
    expect(connectionUses(models, 'or')).toEqual(['chat', 'summary', 'memory', 'co-creator']);
    expect(connectionUses(models, 'ol')).toEqual(['side chat']);
    expect(connectionUses({ ...models, summary: ref('ol') }, 'or')).toEqual([
      'chat',
      'memory',
      'co-creator',
    ]);
    expect(connectionUses(models, 'none')).toEqual([]);
  });

  test('the dot: a failed test, then a missing key where one is needed', () => {
    const openrouter = { id: 'or', provider: 'openrouter', baseUrl: '' } as Connection;
    const local = { id: 'lo', provider: 'custom', baseUrl: '' } as Connection;
    expect(connectionHealth(openrouter, undefined, undefined)).toBe('nokey');
    expect(connectionHealth(openrouter, { present: true, hint: '7f3a' }, undefined)).toBe('ok');
    expect(connectionHealth(local, undefined, undefined)).toBe('ok');
    expect(connectionHealth(local, undefined, { state: 'failed', error: 'x' })).toBe('failed');
    expect(endpointLabel('https://openrouter.ai/api/v1/')).toBe('openrouter.ai/api/v1');
  });
});

describe('the last backup', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  test('reads in words', () => {
    expect(backupAge(null, now)).toBe('No backup made from this app yet');
    expect(backupAge(ago(30_000), now)).toBe('Backed up just now');
    expect(backupAge(ago(3 * 3600_000), now)).toBe('Backed up 3 hours ago');
    expect(backupAge(ago(26 * 3600_000), now)).toBe('Backed up yesterday');
    expect(backupAge(ago(3 * 86400_000), now)).toBe('Backed up 3 days ago');
  });
  test('is stale after two weeks, or when there is none', () => {
    expect(backupIsStale(null, now)).toBe(true);
    expect(backupIsStale(ago(3 * 86400_000), now)).toBe(false);
    expect(backupIsStale(ago(20 * 86400_000), now)).toBe(true);
  });
});

test('every searchable setting lives in a chapter, once', () => {
  const chapters = new Set(SETTINGS_CHAPTERS.map((c) => c.id));
  const keys = SETTING_INDEX.map((s) => s.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of SETTING_INDEX) expect(chapters.has(entry.chapter)).toBe(true);
});
