import { describe, expect, test } from 'bun:test';
import type { VersionInfo } from '../../lib/api.ts';
import { versionString } from './versionString.ts';

function info(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    version: '1.6.3',
    branch: 'dev',
    revision: 'abc1234',
    commitsBehind: null,
    ...overrides,
  };
}

describe('versionString', () => {
  test('branch and revision ride along when both exist', () => {
    expect(versionString(info())).toBe("WackChatter 1.6.3 'dev' (abc1234)");
  });

  test('a missing branch or revision leaves the bare version line', () => {
    expect(versionString(info({ branch: null, revision: null }))).toBe('WackChatter 1.6.3');
  });

  test('a behind count is appended, pluralised', () => {
    expect(versionString(info({ commitsBehind: 4 }))).toBe(
      "WackChatter 1.6.3 'dev' (abc1234) — 4 commits behind",
    );
    expect(versionString(info({ commitsBehind: 1 }))).toBe(
      "WackChatter 1.6.3 'dev' (abc1234) — 1 commit behind",
    );
  });

  test('zero and unknown render no suffix — there is nothing to say', () => {
    expect(versionString(info({ commitsBehind: 0 }))).toBe("WackChatter 1.6.3 'dev' (abc1234)");
    expect(versionString(info({ commitsBehind: null }))).toBe("WackChatter 1.6.3 'dev' (abc1234)");
  });
});
