import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countBehind, createBehindChecker, fetchUpstream, UPDATE_TTL_MS } from './updates.ts';

/*
 * Real git repositories, but built from local paths only — no network, no dependence on
 * this checkout's state. The -c flags and --no-verify keep the developer's own
 * gitconfig (signing, hooks, identity) out of the fixtures.
 */
const IDENTITY = [
  '-c',
  'user.email=test@wackchatter.local',
  '-c',
  'user.name=WackChatter Test',
  '-c',
  'commit.gpgsign=false',
];

function git(cwd: string, ...args: string[]): string {
  const child = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${child.stderr.toString()}`);
  }
  return child.stdout.toString().trim();
}

function commit(cwd: string, message: string): void {
  writeFileSync(join(cwd, `${message}.txt`), message);
  git(cwd, ...IDENTITY, 'add', '-A');
  git(cwd, ...IDENTITY, 'commit', '--no-verify', '-m', message);
}

let root: string;
let clone: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wc-updates-test-'));

  // origin advances after the clone, so the clone's tracking ref is stale until it fetches.
  const origin = join(root, 'origin');
  git(root, 'init', '-b', 'main', origin);
  commit(origin, 'one');
  git(root, 'clone', '--quiet', origin, 'work');
  clone = join(root, 'work');
  commit(origin, 'two');

  // A repo with commits but no remote, and a directory that is not a repo at all.
  const solo = join(root, 'solo');
  git(root, 'init', '-b', 'main', solo);
  commit(solo, 'only');
  mkdirSync(join(root, 'not-a-repo'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fetchUpstream / countBehind', () => {
  /*
   * The reason the fetch exists: rev-list reads the tracking ref, which only moves on a
   * fetch. Without this rule an install that only ever updates via update.sh would read
   * "0 behind" forever.
   */
  test('the count is stale until a fetch, honest after one', async () => {
    expect(await countBehind(clone)).toBe(0);
    expect(await fetchUpstream(clone)).toBe(true);
    expect(await countBehind(clone)).toBe(1);
  });

  test('a repo without an upstream and a non-repo both answer nothing', async () => {
    // git fetch exits 0 when no remote is configured — nothing to do, not an error. The
    // null comes from countBehind, and the coordinator checkpoints it (pinned below),
    // so a remoteless checkout never retries per request.
    expect(await fetchUpstream(join(root, 'solo'))).toBe(true);
    expect(await countBehind(join(root, 'solo'))).toBeNull();
    expect(await fetchUpstream(join(root, 'not-a-repo'))).toBe(false);
    expect(await countBehind(join(root, 'not-a-repo'))).toBeNull();
  });
});

function makeCheckerDeps() {
  let clock = 1_000;
  let fetchOk = true;
  let counted: number | null = 7;
  const calls = { fetches: 0, counts: 0 };
  const deps = {
    now: () => clock,
    fetch: async () => {
      calls.fetches += 1;
      return fetchOk;
    },
    count: async () => {
      calls.counts += 1;
      return counted;
    },
  };
  return {
    deps,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    failFetches: () => {
      fetchOk = false;
    },
    answerNothing: () => {
      counted = null;
    },
  };
}

describe('createBehindChecker', () => {
  test('the first refresh fetches, counts and records the answer', async () => {
    const { deps, calls } = makeCheckerDeps();
    const checker = createBehindChecker('/repo', deps);
    expect(checker.current()).toBeNull();
    await checker.maybeRefresh();
    expect(checker.current()).toEqual({ value: 7, checkedAt: 1_000 });
    expect(calls).toEqual({ fetches: 1, counts: 1 });
  });

  test('a check younger than the TTL is not re-run', async () => {
    const { deps, calls, advance } = makeCheckerDeps();
    const checker = createBehindChecker('/repo', deps);
    await checker.maybeRefresh();
    advance(UPDATE_TTL_MS - 1);
    await checker.maybeRefresh();
    expect(calls.fetches).toBe(1);
  });

  test('a check older than the TTL is refreshed', async () => {
    const { deps, calls, advance } = makeCheckerDeps();
    const checker = createBehindChecker('/repo', deps);
    await checker.maybeRefresh();
    advance(UPDATE_TTL_MS);
    await checker.maybeRefresh();
    expect(calls.fetches).toBe(2);
    expect(checker.current()).toEqual({ value: 7, checkedAt: 1_000 + UPDATE_TTL_MS });
  });

  test('a call while one is in flight joins it instead of starting a second fetch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = { fetches: 0, counts: 0 };
    const checker = createBehindChecker('/repo', {
      fetch: () => {
        calls.fetches += 1;
        return gate.then(() => true);
      },
      count: async () => {
        calls.counts += 1;
        return 3;
      },
    });
    const first = checker.maybeRefresh();
    const second = checker.maybeRefresh();
    expect(calls.fetches).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(checker.current()?.value).toBe(3);
  });

  test('a failed fetch keeps the previous answer and does not extend the TTL', async () => {
    const { deps, calls, advance, failFetches } = makeCheckerDeps();
    const checker = createBehindChecker('/repo', deps);
    await checker.maybeRefresh();
    failFetches();
    advance(UPDATE_TTL_MS);
    await checker.maybeRefresh();
    expect(checker.current()).toEqual({ value: 7, checkedAt: 1_000 });

    // Still stale, so the next request retries — an offline machine keeps trying.
    await checker.maybeRefresh();
    expect(calls.fetches).toBe(3);
  });

  test('a fetch that succeeds but cannot count still checkpoints, so it does not retry per request', async () => {
    const { deps, calls, advance, answerNothing } = makeCheckerDeps();
    const checker = createBehindChecker('/repo', deps);
    await checker.maybeRefresh();
    answerNothing();
    advance(UPDATE_TTL_MS);
    await checker.maybeRefresh();
    expect(checker.current()).toEqual({ value: null, checkedAt: 1_000 + UPDATE_TTL_MS });
    await checker.maybeRefresh();
    expect(calls.fetches).toBe(2);
  });
});
