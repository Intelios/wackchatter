/**
 * The live-request registry behind one engine's ownership discipline.
 *
 * A live `AbortController` is the ownership token, and membership is what makes a late
 * callback inert once its request has been superseded or its run cleared. Two different
 * endings, deliberately not the same call:
 *
 * - `abortAll` stops the requests and leaves them members. An aborted request still has
 *   to settle its column (`entry/aborted` carries whatever text arrived before the stop),
 *   so revoking on Stop would make the catch block give up early, strand the column at
 *   `streaming` and wedge the engine behind a run that can never settle.
 * - `revokeAll` stops them and ends their ownership. For requests whose log is gone —
 *   the log cleared, the hook unmounted — there is no column left to settle, and there
 *   is something left to corrupt: the stream stores are shared by column index, so a
 *   zombie's final publish would land in whatever run takes the log next. Aborting alone
 *   stops the provider traffic but not that last write; revoking makes every remaining
 *   callback inert, which is the only thing that does.
 */

export interface ControllerRegistry {
  /** Register a live request. A member until its own `finally` removes it. */
  add(controller: AbortController): void;
  /** Whether the request still owns its callbacks. */
  has(controller: AbortController): boolean;
  /** Take the request out. Only its own `finally` calls this. */
  remove(controller: AbortController): void;
  /** Stop every live request without touching anyone's ownership. */
  abortAll(): void;
  /**
   * Stop every live request and end its ownership. Nothing in the log survives this, so
   * no late callback from any of them may write again — not to state, and not to the
   * shared stream stores.
   */
  revokeAll(): void;
}

export function createControllerRegistry(): ControllerRegistry {
  const live = new Set<AbortController>();

  return {
    add(controller) {
      live.add(controller);
    },
    has(controller) {
      return live.has(controller);
    },
    remove(controller) {
      live.delete(controller);
    },
    abortAll() {
      // Copied first: an abort handler may reach back into the registry synchronously,
      // and mutating a set mid-iteration is its own kind of abort.
      for (const controller of [...live]) controller.abort();
    },
    revokeAll() {
      for (const controller of [...live]) controller.abort();
      live.clear();
    },
  };
}
