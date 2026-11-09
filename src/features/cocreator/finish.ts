/** Card assembly and conflict decisions belong to the client; the server only writes files. */
import {
  compareDraft,
  type DraftChoices,
  type DraftConflict,
  projectDraft,
} from '@shared/cocreator/draft.ts';
import type { CardDataV2, TavernCard, VersionedCharacter } from '@shared/types/card.ts';
import type { CardStash, CocreatorCardBaseline } from '@shared/types/cocreator.ts';
import { characterApi, cocreatorApi } from '../../lib/api.ts';

export const FINISH_FOLDER = 'Drafts';
export interface FinishInput {
  mode: 'create' | 'update';
  stash: CardStash;
  baseline: CocreatorCardBaseline | null;
  portraitChanged: boolean;
  review?: { version: string; choices: DraftChoices };
}
export type FinishPlan =
  | { kind: 'create'; card: TavernCard }
  | {
      kind: 'update';
      latest: VersionedCharacter;
      patch: Partial<CardDataV2>;
      name?: string;
      replacePortrait: boolean;
    };

export class FinishConflictError extends Error {
  constructor(
    readonly latest: VersionedCharacter,
    readonly conflicts: DraftConflict[],
    readonly portrait: boolean,
  ) {
    super('The character changed elsewhere. Compare the conflicting fields before updating.');
  }
}

/** A successful file write is retained until its session recording also succeeds. */
export class FinishAttempt {
  readonly publicationId = crypto.randomUUID();
  result: VersionedCharacter | null = null;
  recorded = false;
  async run(
    write: () => Promise<VersionedCharacter>,
    record: (saved: VersionedCharacter, publicationId: string) => Promise<void>,
  ): Promise<string> {
    this.result ??= await write();
    await record(this.result, this.publicationId);
    this.recorded = true;
    return this.result.detail.avatar;
  }
}

export function finishPlan(
  input: FinishInput,
  latest: VersionedCharacter | null = null,
): FinishPlan {
  const draft = projectDraft(input.stash, input.baseline?.card ?? null);
  if (input.mode === 'create') return { kind: 'create', card: draft };
  if (!latest)
    throw new Error(
      'The character is no longer in the library. You can create a new character from this draft.',
    );
  const choices = input.review?.version === latest.version ? input.review.choices : {};
  const comparison = compareDraft(
    input.baseline?.legacy ? null : (input.baseline?.card ?? null),
    latest.detail.card,
    draft,
    choices,
  );
  const portraitConflict =
    input.portraitChanged &&
    latest.portraitVersion !== input.baseline?.portraitVersion &&
    !choices.portrait;
  if (comparison.conflicts.length || portraitConflict)
    throw new FinishConflictError(latest, comparison.conflicts, portraitConflict);
  const name = comparison.patch.name;
  delete comparison.patch.name;
  return {
    kind: 'update',
    latest,
    patch: comparison.patch,
    ...(name ? { name } : {}),
    replacePortrait: input.portraitChanged && choices.portrait !== 'library',
  };
}

/** Artwork failures must not silently strip a full-card copy of its inherited portrait. */
export async function requiredPortrait(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error('Could not read the portrait. Your draft is saved; retry finishing.');
  return new File([await response.blob()], 'avatar.png', { type: 'image/png' });
}

export async function finishSession(
  input: FinishInput & { sessionId: string; avatar: string | null; cacheKey: number },
): Promise<VersionedCharacter> {
  // Resolve the server-owned reference again: a rename or deletion can happen while the
  // workspace is open. Never fall back from a missing output copy to its original source.
  const session = input.mode === 'update' ? await cocreatorApi.get(input.sessionId) : null;
  const latest = session?.targetAvatar
    ? await characterApi.getVersioned(session.targetAvatar)
    : null;
  const plan = finishPlan(input, latest);
  const needArt = plan.kind === 'create' || plan.replacePortrait;
  const art =
    needArt && input.avatar
      ? await requiredPortrait(cocreatorApi.avatarUrl(input.sessionId, input.cacheKey))
      : null;
  if (plan.kind === 'create') return characterApi.createComplete(plan.card, FINISH_FOLDER, art);
  return characterApi.saveVersioned(
    plan.latest.detail.avatar,
    plan.patch,
    plan.latest.version,
    plan.replacePortrait ? art : undefined,
    plan.name,
  );
}
