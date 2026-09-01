/**
 * The "commits behind" half of the version line.
 *
 * `git rev-list --count HEAD..@{u}` reads the remote-tracking ref, and that ref only
 * moves when something fetches — on an install that only ever runs update.sh it is as
 * fresh as the last update, so a bare count would read "up to date" for weeks. The
 * check therefore fetches first, from whatever remote the branch tracks (update.sh's
 * rule: naming it beats guessing origin/main, which is wrong for anyone following a
 * different branch), then counts.
 *
 * Both steps are background work behind a TTL: /api/version answers instantly with the
 * last known number, and `null` until the first check lands. Neither function ever
 * throws — a missing git, a non-clone install or a dead network all read as "no answer",
 * which renders as no indicator at all.
 */

/** Matches the staleness precedent in generate.ts: long enough not to chatter, short enough to notice an update the same session. */
export const UPDATE_TTL_MS = 10 * 60 * 1000;

/** A fetch can hang on a dead network; the indicator is a hint, never worth waiting for. */
export const FETCH_TIMEOUT_MS = 5_000;

export interface BehindState {
  /** `null` means "checked, no answer" — detached HEAD, no upstream, not a clone. */
  value: number | null;
  checkedAt: number;
}

export async function fetchUpstream(cwd: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<boolean> {
  try {
    const child = Bun.spawn(['git', 'fetch', '--quiet'], {
      cwd,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
    return child.exitCode === 0 && !timedOut;
  } catch {
    return false;
  }
}

export async function countBehind(cwd: string): Promise<number | null> {
  try {
    const child = Bun.spawn(['git', 'rev-list', '--count', 'HEAD..@{u}'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    await child.exited;
    if (child.exitCode !== 0) return null;
    const count = Number.parseInt((await new Response(child.stdout).text()).trim(), 10);
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export interface BehindChecker {
  /** What /api/version should serve right now; `null` before the first completed check. */
  current(): BehindState | null;
  /**
   * Run a fetch + count when the cached state is missing or older than the TTL. The
   * returned promise is the in-flight (or already-settled no-op) task so a caller that
   * wants to wait can; the route does not.
   */
  maybeRefresh(): Promise<void>;
}

interface CheckerDeps {
  now?: () => number;
  fetch?: (cwd: string) => Promise<boolean>;
  count?: (cwd: string) => Promise<number | null>;
}

export function createBehindChecker(cwd: string, deps: CheckerDeps = {}): BehindChecker {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetchUpstream;
  const doCount = deps.count ?? countBehind;

  let state: BehindState | null = null;
  let refresh: Promise<void> | null = null;

  return {
    current: () => state,
    maybeRefresh() {
      if (refresh) return refresh;
      if (state && now() - state.checkedAt < UPDATE_TTL_MS) return Promise.resolve();

      refresh = (async () => {
        try {
          /*
           * A failed fetch leaves state untouched, checkedAt included: while offline every
           * request retries (the 5s timeout and single-flight keep that cheap), and a
           * number learned earlier stays on screen — it was true at the last check, which
           * is all the indicator ever claims. A fetch that succeeds but yields no count
           * still sets checkedAt, or a checkout with no upstream would re-fetch per request.
           */
          if (await doFetch(cwd)) {
            state = { value: await doCount(cwd), checkedAt: now() };
          }
        } catch {
          // Neither step throws on its own; an injected double might. Silence, not error.
        } finally {
          refresh = null;
        }
      })();
      return refresh;
    },
  };
}
