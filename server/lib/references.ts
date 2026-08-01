/**
 * Reference cascades for rename and delete.
 *
 * Filenames are identities here — a character's PNG filename and a lorebook's JSON stem are
 * what every other store keys on. Renaming or deleting one of those identities must therefore
 * ripple out to everything that refers to it, or the references go stale and silently break:
 * chats orphaned from a renamed character, a card linking a lorebook that no longer exists,
 * a global-lorebook selection pointing at nothing.
 *
 * Those ripples live in this one place rather than scattered across the route handlers, so
 * every referring store is updated together and the full set is testable as a unit. The
 * handlers stay thin: do the rename/delete, then call the matching cascade.
 */

import { updateWorldLinks } from './characters.ts';
import { chatStore } from './chats.ts';
import { updatePersonaLorebookReferences } from './personas.ts';
import { getSettings, reassignGlobalLorebooks, saveSettings } from './settings.ts';

/** A character's file moved: keep its chats pointed at the new identity. */
export function cascadeCharacterRename(oldAvatar: string, newAvatar: string): void {
  chatStore().reassignCharacter(oldAvatar, newAvatar);
}

/**
 * A character is gone: deliberately cascade its chats rather than orphan them. Orphaned
 * transcripts can never be reached again (nothing lists them), so removing them with the
 * card is the honest choice. Messages follow via ON DELETE CASCADE.
 */
export function cascadeCharacterDelete(avatar: string): void {
  chatStore().deleteChatsForCharacter(avatar);
}

/** A lorebook's file moved: repoint personas, character-card links, and the global selection. */
export async function cascadeLorebookRename(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  await updatePersonaLorebookReferences(oldId, newId);
  await updateWorldLinks(oldId, newId);

  const updated = reassignGlobalLorebooks(getSettings(), oldId, newId);
  if (updated) saveSettings({ globalLorebooks: updated.globalLorebooks });
}

/** A lorebook is gone: clear every reference that pointed at it. */
export async function cascadeLorebookDelete(id: string): Promise<void> {
  await updatePersonaLorebookReferences(id, null);
  await updateWorldLinks(id, null);

  const updated = reassignGlobalLorebooks(getSettings(), id, null);
  if (updated) saveSettings({ globalLorebooks: updated.globalLorebooks });
}
