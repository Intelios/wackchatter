/**
 * Revision-aware client persistence.
 *
 * A queued save owns its complete snapshot. It never receives a state getter, which is
 * the boundary that prevents an A timer from saving B's transcript under A's id.
 */

import type { ChatSaveSnapshot } from '@shared/types/chat.ts';

export type ChatSaveTransport = (
  snapshot: ChatSaveSnapshot,
  options?: Pick<RequestInit, 'keepalive'>,
) => Promise<unknown>;

export interface ChatSaveQueueEvents {
  onSaved?(snapshot: ChatSaveSnapshot): void;
  onFailed?(chatId: string, error: Error): void;
  onPendingChange?(pending: boolean): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** A small per-chat queue; different chats may save independently, never out of order. */
export class ChatSaveQueue {
  private readonly latest = new Map<string, ChatSaveSnapshot>();
  private readonly saved = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly save: ChatSaveTransport,
    private readonly delayMs: number,
    private readonly events: ChatSaveQueueEvents = {},
  ) {}

  /** Record the revision received from the server when a chat is loaded. */
  adopt(chatId: string, revision: number): void {
    this.saved.set(chatId, Math.max(this.saved.get(chatId) ?? 0, revision));
    this.notify();
  }

  /** Debounce a new immutable revision, discarding only older unsent revisions. */
  schedule(snapshot: ChatSaveSnapshot): void {
    // Defend the boundary as well as the hook: callers can never mutate a queued save
    // after scheduling it.
    const owned = structuredClone(snapshot);
    const existing = this.latest.get(owned.chatId);
    if (existing && existing.revision >= owned.revision) return;
    this.latest.set(owned.chatId, owned);

    const previousTimer = this.timers.get(owned.chatId);
    if (previousTimer) clearTimeout(previousTimer);
    this.timers.set(
      owned.chatId,
      setTimeout(() => {
        this.timers.delete(owned.chatId);
        void this.flush(owned.chatId).catch(() => {
          // The failure has already been published to the hook. A later edit or Retry
          // owns the next attempt.
        });
      }, this.delayMs),
    );
    this.notify();
  }

  /** Save every dirty revision for one chat, including one that arrived mid-write. */
  async flush(chatId: string): Promise<void> {
    const timer = this.timers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(chatId);
    }

    while (this.isDirty(chatId)) {
      const current = this.running.get(chatId);
      if (current) {
        await current;
        continue;
      }
      await this.writeLatest(chatId);
    }
    this.notify();
  }

  /** Re-attempt the latest dirty revision, normally from the persistence error UI. */
  retry(chatId: string): Promise<void> {
    return this.flush(chatId);
  }

  /**
   * Start best-effort unload saves immediately. Server revisions make an older normal
   * request harmless if it completes after this keepalive request.
   */
  flushForPagehide(): void {
    for (const [chatId, snapshot] of this.latest) {
      if (!this.isDirty(chatId)) continue;
      void this.save(snapshot, { keepalive: true }).catch(() => {
        // Browsers cannot wait during pagehide. The next open will retain the local
        // transcript only if this request was accepted, so this is intentionally best effort.
      });
    }
  }

  private isDirty(chatId: string): boolean {
    const snapshot = this.latest.get(chatId);
    return Boolean(snapshot && snapshot.revision > (this.saved.get(chatId) ?? 0));
  }

  private async writeLatest(chatId: string): Promise<void> {
    const snapshot = this.latest.get(chatId);
    if (!snapshot || !this.isDirty(chatId)) return;

    const request = this.save(snapshot)
      .then(() => {
        this.saved.set(chatId, snapshot.revision);
        this.events.onSaved?.(snapshot);
      })
      .catch((error) => {
        const normalized = asError(error);
        this.events.onFailed?.(chatId, normalized);
        throw normalized;
      })
      .finally(() => {
        this.running.delete(chatId);
        this.notify();
      });

    this.running.set(chatId, request);
    this.notify();
    await request;
  }

  private notify(): void {
    this.events.onPendingChange?.(this.timers.size > 0 || this.running.size > 0);
  }
}
