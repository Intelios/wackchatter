/**
 * The leaderboard.
 *
 * Every number on this screen is replayed from the recorded rounds on render — there is no
 * stored rating that could have drifted from the history behind it. See `replayRatings`.
 *
 * Two presentation rules carry real weight. Provisional ratings are ranked below established
 * ones and marked — and now *drawn* as unsettled, with a hatched bar, because a lucky
 * two-round entrant sitting at the top would read as a verdict however grey the text was.
 * And a contender that has been deleted from the pool still appears, labelled with the model
 * it actually ran — a round never drops out of its own history.
 *
 * The ratings are drawn as bars on a shared axis centred on 1500, because every rating *is*
 * a distance from the start; a column of four-digit numbers makes the reader do that
 * subtraction. The number itself is tinted by the same distance — green above, amber sinking
 * to red below — on a fixed scale, so a colour means the same thing on every board.
 * Provisional numbers keep the grey: a tint would lend weight to what the `?` is saying to
 * ignore. And the per-card filter is a row of faces rather than a dropdown: "which model
 * plays Mika best" is the question this arena can answer and a generic one cannot, so it
 * should not be three clicks deep.
 */

import type { ArenaRound, Contender } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { TrashIcon } from '../../layout/icons.tsx';
import { characterApi } from '../../lib/api.ts';
import { contenderLabel } from './contenders.ts';
import type { ArenaDisplay } from './display.ts';
import { PROVISIONAL_ROUNDS, replay, START_RATING } from './elo.ts';
import { ForestChart } from './ForestChart.tsx';
import { HeadToHead } from './HeadToHead.tsx';
import { ratingIntervals } from './intervals.ts';
import { headToHead } from './matchups.ts';
import { applyMerges, canonicalId, type MergeMap, mergeGroups } from './merges.ts';
import { RatingChart } from './RatingChart.tsx';
import { RoundInspector } from './RoundInspector.tsx';
import { ratingTone } from './ratingTone.ts';
import { colourOf, viewSeries } from './series.ts';

interface LeaderboardProps {
  rounds: readonly ArenaRound[];
  contenders: readonly Contender[];
  /** Contender id → the id its rounds count under. See `ArenaSettings`. */
  merged: MergeMap;
  characters: readonly CharacterSummary[];
  loading: boolean;
  preferredSlots: ReadonlyMap<string, number>;
  displayFor: (characterId: string) => ArenaDisplay;
  onPurgeContender?: (contenderId: string) => void;
}

/**
 * Half the width of the rating axis, in points.
 *
 * Fixed rather than fitted to the data: a scale that grew with the spread would make an
 * early, meaningless ±16 look exactly as decisive as a settled ±150, which is the one thing
 * a bar chart of ratings must not do. Ratings past this clamp, and say so by touching the end.
 */
const AXIS_SPAN = 200;

/**
 * The attributes that tint a rating value by its distance from the start — see `ratingTone`.
 *
 * Nothing for a level rating, and nothing while provisional: the colour scale belongs to
 * settled numbers, and a bright 1620 earned in four rounds would read as a verdict however
 * loudly the `?` protests.
 */
function toneProps(
  rating: number,
  provisional: boolean,
): { dataTone?: 'above' | 'below'; style?: CSSProperties } {
  if (provisional) return {};
  const tone = ratingTone(rating);
  if (tone.kind === 'level') return {};
  return { dataTone: tone.kind, style: { '--wc-rating-t': tone.strength } as CSSProperties };
}

/**
 * The board's two graphs.
 *
 * The forest of intervals is the default — one row per contender, readable at any roster
 * size, honest about what few rounds actually pin down. The trend chart answers a question
 * a snapshot cannot (when the lead was taken, and whether it holds), so it stays a toggle
 * away. `aria-pressed` buttons per the panel rule: a pressed state cannot disagree with
 * what is on screen the way an open/closed pair of flags can.
 */
