/**
 * Model Arena types.
 *
 * The Arena is a test bench, not a chat: one *scene* — a character card, its `first_mes`
 * as the opening, and a probe line standing in for the user's turn — is sent to several
 * endpoints at once, and nothing any of them writes is ever fed back in. Every comparison
 * starts from the same scene, which is the only reason the results mean anything.
 *
 * Ours entirely. Nothing here has a SillyTavern counterpart, so there is no external
 * format to honour — only the shape that keeps a rating from drifting away from the
 * rounds it summarises.
 */

/**
 * One entrant: an endpoint plus the model to run on it.
 *
 * A contender is deliberately **not** a connection. `Connection.model` is a single string,
 * so a pool of connections would cap the benchmark at one model per endpoint — where one
 * OpenRouter connection can serve a dozen. The Co-Creator already solved this with
 * `SessionModelSettings.modelOverride`; this is the same idea given a name and a rating.
 *
 * The persona rule: `id` is opaque and `name` is editable. Rounds key on the id, so
 * renaming an entrant cannot orphan its history.
 */
export interface Contender {
  id: string;
  name: string;
  connectionId: string;
  /** Empty follows the connection's own model, so the simple case needs no duplication. */
  model: string;
  /** In the blind draw. The Arena may still pick a disabled contender by hand. */
  enabled: boolean;
}

/**
 * A user turn a blind round can draw. Macros are legal — the probe rides assembly's
 * substitution like any other message, so `{{char}}` and `{{user}}` resolve per card.
 */
export interface ArenaProbe {
  id: string;
  text: string;
}

/**
 * What the user decided.
 *
 * `bad` is "neither of these is worth using", which is NOT `tie`. A tie says the two are
 * equal; `bad` says both failed, possibly for unrelated reasons, and scoring that as a
 * draw would drag a strong rating toward a weak one. See `replayRatings`.
 */
export type Verdict = 'left' | 'right' | 'tie' | 'bad';

/** One entrant's half of a round, as it actually ran. */
export interface RoundSide {
  /** Resolved against the settings pool for a name; may no longer exist. */
  contenderId: string;
  /**
   * The model and provider that actually served this reply — facts about the generation,
   * not display names. They are what a deleted contender's history falls back to, the same
   * way Stats renders an unrecognised `extra.api` verbatim rather than dropping the row.
   */
  model: string;
  provider: string;
  text: string;
}

/**
 * A completed blind round. Written once, never edited: an abandoned round is simply never
 * recorded, so there is no draft state to arbitrate and no revision to carry.
 */
export interface ArenaRound {
  id: string;
  created: number;
  /** The card's PNG filename — the same identity chats and ratings key on. */
  characterId: string;
  probe: string;
  left: RoundSide;
  right: RoundSide;
  verdict: Verdict;
}

/** How many columns the open Arena will show at once. The blind round is always two. */
export const ARENA_MIN_COLUMNS = 2 as const;
export const ARENA_MAX_COLUMNS = 4 as const;

export interface ArenaSettings {
  contenders: Contender[];
  /**
   * Which cards the blind draw may pick from, by PNG filename. **Empty means every card**
   * — a pool you have to fill before anything works would be a wall in front of the
   * feature, and "all of them" is the honest default for a benchmark.
   */
  cardPool: string[];
  probes: ArenaProbe[];
  /** Null follows the active preset. Both sides of a round always share one. */
  presetId: string | null;
  /**
   * The persona probes are spoken as, or null for none.
   *
   * Pinned here rather than following `AppSettings.personaId`, because a benchmark whose
   * prompts change when you switch persona in another part of the app is not measuring
   * models any more.
   */
  personaId: string | null;
  /** Open Arena column count, clamped to ARENA_MIN_COLUMNS..ARENA_MAX_COLUMNS. */
  columns: number;
  /**
   * Hold both blind replies until they have finished, rather than streaming them live.
   *
   * On by default: token rate is a loud identity leak — a local 7B and a hosted frontier
   * model are told apart by cadence alone — and a blind that leaks is worse than no blind,
   * because it produces numbers you would trust.
   */
  holdBlindUntilComplete: boolean;
  /**
   * Contender id → the id its recorded rounds count under. Empty means nothing is merged.
   *
   * One LLM served by two providers is two entries in the pool — right for the bench, which
   * runs physical endpoints, and wrong for the leaderboard, which would otherwise rank the
   * same model against itself with two half-histories. Merging folds both into one row.
   *
   * A map on the settings rather than a `mergedInto` field on the `Contender`, because the
   * merge has to outlive pool membership: removing the folded entry from the pool (which is
   * exactly what you do once it has been merged) keeps its rounds, and a field on a row that
   * no longer exists would silently split the history back in two. Rounds key on the id, so
   * this keys on the id too — the same reasoning as `characterRatings`.
   *
   * Nothing is rewritten to record a merge: the rounds keep both contenders' ids and the
   * rewrite happens on the way into a reader (`merges.ts`), so unmerging restores the split
   * exactly and for free. Chains are followed to their root and a loop is broken
   * deterministically, though the Pool only ever writes a direct link to an unmerged entry.
   */
  mergedContenders: Record<string, string>;
}

export const DEFAULT_ARENA: Readonly<ArenaSettings> = {
  contenders: [],
  cardPool: [],
  probes: [],
  presetId: null,
  personaId: null,
  columns: ARENA_MIN_COLUMNS,
  holdBlindUntilComplete: true,
  mergedContenders: {},
};
