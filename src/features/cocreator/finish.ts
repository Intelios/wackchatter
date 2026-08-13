/**
 * Turning a stash into a real card.
 *
 * A client sequence over the existing character endpoints, deliberately — there is no
 * `POST /cocreator/:id/finish`. Putting the stash-to-card mapping on the server would move
 * card assembly into a server that otherwise never builds one.
 */

import { toCardPatch } from '@shared/cocreator/stash.ts';
import type { CardStash } from '@shared/types/cocreator.ts';
import { characterApi, cocreatorApi } from '../../lib/api.ts';

/** The folder new cards land in, so a design session's output is easy to find and move. */
export const FINISH_FOLDER = 'Drafts';

async function sessionAvatarFile(sessionId: string, cacheKey: number): Promise<File | null> {
  try {
    const response = await fetch(cocreatorApi.avatarUrl(sessionId, cacheKey));
    if (!response.ok) return null;
    return new File([await response.blob()], 'avatar.png', { type: 'image/png' });
  } catch {
    // Artwork is worth losing before the card is: a failed fetch finishes without it rather
    // than aborting a session's whole output.
    return null;
  }
}

/**
 * Create the card and apply the stash to it.
 *
 * `create` mints a tree-unique filename server-side, so two Finishes with the same name
 * cannot collide. The fields then go on in one PATCH — with the artwork in the same request
 * when there is any, so the card is never briefly on disk with fields but no art.
 *
 * Why this cannot break the shallow-merge rule: `toCardPatch` emits only flat strings and
 * two string arrays. It never emits `character_book` or `extensions`, and `updateCharacter`
 * re-reads the PNG and merges onto the parsed original, so unknown and V3 keys survive.
 */
export async function finishSession(input: {
  sessionId: string;
  stash: CardStash;
  avatar: string | null;
  cacheKey: number;
}): Promise<string> {
  const name = input.stash.name?.text.trim() || 'Untitled Character';
  const created = await characterApi.create(name, FINISH_FOLDER);

  const patch = toCardPatch(input.stash);
  const art = input.avatar ? await sessionAvatarFile(input.sessionId, input.cacheKey) : null;

  const saved = art
    ? await characterApi.updateWithImage(created.avatar, patch, art)
    : await characterApi.update(created.avatar, patch);

  return saved.avatar;
}
