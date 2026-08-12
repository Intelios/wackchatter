/**
 * A reusable, revision-aware autosave queue.
 *
 * Generalised from the chat save queue (`features/chat/chatPersistence.ts`) so every
 * editor — character, lorebook, persona, embedded book — shares one set of guarantees:
 *
 * - A scheduled save owns an immutable snapshot. Later edits cannot mutate it in flight.
 * - Only revisions newer than the queued one are accepted, so a stale callback is ignored.
 * - Writes for one entity are serialised; a slow older response can never land after a
 *   newer one, because the newer one does not start until the older one settles.
 * - Different entities save independently, so editing book B cannot cancel book A's write.
 * - A failed snapshot is retained for `retry`, never silently dropped.
 * - `flush` / `flushAll` drain pending work on controlled transitions (selection change,
 *   unmount), so an edit made moments before leaving is not lost to the debounce.
 */

export type AutosaveTransport<TSnapshot, TResult> = (
  entityId: string,
  snapshot: TSnapshot,
) => Promise<TResult>;

export interface AutosaveQueueEvents<TSnapshot, TResult> {
  onSaved?(entityId: string, snapshot: TSnapshot, result: TResult): void;
  onFailed?(entityId: string, error: Error): void;
  onPendingChange?(pending: boolean): void;
}

export interface PersistenceControls {
  flush: () => Promise<void>;
  retry: () => Promise<void>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface Queued<TSnapshot> {
  revision: number;
  snapshot: TSnapshot;
}

export class AutosaveQueue<TSnapshot, TResult = unknown> {
  private readonly latest = new Map<string, Queued<TSnapshot>>();
  private readonly saved = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-entity tails. A caller reserves its place before its first await. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly save: AutosaveTransport<TSnapshot, TResult>,
    private readonly delayMs: number,
    private readonly events: AutosaveQueueEvents<TSnapshot, TResult> = {},
  ) {}

  /** Record the revision an entity is known to be at, e.g. when it is first loaded. */
  adopt(entityId: string, revision: number): void {
    this.saved.set(entityId, Math.max(this.saved.get(entityId) ?? 0, revision));
    this.notify();
  }

  /**
   * The next revision that outranks everything queued or saved for this entity.
   *
   * The queue is the only object that knows its own high-water marks, so it hands them out
   * rather than trusting a caller to keep a counter in step. An editor that owned its
   * counter could restart it — a React effect re-running on a new prop identity, say — and
   * every later edit would then be silently rejected by `schedule` as stale, unsent and
   * invisible to `flush`.
   */
  nextRevision(entityId: string): number {
    return Math.max(this.latest.get(entityId)?.revision ?? 0, this.saved.get(entityId) ?? 0) + 1;
  }

  /** Debounce a new immutable revision, discarding only older unsent revisions. */
  schedule(entityId: string, revision: number, snapshot: TSnapshot): void {
    const owned = structuredClone(snapshot);
    const existing = this.latest.get(entityId);
    if (existing && existing.revision >= revision) return;
    this.latest.set(entityId, { revision, snapshot: owned });

    const previousTimer = this.timers.get(entityId);
    if (previousTimer) clearTimeout(previousTimer);
    this.timers.set(
      entityId,
      setTimeout(() => {
        this.timers.delete(entityId);
        void this.flush(entityId).catch(() => {
          // The failure was already published. A later edit or retry owns the next attempt.
        });
      }, this.delayMs),
    );
    this.notify();
  }

  /** Save every dirty revision for one entity, including one that arrived mid-write. */
  async flush(entityId: string): Promise<void> {
    const timer = this.timers.get(entityId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(entityId);
    }

    await this.withLock(entityId, async () => {
      while (this.isDirty(entityId)) await this.writeLatest(entityId);
    });
  }

  /** Flush every entity that has pending or in-flight work. */
  async flushAll(): Promise<void> {
    const ids = new Set<string>([
      ...this.timers.keys(),
      ...this.latest.keys(),
      ...this.tails.keys(),
    ]);
    const results = await Promise.allSettled([...ids].map((id) => this.flush(id)));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, 'One or more autosaves failed.');
  }

  /** Re-attempt the latest dirty revision, normally from an error surface. */
  retry(entityId: string): Promise<void> {
    return this.flush(entityId);
  }

  /**
   * Run a task serialized with this entity's saves.
   *
   * Pending saves are drained first, then the task holds the entity's in-flight slot, so
   * neither a queued save nor one that arrives mid-task can run concurrently with it. This
   * is what lets the embedded-book editor issue a structural read/modify/write (add, delete,
   * reorder) without racing a debounced entry save against the same card.
   */
  async runSerialized<R>(entityId: string, task: () => Promise<R>): Promise<R> {
    const timer = this.timers.get(entityId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(entityId);
    }

    return this.withLock(entityId, async () => {
      // The drain and task share one lock. A failed pending save aborts the structural
      // operation: deleting or renaming despite an unsaved edit would lose that edit.
      while (this.isDirty(entityId)) await this.writeLatest(entityId);
      return task();
    });
  }

  /** Drop all pending and recorded work for one entity, e.g. after it is deleted. */
  discard(entityId: string): void {
    const timer = this.timers.get(entityId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(entityId);
    }
    this.latest.delete(entityId);
    this.saved.delete(entityId);
    this.notify();
  }

  isDirty(entityId: string): boolean {
    const entry = this.latest.get(entityId);
    return Boolean(entry && entry.revision > (this.saved.get(entityId) ?? 0));
  }

  private async writeLatest(entityId: string): Promise<void> {
    const entry = this.latest.get(entityId);
    if (!entry || !this.isDirty(entityId)) return;

    try {
      const result = await this.save(entityId, entry.snapshot);
      this.saved.set(entityId, entry.revision);
      // A response for an older snapshot is useful for ordering, but must not update UI
      // or parent state after a newer local revision has already been accepted.
      if ((this.latest.get(entityId)?.revision ?? entry.revision) === entry.revision) {
        this.events.onSaved?.(entityId, entry.snapshot, result);
      }
    } catch (error) {
      const normalized = asError(error);
      this.events.onFailed?.(entityId, normalized);
      throw normalized;
    }
  }

  private async withLock<R>(entityId: string, task: () => Promise<R>): Promise<R> {
    const previous = this.tails.get(entityId) ?? Promise.resolve();
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => reservation);
    this.tails.set(entityId, tail);
    this.notify();

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(entityId) === tail) this.tails.delete(entityId);
      this.notify();
    }
  }

  private notify(): void {
    this.events.onPendingChange?.(this.timers.size > 0 || this.tails.size > 0);
  }
}