function ViewToggle({
  view,
  trendable,
  onChange,
}: {
  view: 'intervals' | 'trend';
  trendable: boolean;
  onChange: (view: 'intervals' | 'trend') => void;
}) {
  return (
    <span className="chart-view">
      <button
        type="button"
        className="chart-view__btn"
        aria-pressed={view === 'intervals'}
        onClick={() => onChange('intervals')}
        title="Every rating with the band the same rounds could have put it in"
      >
        Intervals
      </button>
      <button
        type="button"
        className="chart-view__btn"
        aria-pressed={view === 'trend'}
        disabled={!trendable}
        onClick={() => onChange('trend')}
        title={
          trendable
            ? 'Rating over rounds — when the lead was taken, and whether it holds'
            : 'The trend needs at least two rounds before a line can be drawn'
        }
      >
        Trend
      </button>
    </span>
  );
}

export function Leaderboard({
  rounds,
  contenders,
  merged,
  characters,
  loading,
  preferredSlots,
  displayFor,
  onPurgeContender,
}: LeaderboardProps) {
  const [cardFilter, setCardFilter] = useState('');
  const [openRoundId, setOpenRoundId] = useState<string | null>(null);
  const [confirmingPurgeId, setConfirmingPurgeId] = useState<string | null>(null);
  /** Which of the board's two graphs is showing. The forest is the default. */
  const [view, setView] = useState<'intervals' | 'trend'>('intervals');

  useEffect(() => {
    if (!confirmingPurgeId) return;
    const timer = setTimeout(() => setConfirmingPurgeId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmingPurgeId]);

  const cardsPlayed = useMemo(() => {
    const seen = new Map<string, number>();
    for (const round of rounds) {
      seen.set(round.characterId, (seen.get(round.characterId) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [rounds]);

  /*
   * Fold first, filter second.
   *
   * A merge is a statement about the model, so it holds on every card's board as well as the
   * whole one — and the fold is what the readers below key on, so it has to happen before the
   * card filter hands them a list. `applyMerges` touches nothing when no merge exists.
   */
  const folded = useMemo(
    () => applyMerges(rounds, contenders, merged),
    [contenders, merged, rounds],
  );

  const filtered = useMemo(
    () =>
      cardFilter
        ? folded.rounds.filter((round) => round.characterId === cardFilter)
        : folded.rounds,
    [cardFilter, folded.rounds],
  );

  /*
   * The pool is seeded only for the unfiltered board.
   *
   * Filtered to one card, a contender that has never fought on it would appear at a flat
   * 1500 as if it had been measured there — which is the opposite of what the filter is
   * being used to find out.
   */
  const { rows, series, ordered } = useMemo(
    () => replay(filtered, cardFilter ? [] : folded.contenders),
    [cardFilter, filtered, folded.contenders],
  );

  const table = useMemo(() => headToHead(filtered), [filtered]);

  /*
   * The forest plot's whiskers — a bootstrap over the same filtered rounds, so a per-card
   * board bands its own history. Deterministic by seed, so switching filters back and forth
   * redraws the same whiskers.
   */
  const intervals = useMemo(() => ratingIntervals(filtered), [filtered]);

  /** The trend view cannot draw a line until a second round exists. */
  const trendable = (series[0]?.points.length ?? 0) >= 2;
  const showTrend = view === 'trend' && trendable;

  /** Colours resolved against the entrants on this board, in ranked order. */
  const colours = useMemo(
    () =>
      viewSeries(
        rows.map((row) => row.contenderId),
        preferredSlots,
      ),
    [preferredSlots, rows],
  );

  /**
   * Pool entries grouped by the identity they count under, for `mergedLabel`.
   *
   * Grouped over the *whole* pool, not the folded list: the entries that were absorbed are
   * precisely the ones the label has to name, and they are by construction absent from the
   * surviving set the readers see.
   */
  const groups = useMemo(
    () => mergeGroups(contenders, folded.canonical),
    [contenders, folded.canonical],
  );

  const nameOf = (contenderId: string, model: string): string => {
    const contender = contenders.find((entry) => entry.id === contenderId);
    // A deleted contender falls back to what it actually ran, never to a bare uuid.
    return contender ? contenderLabel(contender) : model || contenderId;
  };

  /**
   * What a merged row is called, or null for a row that is one contender.
   *
   * Named rather than summarised: "Sonnet" alone on a board where two pool entries say
   * Sonnet is exactly the confusion the merge created, and the reader needs to see which
   * two endpoints are behind the number.
   */
  const mergedLabel = (contenderId: string): string | null => {
    const members = groups.get(canonicalId(folded.canonical, contenderId));
    if (!members || members.length < 2) return null;
    return members.map((entry) => contenderLabel(entry)).join(' + ');
  };

  const openRound = ordered.find((round) => round.id === openRoundId) ?? null;
  const openNumber = openRound ? ordered.indexOf(openRound) + 1 : 0;

  const leader = rows.find((row) => !row.provisional && row.rounds > 0) ?? null;
  const runnerUp = rows.find((row) => row !== leader && !row.provisional && row.rounds > 0);
  const leaderTone = leader ? toneProps(leader.rating, false) : {};

  // Pressed state follows what is actually showing: with one round on the board the trend
  // view cannot draw, and a toggle claiming otherwise would be lying with its own chrome.
  const viewToggle = (
    <ViewToggle view={showTrend ? 'trend' : 'intervals'} trendable={trendable} onChange={setView} />
  );

  return (
    <div className="arena-board">
      <header className="arena-board__head">
        <div>
          <h2>Leaderboard</h2>
          <p className="wc-hint">
            {rounds.length === 0
              ? 'No blind rounds yet. Ratings appear once you have judged a few.'
              : `Replayed from ${rounds.length} blind ${rounds.length === 1 ? 'round' : 'rounds'}. Nothing is stored but the rounds themselves.`}
          </p>
        </div>
      </header>

      {/* ------------------------------------------------------------- champion */}
      {!loading && leader ? (
        <div
          className="arena-champ"
          style={{ '--wc-corner': colourOf(colours, leader.contenderId) } as CSSProperties}
        >
          <div className="arena-champ__who">
            <span className="arena-champ__label">
              {cardFilter
                ? `Leading on ${characters.find((entry) => entry.avatar === cardFilter)?.name ?? cardFilter}`
                : 'Leading'}
            </span>
            <span className="arena-champ__name">{nameOf(leader.contenderId, leader.model)}</span>
            <span className="arena-champ__model">
              {mergedLabel(leader.contenderId) ?? leader.model ?? '—'} · {leader.rounds} rated{' '}
              {leader.rounds === 1 ? 'round' : 'rounds'}
            </span>
          </div>
          <dl className="arena-tape arena-champ__tape">
            <div className="arena-tape__cell">
              <dd
                className="arena-tape__value"
                data-tone={leaderTone.dataTone}
                style={leaderTone.style}
              >
                {leader.rating}
              </dd>
              <dt className="arena-tape__key">Rating</dt>
            </div>
            {runnerUp ? (
              <div className="arena-tape__cell">
                <dd className="arena-tape__value">+{leader.rating - runnerUp.rating}</dd>
                <dt className="arena-tape__key">Over 2nd</dt>
              </div>
            ) : null}
            <div className="arena-tape__cell">
              <dd className="arena-tape__value">
                {Math.round(((leader.wins + leader.ties / 2) / Math.max(1, leader.rounds)) * 100)}
                <small>%</small>
              </dd>
              <dt className="arena-tape__key">Win rate</dt>
            </div>
          </dl>
        </div>
      ) : null}

      {loading ? <p className="wc-empty">Reading the history…</p> : null}

      {/* Above the table on purpose: the shape is the thing you came to look at, and the
          exact figures are one glance further down. The forest is the default because it
          stays readable at any roster size; the trend chart answers a question a snapshot
          cannot, so it stays one toggle away rather than deleted. */}
      {!loading && rows.length > 0 && (showTrend || intervals.size > 0) ? (
        showTrend ? (
          <RatingChart
            series={series}
            rows={rows}
            ordered={ordered}
            colours={colours}
            nameOf={nameOf}
            onOpenRound={(round) => setOpenRoundId(round.id)}
            action={viewToggle}
          />
        ) : (
          <ForestChart
            rows={rows}
            intervals={intervals}
            ordered={ordered}
            colours={colours}
            nameOf={nameOf}
            onOpenRound={(round) => setOpenRoundId(round.id)}
            action={viewToggle}
          />
        )
      ) : null}

      {openRound ? (
        <RoundInspector
          round={openRound}
          number={openNumber}
          characters={characters}
          colours={colours}
          nameOf={nameOf}
          displayFor={displayFor}
          onClose={() => setOpenRoundId(null)}
        />
      ) : null}

      {/* ------------------------------------------------------------- standings */}
      {!loading && rows.length === 0 ? (
        <p className="wc-empty">Nothing to rank yet.</p>
      ) : (
        <table className="arena-ranks">
          <caption className="wc-visually-hidden">
            Contenders ranked by rating. Provisional ratings rank below established ones.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="arena-ranks__n">
                #
              </th>
              <th scope="col">Contender</th>
              <th scope="col">Model</th>
              <th scope="col" className="arena-ranks__axis-head">
                Distance from {START_RATING}
              </th>
              <th scope="col" className="arena-ranks__rating-head">
                Rating
              </th>
              <th scope="col" className="arena-ranks__record">
                Record
              </th>
              {onPurgeContender ? (
                <th scope="col" className="arena-ranks__actions-head">
                  <span className="wc-visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const offset = Math.max(-AXIS_SPAN, Math.min(AXIS_SPAN, row.rating - START_RATING));
              const share = (Math.abs(offset) / AXIS_SPAN) * 50;
              const decided = Math.max(1, row.wins + row.losses + row.ties);
              const tone = toneProps(row.rating, row.provisional);
              const isConfirming = confirmingPurgeId === row.contenderId;
              const mergedName = mergedLabel(row.contenderId);
              return (
                <tr
                  key={row.contenderId}
                  data-provisional={row.provisional}
                  style={{ '--wc-corner': colourOf(colours, row.contenderId) } as CSSProperties}
                >
                  <td className="arena-ranks__n">{index + 1}</td>
                  <th scope="row" className="arena-ranks__id">
                    <span className="arena-ranks__swatch" aria-hidden="true" />
                    <span className="arena-ranks__name">{nameOf(row.contenderId, row.model)}</span>
                    {mergedName ? (
                      <span
                        className="arena-ranks__merged"
                        title={`${mergedName} — merged: one rating over both providers' rounds.`}
                      >
                        {mergedName}
                      </span>
                    ) : null}
                  </th>
                  <td className="arena-ranks__model" title={`${row.provider} · ${row.model}`}>
                    {row.model || '—'}
                  </td>
                  <td className="arena-ranks__axis">
                    <span className="arena-ranks__zero" aria-hidden="true" />
                    <span
                      className="arena-ranks__bar"
                      aria-hidden="true"
                      data-provisional={row.provisional}
                      style={{
                        left: offset >= 0 ? '50%' : `${50 - share}%`,
                        // A floor, so a rating that has barely moved still reads as a mark on
                        // the axis rather than as dust. An entrant with no rated rounds gets
                        // nothing at all, because it has not been measured.
                        width: `${row.rounds > 0 ? Math.max(share, 1.5) : 0}%`,
                      }}
                    />
                  </td>
                  <td className="arena-ranks__rating" data-tone={tone.dataTone} style={tone.style}>
                    {row.rating}
                    {row.provisional ? (
                      <span
                        className="arena-board__provisional"
                        title={`Provisional — fewer than ${PROVISIONAL_ROUNDS} rated rounds. Treat it as noise until it settles.`}
                      >
                        ?
                      </span>
                    ) : null}
                  </td>
                  <td className="arena-ranks__record">
                    <span className="arena-wlt" aria-hidden="true">
                      {row.wins > 0 ? (
                        <i data-k="w" style={{ width: `${(row.wins / decided) * 100}%` }} />
                      ) : null}
                      {row.ties > 0 ? (
                        <i data-k="t" style={{ width: `${(row.ties / decided) * 100}%` }} />
                      ) : null}
                      {row.losses > 0 ? (
                        <i data-k="l" style={{ width: `${(row.losses / decided) * 100}%` }} />
                      ) : null}
                    </span>
                    {/* Rejected rounds are deliberately absent: they moved no rating and
                        decided nothing, so the record has nothing to say about them. */}
                    <span className="arena-wlt__key">
                      {row.wins}W · {row.losses}L · {row.ties}T
                    </span>
                  </td>
                  {onPurgeContender ? (
                    <td className="arena-ranks__actions">
                      <button
                        type="button"
                        className="wc-button wc-button--ghost wc-button--danger arena-ranks__delete"
                        data-confirming={isConfirming || undefined}
                        onClick={() => {
                          if (isConfirming) {
                            onPurgeContender(row.contenderId);
                            setConfirmingPurgeId(null);
                          } else {
                            setConfirmingPurgeId(row.contenderId);
                          }
                        }}
                        onBlur={() =>
                          setConfirmingPurgeId((id) => (id === row.contenderId ? null : id))
                        }
                        title={
                          isConfirming
                            ? 'Click again to permanently erase all recorded rounds for this model'
                            : `Permanently delete ${nameOf(row.contenderId, row.model)} and erase its rounds`
                        }
                        aria-label={
                          isConfirming
                            ? `Confirm delete ${nameOf(row.contenderId, row.model)}`
                            : `Delete ${nameOf(row.contenderId, row.model)}`
                        }
                      >
                        {isConfirming ? 'Sure?' : <TrashIcon />}
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {rows.some((row) => row.provisional) ? (
        <p className="wc-hint arena-board__note">
          A <span className="arena-board__provisional">?</span> marks a provisional rating: fewer
          than {PROVISIONAL_ROUNDS} rated rounds behind it, drawn as a hatched bar. Those rows are
          ranked below established ones however high the number goes, because five rounds of Elo is
          noise.
        </p>
      ) : null}

      {/* ------------------------------------------------------------- head to head */}
      {!loading ? <HeadToHead rows={rows} table={table} colours={colours} nameOf={nameOf} /> : null}

      {/* ------------------------------------------------------------- per card */}
      {cardsPlayed.length > 1 ? (
        <section className="arena-oncard">
          <header className="arena-h2h__head">
            <h3>On which card?</h3>
            <p className="wc-hint">
              The question this arena can answer and a general one cannot. A model that wins
              everywhere else can still be the wrong one for a particular character.
            </p>
          </header>
          <div className="arena-oncard__chips">
            <button
              type="button"
              className="arena-cardchip"
              data-on={cardFilter === ''}
              onClick={() => setCardFilter('')}
            >
              <span className="arena-cardchip__all" aria-hidden="true">
                ★
              </span>
              <span className="arena-cardchip__name">Every card</span>
              <span className="arena-cardchip__count">{rounds.length}</span>
            </button>
            {cardsPlayed.map(([avatar, count]) => (
              <button
                key={avatar}
                type="button"
                className="arena-cardchip"
                data-on={cardFilter === avatar}
                onClick={() => setCardFilter(cardFilter === avatar ? '' : avatar)}
              >
                <img src={characterApi.imageUrl(avatar)} alt="" loading="lazy" />
                <span className="arena-cardchip__name">
                  {characters.find((entry) => entry.avatar === avatar)?.name ?? avatar}
                </span>
                <span className="arena-cardchip__count">{count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
