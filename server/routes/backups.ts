/** Backup CRUD — the trash bin deleted chats land in. */

import {
  deleteChatBackup,
  listChatBackups,
  readChatBackup,
  restoreChatBackup,
} from '../lib/backups.ts';
import { getCharacter } from '../lib/characters.ts';
import { chatStore } from '../lib/chats.ts';
import { errorResponse, json, notFound } from '../lib/http.ts';

export async function handleBackupRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const method = request.method;

  // /api/backups?character=<avatar>
  if (segments.length === 0 && method === 'GET') {
    const character = new URL(request.url).searchParams.get('character');
    return json(listChatBackups(character ?? undefined));
  }

  if (segments.length === 0) return null;
  const backupId = decodeURIComponent(segments[0]!);

  // /api/backups/:id/restore
  if (segments[1] === 'restore' && method === 'POST') {
    const backup = readChatBackup(backupId);
    if (!backup) return notFound('Backup not found.');
    // A chat keys on its character's avatar filename; restored for a card that no longer
    // exists it would be unreachable — nothing lists chats for a character that is gone.
    if (!getCharacter(backup.characterId)) {
      return errorResponse(
        `The character "${backup.characterId}" no longer exists. Re-import it, then restore again.`,
        409,
      );
    }
    const restored = restoreChatBackup(backupId, chatStore());
    return restored ? json(restored, { status: 201 }) : notFound('Backup not found.');
  }

  // /api/backups/:id
  if (segments.length === 1 && method === 'DELETE') {
    return deleteChatBackup(backupId) ? json({ ok: true }) : notFound('Backup not found.');
  }

  return null;
}
