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
import { failAfterRollback, type Rollback, rollbackAll } from './rollback.ts';
import {
  getSettings,
  reassignCharacterDialogueColor,
  reassignCharacterExampleSets,
  reassignCharacterRating,
  reassignGlobalLorebooks,
  removePersonaDialogueColor,
  saveSettings,
} from './settings.ts';

const WHAT = 'reference update';

/** A character's file moved: keep its chats pointed at the new identity. */
export function cascadeCharacterRename(oldAvatar: string, newAvatar: string): Rollback {
  const current = getSettings();
  const updatedColors = reassignCharacterDialogueColor(current, oldAvatar, newAvatar);
  if (updatedColors) saveSettings({ dialogueColors: updatedColors.dialogueColors });
  const updatedRatings = reassignCharacterRating(current, oldAvatar, newAvatar);
  if (updatedRatings) saveSettings({ characterRatings: updatedRatings.characterRatings });
  const updatedSets = reassignCharacterExampleSets(current, oldAvatar, newAvatar);
  if (updatedSets) saveSettings({ coCreator: updatedSets.coCreator });

  try {
    chatStore().reassignCharacter(oldAvatar, newAvatar);
  } catch (error) {
    if (updatedColors) saveSettings({ dialogueColors: current.dialogueColors });
    if (updatedRatings) saveSettings({ characterRatings: current.characterRatings });
    if (updatedSets) saveSettings({ coCreator: current.coCreator });
    throw error;
  }

  return () =>
    rollbackAll(
      [
        ...(updatedColors
          ? [
              () => {
                saveSettings({ dialogueColors: current.dialogueColors });
              },
            ]
          : []),
        ...(updatedRatings
          ? [
              () => {
                saveSettings({ characterRatings: current.characterRatings });
              },
            ]
          : []),
        ...(updatedSets
          ? [
              () => {
                saveSettings({ coCreator: current.coCreator });
              },
            ]
          : []),
        () => {
          chatStore().reassignCharacter(newAvatar, oldAvatar);
        },
      ],
      WHAT,
    );
}

/**
 * A character is gone: deliberately cascade its chats rather than orphan them. Orphaned
 * transcripts can never be reached again (nothing lists them), so removing them with the
 * card is the honest choice. Messages follow via ON DELETE CASCADE.
 */
export function cascadeCharacterDelete(avatar: string): void {
  const current = getSettings();
  const updatedColors = reassignCharacterDialogueColor(current, avatar, null);
  if (updatedColors) saveSettings({ dialogueColors: updatedColors.dialogueColors });
  const updatedRatings = reassignCharacterRating(current, avatar, null);
  if (updatedRatings) saveSettings({ characterRatings: updatedRatings.characterRatings });
  const updatedSets = reassignCharacterExampleSets(current, avatar, null);
  if (updatedSets) saveSettings({ coCreator: updatedSets.coCreator });

  try {
    chatStore().deleteChatsForCharacter(avatar);
  } catch (error) {
    if (updatedColors) saveSettings({ dialogueColors: current.dialogueColors });
    if (updatedRatings) saveSettings({ characterRatings: current.characterRatings });
    if (updatedSets) saveSettings({ coCreator: current.coCreator });
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
    return failAfterRollback(error, rollbacks, WHAT);
  }

  return () => rollbackAll(rollbacks, WHAT);
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
    return failAfterRollback(error, rollbacks, WHAT);
  }

  return () => rollbackAll(rollbacks, WHAT);
}
