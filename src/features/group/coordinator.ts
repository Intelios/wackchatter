/** Owns scheduling, not transcript text. Every callback is scoped to this coordinator. */
export interface GroupJob {
  id: string;
  memberId: string;
  exchange: number;
  controller: AbortController;
}
export interface CoordinatorOptions {
  limits(): { concurrency: number; replyLimit: number };
  eligible(): string[];
  select(
    pending: string[],
    eligible: string[],
    capacity: number,
    remaining: number,
    signal: AbortSignal,
  ): Promise<string[]>;
  /** Preparation is serialized; the returned function starts the independent stream. */
  prepare(job: GroupJob): Promise<() => Promise<void>>;
  changed(): void;
  error(message: string): void;
}
export class GroupCoordinator {
  readonly jobs = new Map<string, GroupJob>();
  running = false;
  selecting = false;
  exchange = 0;
  remaining = 0;
  private selection: AbortController | null = null;
  private preparation: Promise<void> = Promise.resolve();
  private disposed = false;
  private operations = new Set<Promise<void>>();
  constructor(private readonly o: CoordinatorOptions) {}

  start() {
    if (this.disposed) return;
    this.selection?.abort();
    this.selection = null;
    this.selecting = false;
    this.exchange++;
    this.remaining = this.o.limits().replyLimit;
    this.running = true;
    this.o.changed();
    void this.pump();
  }
  /** A send invalidates the pending selection before its async macro preparation. */
  invalidate() {
    this.pause();
    this.exchange++;
  }
  pause() {
    this.running = false;
    this.selection?.abort();
    this.selection = null;
    this.selecting = false;
    this.o.changed();
  }
  stop(id: string) {
    this.pause();
    this.jobs.get(id)?.controller.abort();
  }
  stopAll() {
    this.pause();
    for (const job of this.jobs.values()) job.controller.abort();
  }
  async drain() {
    this.stopAll();
    await Promise.allSettled([...this.operations]);
    await this.preparation;
  }
  async close() {
    this.disposed = true;
    await this.drain();
  }
  manual(memberId: string) {
    if (
      this.disposed ||
      this.jobs.size >= this.o.limits().concurrency ||
      !this.o.eligible().includes(memberId) ||
      [...this.jobs.values()].some((j) => j.memberId === memberId)
    )
      return;
    this.pause();
    this.launch(memberId, this.exchange);
  }
  /** Also serializes composer macros with request preparation. */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.preparation.then(work);
    this.preparation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async pump() {
    if (this.disposed || !this.running || this.selecting) return;
    if (this.remaining <= 0) {
      this.running = false;
      this.o.changed();
      return;
    }
    const pending = [...this.jobs.values()].map((j) => j.memberId);
    const eligible = this.o.eligible().filter((id) => !pending.includes(id));
    const capacity = Math.min(
      this.remaining,
      this.o.limits().concurrency - this.jobs.size,
      eligible.length,
    );
    if (capacity <= 0) {
      if (!this.jobs.size) this.pause();
      return;
    }
    const controller = new AbortController();
    const exchange = this.exchange;
    this.selection = controller;
    this.selecting = true;
    this.o.changed();
    try {
      const selected = await this.o.select(
        pending,
        eligible,
        capacity,
        this.remaining,
        controller.signal,
      );
      if (
        this.disposed ||
        controller.signal.aborted ||
        exchange !== this.exchange ||
        this.selection !== controller
      )
        return;
      if (
        selected.length > capacity ||
        new Set(selected).size !== selected.length ||
        selected.some((id) => !eligible.includes(id))
      )
        throw new Error('Invalid director selection.');
      if (!selected.length) this.running = false;
      for (const id of selected) {
        this.remaining--;
        this.launch(id, exchange);
      }
    } catch (error) {
      if (!controller.signal.aborted && this.selection === controller) {
        this.running = false;
        this.o.error((error as Error).message);
      }
    } finally {
      if (this.selection === controller) {
        this.selection = null;
        this.selecting = false;
        this.o.changed();
      }
    }
  }
  private launch(memberId: string, exchange: number) {
    const job: GroupJob = {
      id: crypto.randomUUID(),
      memberId,
      exchange,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.o.changed();
    const operation = (async () => {
      try {
        const run = await this.serialize(async () => {
          if (job.controller.signal.aborted || this.disposed || job.exchange !== this.exchange)
            return null;
          return this.o.prepare(job);
        });
        if (run) await run();
      } catch (error) {
        if (!job.controller.signal.aborted && !this.disposed) {
          this.pause();
          this.o.error((error as Error).message);
        }
      } finally {
        this.jobs.delete(job.id);
        this.o.changed();
        void this.pump();
      }
    })();
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation));
  }
}
