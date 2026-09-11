import type { Database } from 'bun:sqlite';
import { NEXUS_DIMENSIONS, NEXUS_MODEL_FINGERPRINT } from '../../shared/nexus/model.ts';
import { migrateMemories } from '../../shared/nexus/state.ts';
import type { NexusEmbedding } from '../../shared/nexus/types.ts';
import type { MemoryMode } from '../../shared/types/settings.ts';
import type { createChatStore } from './chats.ts';

export function migrateNexusLibrary(
  db: Database,
  store: ReturnType<typeof createChatStore>,
  mode: MemoryMode,
): void {
  if (db.query('SELECT value FROM meta WHERE key = ?').get('nexus_migrated')) return;
  db.transaction(() => {
    for (const summary of store.listChats()) {
      const chat = store.getChat(summary.id)!;
      const metadata = {
        ...chat.metadata,
        memoryMode: chat.metadata.memoryMode ?? (mode === 'memories' ? 'nexus' : mode),
      };
      if (chat.metadata.memories?.length && !chat.metadata.nexus)
        metadata.nexus = migrateMemories(chat.metadata.memories, chat.messages);
      store.updateChatMeta(chat.id, { revision: chat.revision + 1, metadata });
    }
    db.query('INSERT INTO meta (key,value) VALUES (?,?)').run('nexus_migrated', '1');
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
