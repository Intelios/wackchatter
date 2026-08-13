/**
 * Revision-aware client persistence, for any entity saved as a whole document.
 *
 * A queued save owns its complete snapshot. It never receives a state getter, which is the
 * boundary that prevents an A timer from saving B's transcript under A's id.
 *
 * Extracted from the chat's own queue when the Co-Creator needed the same guarantees. Two
 * copies would have been the worse option by some distance: every rule here is subtle, none
 * of them is visible when broken, and a drift between the two would show up as a lost edit
 * in one screen and not the other.
 *
 * The guarantees, all covered by `src/features/chat/chatPersistence.test.ts`:
 *  - a scheduled snapshot is immutable — callers cannot mutate a queued save afterwards;
 *  - only *older unsent* revisions are discarded, never a newer one;
 *  - writes for one entity are serialised, so revisions land in order;
 *  - a failure retains the dirty snapshot for a later edit or an explicit retry;
 *  - `flush` drains revisions that arrive mid-write, not just the one it started with.
 */

export type RevisionSaveTransport<TSnapshot> = (
  snapshot: TSnapshot,
  options?: Pick<RequestInit, 'keepalive'>,
) => Promise<unknown>;

export interface RevisionSaveQueueEvents<TSnapshot> {
  onSaved?(snapshot: TSnapshot): void;
  onFailed?(key: string, error: Error): void;
  onPendingChange?(pending: boolean): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A small per-entity queue; different entities may save independently, never out of order. */
export class RevisionSaveQueue<TSnapshot extends { revision: number }> {
  private readonly latest = new Map<string, TSnapshot>();
  private readonly saved = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly save: RevisionSaveTransport<TSnapshot>,
    private readonly delayMs: number,
    /** Which entity a snapshot belongs to. */
    private readonly keyOf: (snapshot: TSnapshot) => string,
    private readonly events: RevisionSaveQueueEvents<TSnapshot> = {},
  ) {}

  /** Record the revision received from the server when an entity is loaded. */
  adopt(key: string, revision: number): void {
    this.saved.set(key, Math.max(this.saved.get(key) ?? 0, revision));
    this.notify();
  }

  /** Debounce a new immutable revision, discarding only older unsent revisions. */
  schedule(snapshot: TSnapshot): void {
    // Defend the boundary as well as the hook: callers can never mutate a queued save
    // after scheduling it.
    const owned = structuredClone(snapshot);
    const key = this.keyOf(owned);
    const existing = this.latest.get(key);
    if (existing && existing.revision >= owned.revision) return;
    this.latest.set(key, owned);

    const previousTimer = this.timers.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.flush(key).catch(() => {
          // The failure has already been published to the hook. A later edit or Retry
          // owns the next attempt.
        });
      }, this.delayMs),
    );
    this.notify();
  }

  /** Save every dirty revision for one entity, including one that arrived mid-write. */
  async flush(key: string): Promise<void> {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    while (this.isDirty(key)) {
      const current = this.running.get(key);
      if (current) {
        await current;
        continue;
      }
      await this.writeLatest(key);
    }
    this.notify();
  }

  /** Re-attempt the latest dirty revision, normally from the persistence error UI. */
  retry(key: string): Promise<void> {
    return this.flush(key);
  }

  /**
   * Start best-effort unload saves immediately. Server revisions make an older normal
   * request harmless if it completes after this keepalive request.
   */
  flushForPagehide(): void {
    for (const [key, snapshot] of this.latest) {
      if (!this.isDirty(key)) continue;
      void this.save(snapshot, { keepalive: true }).catch(() => {
        // Browsers cannot wait during pagehide. The next open will retain the local
        // document only if this request was accepted, so this is intentionally best effort.
      });
    }
  }

  private isDirty(key: string): boolean {
    const snapshot = this.latest.get(key);
    return Boolean(snapshot && snapshot.revision > (this.saved.get(key) ?? 0));
  }

  private async writeLatest(key: string): Promise<void> {
    const snapshot = this.latest.get(key);
    if (!snapshot || !this.isDirty(key)) return;

    const request = this.save(snapshot)
      .then(() => {
        this.saved.set(key, snapshot.revision);
        this.events.onSaved?.(snapshot);
      })
      .catch((error) => {
        const normalized = asError(error);
        this.events.onFailed?.(key, normalized);
        throw normalized;
      })
      .finally(() => {
        this.running.delete(key);
        this.notify();
      });

    this.running.set(key, request);
    this.notify();
    await request;
  }

  private notify(): void {
    this.events.onPendingChange?.(this.timers.size > 0 || this.running.size > 0);
  }
}
