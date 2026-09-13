import type { Database } from 'bun:sqlite';
import { NEXUS_DIMENSIONS, NEXUS_MODEL_FINGERPRINT } from '../../shared/nexus/model.ts';
import { migrateMemories } from '../../shared/nexus/state.ts';
import type { NexusEmbedding } from '../../shared/nexus/types.ts';
import type { MemoryMode } from '../../shared/types/settings.ts';
import type { createChatStore } from './chats.ts';

/**
 * Freeze every chat's memory mode once, on the first 2.0 boot.
 *
 * This runs before the first request is served, so it has two obligations beyond doing
 * its job. It must not touch recency — a migration is not the user opening every chat —
 * and it must not be able to stop the server from starting.
 *
 * `migrateChatMeta` is what keeps the first promise: it writes metadata and bumps the
 * revision without restamping `modified`, so the recents list, the per-character picker
 * and Stats' "last spoke" still reflect what the user actually did. `updateChatMeta`
 * would have been the wrong door — it stamps `modified` with `Date.now()` for each chat,
 * so a library of `n` chats comes back dated to the boot moment in loop order, which
 * reorders the whole library by whichever chat the loop happened to visit last.
 *
 * The second promise is why each chat is its own savepoint. Bun maps a nested transaction
 * onto SQLite's, so a throw inside one rolls back that chat alone; the caller catches it,
 * reports it and carries on to the next. One malformed row costs its own migration, not
 * the boot.
 *
 * The marker is the statement "every chat has been frozen", so it is only written when
 * that is true: if any chat failed, the next start runs the sweep again. That is cheap
 * rather than wasteful — a chat already carrying its mode needs no write — and it is the
 * only way a chat that failed for a fixable reason (an invalid group scene the user later
 * repairs) is ever migrated. A chat that never succeeds simply keeps following the app
 * default, which is exactly the pre-2.0 behaviour, so nothing regresses meanwhile.
 *
 * A chat with nothing to change is not written at all. That is the common case on a
 * library from before the memory system existed, and skipping it keeps a no-op boot from
 * being a full rewrite of every metadata blob.
 */
export function migrateNexusLibrary(
  db: Database,
  store: ReturnType<typeof createChatStore>,
  mode: MemoryMode,
): void {
  if (db.query('SELECT value FROM meta WHERE key = ?').get('nexus_migrated')) return;
  const applied = mode === 'memories' ? 'nexus' : mode;
  let failed = false;

  db.transaction(() => {
    for (const chat of store.listChatMetas()) {
      const memoryMode = chat.metadata.memoryMode ?? applied;
      const legacy = chat.metadata.memories;
      const needsMemories = Boolean(legacy?.length) && !chat.metadata.nexus;
      if (chat.metadata.memoryMode === memoryMode && !needsMemories) continue;

      // Its own transaction: a row this chat cannot migrate must not take the sweep with
      // it, and must not stop the server from starting.
      try {
        db.transaction(() => {
          const metadata = { ...chat.metadata, memoryMode };
          // migrateMemories needs the transcript, so this is the one branch that reads
          // one — and only for the chats actually carrying legacy memories.
          if (needsMemories && legacy) {
            const full = store.getChat(chat.id);
            if (!full) throw new Error('vanished mid-migration');
            metadata.nexus = migrateMemories(legacy, full.messages);
          }
          store.migrateChatMeta(chat.id, metadata);
        })();
      } catch (error) {
        failed = true;
        console.error(
          `[wackchatter] Could not migrate chat ${chat.id} to ${memoryMode}; retrying on the next start:`,
          error,
        );
      }
    }
    if (!failed) db.query('INSERT INTO meta (key,value) VALUES (?,?)').run('nexus_migrated', '1');
  })();
}
export function readNexusIndex(db: Database, chatId: string): NexusEmbedding[] {
  return db
    .query<{ document_id: string; fingerprint: string; vector: Uint8Array }, [string, string]>(
      'SELECT document_id, fingerprint, vector FROM nexus_embeddings WHERE chat_id = ? AND model = ?',
    )
    .all(chatId, NEXUS_MODEL_FINGERPRINT)
    .map((r) => ({
      documentId: r.document_id,
      fingerprint: r.fingerprint,
      vector: Array.from(
        new Float32Array(
          r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength),
        ),
      ),
    }));
}
export function validEmbedding(e: unknown): e is NexusEmbedding {
  if (!e || typeof e !== 'object') return false;
  const v = e as NexusEmbedding;
  return (
    typeof v.documentId === 'string' &&
    v.documentId.length < 250 &&
    typeof v.fingerprint === 'string' &&
    v.fingerprint.length < 100 &&
    Array.isArray(v.vector) &&
    v.vector.length === NEXUS_DIMENSIONS &&
    v.vector.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1.01)
  );
}
export function writeNexusIndex(db: Database, chatId: string, entries: NexusEmbedding[]): void {
  const put = db.query(
    'INSERT OR REPLACE INTO nexus_embeddings (chat_id,document_id,model,fingerprint,vector) VALUES (?,?,?,?,?)',
  );
  db.transaction(() => {
    for (const e of entries)
      put.run(
        chatId,
        e.documentId,
        NEXUS_MODEL_FINGERPRINT,
        e.fingerprint,
        new Uint8Array(new Float32Array(e.vector).buffer),
      );
  })();
}
