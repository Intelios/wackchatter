/**
 * The one library conversion 3.0 carries: 2.3 to 3.0.
 *
 * 2.3 rewrote everything older on first open, but a few values it only ever repaired as
 * they were read, so they can still sit on disk in their old form. 3.0 no longer reads those
 * forms, so this writes them out once:
 *
 *   - `memoryMode: 'memories'` (pre-Nexus) becomes `'nexus'`, in settings.json and per chat.
 *   - A chat with no frozen `memoryMode` gets the app default, as the 2.0 sweep would have.
 *   - A chat with no recorded `persona` gets the current one, and user messages with no
 *     recorded speaker get the chat's persona — what 2.x stamped when a chat was opened.
 *
 * Only direct chats are touched — the group scenes 3.0 removed stay exactly as 2.x left
 * them. Chats are rewritten in SQL without touching `modified`: a conversion is not the user
 * opening every chat, and recency drives the recents list and Stats. The revision moves, so
 * a tab holding a pre-conversion snapshot cannot write it back. One transaction, and the
 * marker is written inside it, so a crash leaves either all of it or none of it.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync } from './fs.ts';
import { PATHS } from './paths.ts';

const MARKER = 'library_version';
const VERSION = '3';

/** The parts of settings.json the conversion reads, taken raw: the cache normalises them. */
function readStoredSettings(): Record<string, unknown> | null {
  if (!existsSync(PATHS.settings)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PATHS.settings, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Convert the open library if it has not been converted yet. Returns whether settings.json
 * was rewritten, so the caller can drop a settings cache read before it.
 */
export function upgradeLibrary(database: Database): boolean {
  if (database.query('SELECT value FROM meta WHERE key = ?').get(MARKER)) return false;

  const stored = readStoredSettings();
  const settingsChanged = stored?.memoryMode === 'memories';
  const storedMode = settingsChanged ? 'nexus' : stored?.memoryMode;
  const defaultMode =
    storedMode === 'classic' || storedMode === 'nexus' || storedMode === 'off'
      ? storedMode
      : 'classic';
  const personaId = typeof stored?.personaId === 'string' ? stored.personaId : null;

  // Settings first, because the database marker is what stops a retry: written the other way
  // round, a failed settings write would be stranded behind a converted library. Rewriting
  // `nexus` over `nexus` on a retry is harmless.
  if (settingsChanged && stored) {
    atomicWriteSync(
      PATHS.settings,
      `${JSON.stringify({ ...stored, memoryMode: 'nexus' }, null, 2)}\n`,
    );
  }

  database.transaction(() => {
    // Malformed metadata (the JSON literal null, say) reads as {} everywhere else, so it is
    // converted as {} here rather than left for json_set to return NULL on.
    const object = "CASE WHEN json_type(metadata) = 'object' THEN metadata ELSE '{}' END";
    database
      .query(
        `UPDATE chats
            SET metadata = json_set(${object}, '$.memoryMode',
                  CASE WHEN json_extract(${object}, '$.memoryMode') = 'memories'
                       THEN 'nexus' ELSE ? END),
                revision = revision + 1, save_token = NULL
          WHERE kind = 'direct'
            AND (json_extract(${object}, '$.memoryMode') IS NULL
                 OR json_extract(${object}, '$.memoryMode') = 'memories')`,
      )
      .run(defaultMode);
    database
      .query(
        `UPDATE chats
            SET metadata = json_set(${object}, '$.persona', json(?)),
                revision = revision + 1, save_token = NULL
          WHERE kind = 'direct' AND json_type(${object}, '$.persona') IS NULL`,
      )
      .run(JSON.stringify(personaId));
    // The chat's persona is now always recorded; JSON null (no persona) becomes the empty
    // string the column uses for "sent with no persona".
    const stamped = database
      .query<{ chat_id: string }, []>(
        `UPDATE messages
            SET persona_id = COALESCE(
                  (SELECT json_extract(c.metadata, '$.persona') FROM chats c WHERE c.id = messages.chat_id),
                  '')
          WHERE is_user = 1 AND persona_id IS NULL
            AND chat_id IN (SELECT id FROM chats WHERE kind = 'direct')
          RETURNING chat_id`,
      )
      .all();
    const chatIds = [...new Set(stamped.map((row) => row.chat_id))];
    const bump = database.query(
      'UPDATE chats SET revision = revision + 1, save_token = NULL WHERE id = ?',
    );
    for (const id of chatIds) bump.run(id);

    database.query('INSERT INTO meta (key, value) VALUES (?, ?)').run(MARKER, VERSION);
  })();
  return settingsChanged;
}
