/**
 * Turning a stash into a real card.
 *
 * A client sequence over the existing character endpoints, deliberately — there is no
 * `POST /cocreator/:id/finish`. Putting the stash-to-card mapping on the server would move
 * card assembly into a server that otherwise never builds one.
 */

import { toCardPatch } from '@shared/cocreator/stash.ts';
import type { CardDataV2, CharacterDetail, TavernCard } from '@shared/types/card.ts';
import type { CardStash } from '@shared/types/cocreator.ts';
import { characterApi, cocreatorApi } from '../../lib/api.ts';
import { fetchPngFile } from '../../lib/imageFile.ts';

/** The folder new cards land in, so a design session's output is easy to find and move. */
export const FINISH_FOLDER = 'Drafts';

/**
 * What a seeded session carries over from its seed card at Finish: everything the stash
 * cannot hold, so the variant is the whole character and not just the fields the design
 * conversation touched.
 *
 * The set is deliberately disjoint from `toCardPatch`'s — a slot the user cleared in the
 * stash must stay cleared, so no stash slot ever appears here. `fav` is reset rather than
 * copied: a favourite is a judgment about one card, and a variant starts unfaved, the same
 * deal `duplicateCard` gives.
 */
export function seedCarryOver(card: TavernCard): Partial<CardDataV2> {
  const data = card.data;
  const carry: Partial<CardDataV2> = {};

  if (data.character_book) carry.character_book = data.character_book;
  if (Object.keys(data.extensions).length > 0) {
    carry.extensions = { ...data.extensions, fav: false };
  }
  if (data.creator.trim()) carry.creator = data.creator;
  if (data.character_version.trim()) carry.character_version = data.character_version;
  if (data.nickname?.trim()) carry.nickname = data.nickname;
  if (data.source?.length) carry.source = [...data.source];
  if (data.group_only_greetings?.length) {
    carry.group_only_greetings = [...data.group_only_greetings];
  }

  return carry;
}

/**
 * Create the card and apply the stash to it.
 * `create` mints a tree-unique filename server-side, so two Finishes with the same name
 * cannot collide. The fields then go on in one PATCH — with the artwork in the same request
 * when there is any, so the card is never briefly on disk with fields but no art.
 *
 * Why this cannot break the shallow-merge rule: `toCardPatch` emits only flat strings and
 * two string arrays, and the seed carry-over writes onto a card created moments ago in this
 * same flow, from a fresh read — there is no established card whose book a wholesale
 * `character_book` replace could clobber, which is the stale-tab hazard that rule exists
 * for. `updateCharacter` still re-reads the PNG and merges onto the parsed original, so
 * unknown and V3 keys survive.
 */
export async function finishSession(input: {
  sessionId: string;
  stash: CardStash;
  avatar: string | null;
  cacheKey: number;
  seedAvatar: string | null;
}): Promise<string> {
  const name = input.stash.name?.text.trim() || 'Untitled Character';

  // The seed reference is read fresh at Finish time. A card that was deleted or renamed
  // away degrades to a flat finish rather than failing — the stash still holds every field
  // the conversation produced, which is the same bargain artwork makes below.
  let seed: CharacterDetail | null = null;
  if (input.seedAvatar) {
    try {
      seed = await characterApi.get(input.seedAvatar);
    } catch {
      seed = null;
    }
  }

  const created = await characterApi.create(name, FINISH_FOLDER);
  const patch = { ...(seed ? seedCarryOver(seed.card) : {}), ...toCardPatch(input.stash) };

  let art: File | null = null;
  if (input.avatar) {
    art = await fetchPngFile(cocreatorApi.avatarUrl(input.sessionId, input.cacheKey));
  }
  if (!art && seed && input.seedAvatar) {
    // A variant of a card the user likes should not land artless just because this session
    // never made artwork of its own.
    art = await fetchPngFile(characterApi.imageUrl(input.seedAvatar, seed.modified));
  }

  const saved = art
    ? await characterApi.updateWithImage(created.avatar, patch, art)
    : await characterApi.update(created.avatar, patch);

  return saved.avatar;
}
