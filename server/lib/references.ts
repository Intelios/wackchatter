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

import { updateWorldLinksRecoverable } from './characters.ts';
import { chatStore } from './chats.ts';
import { updatePersonaLorebookReferences } from './personas.ts';
import {
  getSettings,
  reassignCharacterDialogueColor,
  reassignGlobalLorebooks,
  removePersonaDialogueColor,
  saveSettings,
} from './settings.ts';

type Rollback = () => Promise<void> | void;

async function rollbackAll(rollbacks: Rollback[]): Promise<void> {
  const failures: unknown[] = [];
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Reference rollback failed.');
}

async function failAfterRollback(error: unknown, rollbacks: Rollback[]): Promise<never> {
  try {
    await rollbackAll(rollbacks);
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], 'Reference migration and rollback failed.');
  }
  throw error;
}

/** A character's file moved: keep its chats pointed at the new identity. */
export function cascadeCharacterRename(oldAvatar: string, newAvatar: string): Rollback {
  const current = getSettings();
  const updated = reassignCharacterDialogueColor(current, oldAvatar, newAvatar);
  if (updated) saveSettings({ dialogueColors: updated.dialogueColors });

  try {
    chatStore().reassignCharacter(oldAvatar, newAvatar);
  } catch (error) {
    if (updated) saveSettings({ dialogueColors: current.dialogueColors });
    throw error;
  }

  return () =>
    rollbackAll([
      ...(updated
        ? [
            () => {
              saveSettings({ dialogueColors: current.dialogueColors });
            },
          ]
        : []),
      () => {
        chatStore().reassignCharacter(newAvatar, oldAvatar);
      },
    ]);
}

/**
 * A character is gone: deliberately cascade its chats rather than orphan them. Orphaned
 * transcripts can never be reached again (nothing lists them), so removing them with the
 * card is the honest choice. Messages follow via ON DELETE CASCADE.
 */
export function cascadeCharacterDelete(avatar: string): void {
  const current = getSettings();
  const updated = reassignCharacterDialogueColor(current, avatar, null);
  if (updated) saveSettings({ dialogueColors: updated.dialogueColors });

  try {
    chatStore().deleteChatsForCharacter(avatar);
  } catch (error) {
    if (updated) saveSettings({ dialogueColors: current.dialogueColors });
    throw error;
  }
}

/** A persona is gone: remove its local-only dialogue colour preference. */
export function cascadePersonaDelete(personaId: string): Rollback {
  const current = getSettings();
  const updated = removePersonaDialogueColor(current, personaId);
  if (!updated) return () => {};

  saveSettings({ dialogueColors: updated.dialogueColors });
  return () => {
    saveSettings({ dialogueColors: current.dialogueColors });
  };
}

/** A lorebook's file moved: repoint personas, character-card links, and the global selection. */
export async function cascadeLorebookRename(oldId: string, newId: string): Promise<Rollback> {
  if (oldId === newId) return () => {};
  const rollbacks: Rollback[] = [];
  try {
    rollbacks.push(await updatePersonaLorebookReferences(oldId, newId));
    rollbacks.push(await updateWorldLinksRecoverable(oldId, newId));

    const current = getSettings();
    const updated = reassignGlobalLorebooks(current, oldId, newId);
    if (updated) {
      const original = [...(current.globalLorebooks as string[])];
      saveSettings({ globalLorebooks: updated.globalLorebooks });
      rollbacks.push(() => {
        saveSettings({ globalLorebooks: original });
      });
    }
  } catch (error) {
    return failAfterRollback(error, rollbacks);
  }

  return () => rollbackAll(rollbacks);
}

/** A lorebook is gone: clear every reference that pointed at it. */
export async function cascadeLorebookDelete(id: string): Promise<Rollback> {
  const rollbacks: Rollback[] = [];
  try {
    rollbacks.push(await updatePersonaLorebookReferences(id, null));
    rollbacks.push(await updateWorldLinksRecoverable(id, null));

    const current = getSettings();
    const updated = reassignGlobalLorebooks(current, id, null);
    if (updated) {
      const original = [...(current.globalLorebooks as string[])];
      saveSettings({ globalLorebooks: updated.globalLorebooks });
      rollbacks.push(() => {
        saveSettings({ globalLorebooks: original });
      });
    }
  } catch (error) {
    return failAfterRollback(error, rollbacks);
  }

  return () => rollbackAll(rollbacks);
}
