/**
 * Turning a stash into a real card.
 *
 * A client sequence over the existing character endpoints, deliberately — there is no
 * `POST /cocreator/:id/finish`. Putting the stash-to-card mapping on the server would move
 * card assembly into a server that otherwise never builds one.
 */

import { toCardPatch } from '@shared/cocreator/stash.ts';
import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import type { CardStash } from '@shared/types/cocreator.ts';
import { characterApi, cocreatorApi } from '../../lib/api.ts';
import { fetchPngFile } from '../../lib/imageFile.ts';

/** The folder new cards land in, so a design session's output is easy to find and move. */
export const FINISH_FOLDER = 'Drafts';

export type FinishPlan =
  | { kind: 'create'; name: string; patch: Partial<CardDataV2> }
  | { kind: 'update'; avatar: string; rename: string | null; patch: Partial<CardDataV2> };

/**
 * What Finish does with a stash. A session started from a card writes back to that card:
 * finishing means the design is done, so the card it began as becomes what it is now. A
 * new session, or one whose card has gone since, makes a new card.
 *
 * Only what the stash holds is written. Everything else on the card (its book, its
 * extensions, its portrait unless the session has one) stays as it was, because the update
 * merges onto the stored card rather than rebuilding it.
 */
export function finishPlan(stash: CardStash, seed: CharacterDetail | null): FinishPlan {
  const name = stash.name?.text.trim() || '';
  const patch = toCardPatch(stash);
  if (seed) {
    return {
      kind: 'update',
      avatar: seed.avatar,
      rename: name && name !== seed.card.data.name ? name : null,
      patch,
    };
  }
  return { kind: 'create', name: name || 'Untitled Character', patch };
}

/**
 * Carry out the plan, over the existing character endpoints.
 *
 * A new card is created first, so `create` can mint a tree-unique filename, then the fields
 * go on in one PATCH, with the artwork in the same request when there is any, so the card
 * is never briefly on disk with fields but no art. An update renames first (the filename is
 * the card's identity and follows its name), then patches the card under its new name.
 */
export async function finishSession(input: {
  sessionId: string;
  stash: CardStash;
  avatar: string | null;
  cacheKey: number;
  seedAvatar: string | null;
}): Promise<string> {
  // The seed is read fresh at Finish time. A card deleted since degrades to a new card
  // rather than failing: the stash still holds every field the conversation produced.
  let seed: CharacterDetail | null = null;
  if (input.seedAvatar) {
    try {
      seed = await characterApi.get(input.seedAvatar);
    } catch {
      seed = null;
    }
  }
  const plan = finishPlan(input.stash, seed);

  const art = input.avatar
    ? await fetchPngFile(cocreatorApi.avatarUrl(input.sessionId, input.cacheKey))
    : null;

  let target: string;
  if (plan.kind === 'update') {
    target = plan.rename
      ? (await characterApi.rename(plan.avatar, plan.rename)).avatar
      : plan.avatar;
  } else {
    target = (await characterApi.create(plan.name, FINISH_FOLDER)).avatar;
  }
  const saved = art
    ? await characterApi.updateWithImage(target, plan.patch, art)
    : await characterApi.update(target, plan.patch);
  return saved.avatar;
}
