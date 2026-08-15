/**
 * Chat backups — the trash bin deleted chats land in.
 *
 * Every deleted chat (singly, or as part of a character cascade) is serialized to a JSON
 * file in data/backups *before* its rows are removed, so a misclick on the trash button is
 * recoverable instead of permanent. Restoring is a move out of the bin: the chat is
 * recreated from the file — fresh id, revision 0, branch semantics — and the file is
 * removed, so a second restore has nothing to find.
 *
 * The file format is the chat wire format, the same shape GET /api/chats/:id returns.
 * Chats are ours and deliberately not portable, so there is no external format to honour
 * here — the same reason chat export uses it.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Chat, ChatBackupSummary } from '../../shared/types/chat.ts';
import type { ChatStore } from './chats.ts';
import { atomicWriteSync } from './fs.ts';
import { PATHS, safeJoin, sanitizeFilename } from './paths.ts';

/** How many backup files are kept, oldest dropped first. */
export const MAX_CHAT_BACKUPS = 100;

/** The filename stem, also the `backupId` the restore/delete endpoints take. */
function backupStem(chat: Chat): string {
  const title = sanitizeFilename(chat.title) ?? 'untitled';
  // The epoch-ms prefix keeps directory order chronological, so pruning is a plain slice.
  return `${Date.now()}__${title}__${chat.id}`;
}

function backupFileName(chat: Chat): string {
  return `${backupStem(chat)}.json`;
}

function listBackupFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

/** Minimal shape check so a corrupt or foreign file cannot become a chat. */
function parseBackup(raw: unknown): Chat | null {
  if (!raw || typeof raw !== 'object') return null;
  const chat = raw as Partial<Chat>;
  if (typeof chat.id !== 'string' || !chat.id) return null;
  if (typeof chat.characterId !== 'string' || !chat.characterId) return null;
  if (typeof chat.title !== 'string') return null;
  if (!Array.isArray(chat.messages)) return null;
  return chat as Chat;
}

function readBackupFile(file: string, dir: string): Chat | null {
  try {
    return parseBackup(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  } catch {
    // A corrupt backup is skipped, never fatal to the list or a restore elsewhere.
    return null;
  }
}

/**
 * Serialize a chat to the backup directory, then prune the oldest past the retention cap.
 *
 * Throws on failure on purpose: the caller is about to delete the chat's rows, and the
 * backup is the only way back — ST swallows backup errors, which is exactly the hole
 * this is filling.
 */
export function writeChatBackup(chat: Chat, dir: string = PATHS.backups): void {
  atomicWriteSync(join(dir, backupFileName(chat)), JSON.stringify(chat));

  const files = listBackupFiles(dir);
  const overflow = Math.max(0, files.length - MAX_CHAT_BACKUPS);
  for (const file of files.slice(0, overflow)) {
    unlinkSync(join(dir, file));
  }
}

export function listChatBackups(
  characterId?: string,
  dir: string = PATHS.backups,
): ChatBackupSummary[] {
  const summaries: ChatBackupSummary[] = [];
  // Newest first: the reversed lexicographic order, which the timestamp prefix makes
  // chronological. Newest-first matters because the list is a trash bin.
  for (const file of listBackupFiles(dir).reverse()) {
    const chat = readBackupFile(file, dir);
    if (!chat) continue;
    if (characterId && chat.characterId !== characterId) continue;
    const stem = file.slice(0, -'.json'.length);
    const deleted = Number(stem.split('__', 1)[0]);
    summaries.push({
      backupId: stem,
      chatId: chat.id,
      characterId: chat.characterId,
      title: chat.title,
      messageCount: chat.messages.length,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return summaries;
}

export function readChatBackup(backupId: string, dir: string = PATHS.backups): Chat | null {
  const path = safeJoin(dir, `${backupId}.json`);
  if (!path || !existsSync(path)) return null;
  return readBackupFile(`${backupId}.json`, dir);
}

/** Permanently empty a slot in the trash bin. */
export function deleteChatBackup(backupId: string, dir: string = PATHS.backups): boolean {
  const path = safeJoin(dir, `${backupId}.json`);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Permanently empty all slots in the trash bin, optionally filtered by character. */
export function deleteAllChatBackups(characterId?: string, dir: string = PATHS.backups): number {
  if (!existsSync(dir)) return 0;
  const files = listBackupFiles(dir);
  let count = 0;
  for (const file of files) {
    if (characterId) {
      const chat = readBackupFile(file, dir);
      if (!chat || chat.characterId !== characterId) continue;
    }
    const path = safeJoin(dir, file);
    if (!path || !existsSync(path)) continue;
    try {
      unlinkSync(path);
      count++;
    } catch {
      // Corrupt or locked files are skipped, never fatal to the batch.
    }
  }
  return count;
}

/**
 * Recreate a backed-up chat and remove the file, so restoring is a move out of the bin.
 *
 * The recreated chat is new — fresh id, revision 0, same content — which is what makes
 * a double restore impossible rather than a collision. Returns null when the backup is
 * gone or unreadable. The caller is responsible for confirming the character still
 * exists; a chat keyed on a deleted character is unreachable by design.
 */
export function restoreChatBackup(
  backupId: string,
  store: ChatStore,
  dir: string = PATHS.backups,
): Chat | null {
  const backup = readChatBackup(backupId, dir);
  if (!backup) return null;
  const chat = store.createChat({
    characterId: backup.characterId,
    title: backup.title,
    metadata: backup.metadata,
    messages: backup.messages,
  });
  deleteChatBackup(backupId, dir);
  return chat;
}

/**
 * Coerce a parsed chat export (or backup) into what createChat needs.
 *
 * Used by chat import: the file is our own export format, so the check only needs to
 * reject things that are not it. Returns null when the shape is wrong.
 */
export function parseChatExport(
  raw: unknown,
): Pick<Chat, 'title' | 'metadata' | 'messages'> | null {
  const chat = parseBackup(raw);
  if (!chat) return null;
  return {
    title: chat.title,
    metadata: chat.metadata,
    messages: chat.messages,
  };
}
