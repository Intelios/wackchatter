/**
 * The streaming hot path.
 *
 * A reply rewrites one message roughly thirty times a second while nothing else on
 * screen changes, so the text never enters React state at all. One leaf component
 * subscribes through useSyncExternalStore; everything above it renders on commits only.
 *
 * The accumulated text is always the full string, never a delta, so a consumer assigns
 * rather than appends and a dropped frame costs nothing.
 */

export interface StreamSnapshot {
  /** The FULL text so far. */
  text: string;
  reasoning: string;
  active: boolean;
}

export interface StreamStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamSnapshot;
  /** Begin a generation. `seed` is the existing text for `continue`, otherwise ''. */
  begin(seed: string): void;
  set(text: string, reasoning?: string): void;
  /** Flush synchronously and stop. Returns the final snapshot. */
  end(): StreamSnapshot;
}

const IDLE: StreamSnapshot = { text: '', reasoning: '', active: false };

export function createStreamStore(fps = 30): StreamStore {
  const interval = Math.max(1, Math.round(1000 / fps));

  const listeners = new Set<() => void>();
  // Cached: returning a fresh object from getSnapshot makes React loop forever.
  let snapshot: StreamSnapshot = IDLE;

  let pending: StreamSnapshot | null = null;
  let lastPublish = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit() {
    for (const listener of listeners) listener();
  }

  function publish(next: StreamSnapshot) {
    snapshot = next;
    pending = null;
    lastPublish = Date.now();
    emit();
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return snapshot;
    },

    begin(seed: string) {
      clearTimer();
      publish({ text: seed, reasoning: '', active: true });
      // Starting a stream is a state transition, not a content update, so it does not
      // open a throttle window. The first token then renders the moment it arrives —
      // time-to-first-token being the latency a reader actually notices.
      lastPublish = 0;
    },

    set(text: string, reasoning = '') {
      const next: StreamSnapshot = { text, reasoning, active: true };
      const elapsed = Date.now() - lastPublish;

      if (elapsed >= interval) {
        clearTimer();
        publish(next);
        return;
      }

      // Inside the throttle window. Hold the value and schedule the trailing edge —
      // dropping it would lose whatever arrived last before a pause.
      pending = next;
      timer ??= setTimeout(() => {
        timer = null;
        if (pending) publish(pending);
      }, interval - elapsed);
    },

    end() {
      clearTimer();
      // Flush synchronously. A final token that landed inside the throttle window would
      // otherwise never be shown.
      const final: StreamSnapshot = { ...(pending ?? snapshot), active: false };
      publish(final);
      return final;
    },
  };
}
