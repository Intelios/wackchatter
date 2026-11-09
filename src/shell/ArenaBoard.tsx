/**
 * The leaderboard: the Arena's front door.
 *
 * One rich table — each model's trend since it joined, its rating with the band the same
 * evidence could have put it in, its record, its last ten results and what this sitting did
 * to it — then the numbers underneath it. Every figure is replayed from the recorded rounds
 * (the merged view), filtered to one character when a face is picked.
 */

import type { ArenaRound, ArenaSettings } from '@shared/types/arena.ts';
import type { CharacterSummary } from '@shared/types/card.ts';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { type RatingSeries, replay } from '../features/arena/elo.ts';
import { ratingIntervals } from '../features/arena/intervals.ts';
import { headToHead, matchupOf, winRate } from '../features/arena/matchups.ts';
import type { ArenaController } from '../features/arena/useArena.ts';
import { Markdown } from '../features/chat/Markdown.tsx';
import { characterApi } from '../lib/api.ts';
import {
  bestPerCard,
  type FormMark,
  form,
  formatSeconds,
  formatSpan,
  kTokensShort,
  lengthVsWins,
  type SittingSummary,
  type Spend,
  upsets,
  voteMix,
  wordCount,
} from './arenaStats.ts';
import { Icon } from './icons.tsx';
import { formatUsd } from './presetcc.ts';

const KEPT_APART = 'wc.arena.keptApart';

function readKeptApart(): string[] {
  try {
    const raw = localStorage.getItem(KEPT_APART);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function cardName(characters: readonly CharacterSummary[], id: string): string {
  return characters.find((c) => c.avatar === id)?.name ?? id.replace(/\.png$/i, '');
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A model id reduced to what two providers would both call it. */
function sameModelKey(modelId: string): string {
  return (modelId.split('/').pop() ?? modelId).toLowerCase().replace(/[:@].*$/, '');
}

export function ArenaBoard({
  arena,
  characters,
  nameOf,
  colourOf,
  sitting,
  sittingCost,
  onPlay,
  onSettingsChange,
}: {
  arena: ArenaController;
  characters: readonly CharacterSummary[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  sitting: SittingSummary | null;
  sittingCost: Spend | null;
  onPlay: () => void;
  onSettingsChange: (patch: Partial<ArenaSettings>) => void;
}) {
  const { merged } = arena;
  const [face, setFace] = useState<string | null>(null);
  const [opened, setOpened] = useState<ArenaRound | null>(null);
  const [bandHidden, setBandHidden] = useState(false);

  const rounds = useMemo(
    () => (face ? merged.rounds.filter((r) => r.characterId === face) : merged.rounds),
    [merged.rounds, face],
  );
  const view = useMemo(() => replay(rounds, merged.contenders), [rounds, merged.contenders]);
  const intervals = useMemo(() => ratingIntervals(rounds), [rounds]);

  const pool = new Set(arena.resolved.map((r) => r.contender.id));
  // Played first, in the replay's order; pool models with no rounds yet wait at the bottom.
  const listed = view.rows.filter(
    (row) => row.rounds + row.rejected > 0 || pool.has(row.contenderId),
  );
  const rows = [
    ...listed.filter((row) => row.rounds > 0),
    ...listed.filter((row) => row.rounds === 0),
  ];
  const established = rows.filter((row) => !row.provisional && row.rounds > 0);

  const faces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of merged.rounds) counts.set(r.characterId, (counts.get(r.characterId) ?? 0) + 1);
    return [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id]) => id);
  }, [merged.rounds]);

  const firstSeen = useMemo(() => {
    const map = new Map<string, number>();
    view.ordered.forEach((round, index) => {
      for (const id of [round.left.contenderId, round.right.contenderId]) {
        if (!map.has(id)) map.set(id, index);
      }
    });
    return map;
  }, [view.ordered]);

  const bounds = (() => {
    let lo = 1500;
    let hi = 1500;
    for (const row of rows) {
      const band = intervals.get(row.contenderId);
      lo = Math.min(lo, band?.low ?? row.rating);
      hi = Math.max(hi, band?.high ?? row.rating);
    }
    const pad = Math.max(20, (hi - lo) * 0.06);
    return { lo: lo - pad, hi: hi + pad };
  })();
  const x = (rating: number) => ((rating - bounds.lo) / (bounds.hi - bounds.lo)) * 100;

  // --- Merges: the same model through two providers ---
  const [keptApart, setKeptApart] = useState(readKeptApart);
  const suggestion = useMemo(() => {
    const roots = arena.resolved
      .map((r) => r.contender)
      .filter((c) => c.model && !(c.id in arena.settings.mergedContenders));
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const a = roots[i]!;
        const b = roots[j]!;
        if (a.model?.connectionId === b.model?.connectionId) continue;
        if (sameModelKey(a.model!.modelId) !== sameModelKey(b.model!.modelId)) continue;
        const key = [a.id, b.id].sort().join('|');
        if (!keptApart.includes(key)) return { a, b, key };
      }
    }
    return null;
  }, [arena.resolved, arena.settings.mergedContenders, keptApart]);
  const merges = Object.entries(arena.settings.mergedContenders);

  const sinceText = view.ordered[0] ? ` · since ${shortDate(view.ordered[0].created)}` : '';

  return (
    <div className="w3-ar-scroll">
      <div className="w3-ar-board">
        <header className="w3-ar-head">
          <div className="w3-ar-head__t">
            <h1>Leaderboard</h1>
            <p>
              {rounds.length} blind {rounds.length === 1 ? 'round' : 'rounds'} · {rows.length}{' '}
              {rows.length === 1 ? 'model' : 'models'}
              {sinceText}
              {face ? ` · only ${cardName(characters, face)}` : ''}
            </p>
          </div>
          <span className="w3-ar-gap" />
          {faces.length > 1 ? (
            <div className="w3-ar-faces" role="toolbar" aria-label="Filter by character">
              <button
                type="button"
                className="w3-ar-faces__all"
                aria-pressed={face === null}
                onClick={() => setFace(null)}
              >
                Every character
              </button>
              {faces.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="w3-ar-face"
                  aria-pressed={face === id}
                  title={`Only rounds on ${cardName(characters, id)}`}
                  onClick={() => setFace(face === id ? null : id)}
                >
                  <span aria-hidden="true">{cardName(characters, id).slice(0, 1)}</span>
                  <img
                    src={characterApi.imageUrl(id)}
                    alt={cardName(characters, id)}
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="w3-st-pill w3-ar-play" onClick={onPlay}>
            <Icon name="forward" size="sm" />
            Play a round
          </button>
        </header>

        {sitting && !bandHidden && !face ? (
          <SittingBand
            sitting={sitting}
            cost={sittingCost}
            nameOf={nameOf}
            characters={characters}
            onOpen={setOpened}
            onClose={() => setBandHidden(true)}
          />
        ) : null}

        {opened ? (
          <RoundSheet
            round={opened}
            number={view.ordered.findIndex((r) => r.id === opened.id) + 1}
            arena={arena}
            nameOf={nameOf}
            characters={characters}
            onClose={() => setOpened(null)}
          />
        ) : null}

        {rows.length === 0 ? (
          <div className="w3-ar-empty">
            <p>No blind rounds yet. Add two models to the pool on the island, then play a round.</p>
          </div>
        ) : (
          <section className="w3-ar-table" aria-label="Standings">
            <div className="w3-ar-tr w3-ar-th">
              <span>#</span>
              <span>Model</span>
              <span>Since it joined</span>
              <span>Rating, and how sure</span>
              <span className="w3-ar-num">Rating</span>
              <span className="w3-ar-num">Won–lost–tie</span>
              <span>Last 10</span>
              <span className="w3-ar-num">Sitting</span>
            </div>
            {rows.map((row, index) => {
              const band = intervals.get(row.contenderId);
              const gone = !pool.has(row.contenderId);
              const move = sitting?.moves.get(row.contenderId);
              const tone = row.provisional ? 'prov' : row.rating < 1500 ? 'lo' : 'hi';
              return (
                <div key={row.contenderId} className="w3-ar-tr" data-gone={gone ? '' : undefined}>
                  <span className="w3-ar-rank">{row.rounds > 0 ? index + 1 : '–'}</span>
                  <span className="w3-ar-who">
                    <b>
                      <i style={{ background: colourOf(row.contenderId) }} aria-hidden="true" />
                      {nameOf(row.contenderId)}
                    </b>
                    <small>
                      {row.rounds === 0
                        ? 'No rounds yet'
                        : row.provisional
                          ? `${row.rounds} ${row.rounds === 1 ? 'round' : 'rounds'}, still settling`
                          : `${row.rounds} rounds`}
                      {gone ? ' · removed, results kept' : ''}
                    </small>
                  </span>
                  <Spark
                    series={
                      firstSeen.has(row.contenderId)
                        ? view.series.find((s) => s.contenderId === row.contenderId)
                        : undefined
                    }
                    from={firstSeen.get(row.contenderId) ?? 0}
                    tone={tone}
                  />
                  <span className="w3-ar-band" aria-hidden="true">
                    <span className="w3-ar-band__mid" style={{ left: `${x(1500)}%` }} />
                    {band && row.rounds > 0 ? (
                      <span
                        className="w3-ar-band__ci"
                        data-tone={tone}
                        style={{ left: `${x(band.low)}%`, width: `${x(band.high) - x(band.low)}%` }}
                      />
                    ) : null}
                    {row.rounds > 0 ? (
                      <span
                        className="w3-ar-band__dot"
                        data-tone={tone}
                        style={{ left: `${x(row.rating)}%` }}
                      />
                    ) : null}
                  </span>
                  <span
                    className="w3-ar-num w3-ar-rating"
                    data-tone={tone}
                    title={band ? `95% sure it is between ${band.low} and ${band.high}` : undefined}
                  >
                    {row.rounds > 0 ? `${row.rating}${row.provisional ? '?' : ''}` : '—'}
                  </span>
                  <span className="w3-ar-num w3-ar-rec">
                    {row.wins}–{row.losses}–{row.ties}
                  </span>
                  <Form marks={form(rounds, row.contenderId)} />
                  <span className="w3-ar-num w3-ar-move">
                    {move ? (
                      <span data-dir={move > 0 ? 'up' : 'down'}>
                        {move > 0 ? '▲' : '▼'} {Math.abs(move)}
                      </span>
                    ) : (
                      <span className="w3-ar-faint">·</span>
                    )}
                  </span>
                </div>
              );
            })}
          </section>
        )}

        {suggestion ? (
          <div className="w3-ar-merge">
            <Icon name="branch" size="sm" />
            <span>
              <b>{nameOf(suggestion.a.id)}</b> and <b>{nameOf(suggestion.b.id)}</b> look like the
              same model through two connections. Count them as one?
            </span>
            <span className="w3-ar-gap" />
            <button
              type="button"
              className="w3-st-ghost w3-st-ghost--sm"
              onClick={() => {
                const roundsOf = (id: string) =>
                  view.rows.find((r) => r.contenderId === id)?.rounds ?? 0;
                const [keep, fold] =
                  roundsOf(suggestion.a.id) >= roundsOf(suggestion.b.id)
                    ? [suggestion.a, suggestion.b]
                    : [suggestion.b, suggestion.a];
                onSettingsChange({
                  mergedContenders: { ...arena.settings.mergedContenders, [fold.id]: keep.id },
                });
              }}
            >
              Merge
            </button>
            <button
              type="button"
              className="w3-ar-quiet"
              onClick={() => {
                const next = [...keptApart, suggestion.key];
                setKeptApart(next);
                try {
                  localStorage.setItem(KEPT_APART, JSON.stringify(next));
                } catch {
                  // Asked again next time; nothing is lost.
                }
              }}
            >
              Keep apart
            </button>
          </div>
        ) : null}
        {merges.length ? (
          <div className="w3-ar-merged">
            {merges.map(([fold, keep]) => (
              <span key={fold} className="w3-ar-merged__chip">
                {nameOf(fold)} counts as {nameOf(keep)}
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...arena.settings.mergedContenders };
                    delete next[fold];
                    onSettingsChange({ mergedContenders: next });
                  }}
                >
                  Split
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {rounds.length ? (
          <Stats
            rounds={rounds}
            view={view}
            established={established.map((r) => r.contenderId)}
            contenders={merged.contenders}
            nameOf={nameOf}
            colourOf={colourOf}
            characters={characters}
            onOpen={setOpened}
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------- Row pieces ----------

const Spark = memo(function Spark({
  series,
  from,
  tone,
}: {
  series: RatingSeries | undefined;
  from: number;
  tone: string;
}) {
  const points = series?.points.slice(from) ?? [];
  if (points.length < 3) return <span className="w3-ar-spark" />;
  const step = Math.max(1, Math.floor(points.length / 60));
  const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const lo = Math.min(...sampled.map((p) => p.rating));
  const hi = Math.max(...sampled.map((p) => p.rating));
  const y = (r: number) => 22 - ((r - lo) / (hi - lo || 1)) * 18;
  const d = sampled
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${((i / (sampled.length - 1)) * 104 + 2).toFixed(1)},${y(p.rating).toFixed(1)}`,
    )
    .join('');
  const last = sampled[sampled.length - 1]!;
  return (
    <svg className="w3-ar-spark" viewBox="0 0 110 26" data-tone={tone} aria-hidden="true">
      <path d={d} />
      <circle cx="106" cy={y(last.rating)} r="2.5" />
    </svg>
  );
});

function Form({ marks }: { marks: FormMark[] }) {
  const words: Record<FormMark, string> = { w: 'won', l: 'lost', t: 'tie', b: 'both bad' };
  return (
    <span
      className="w3-ar-form"
      title={
        marks.length ? `Oldest to newest: ${marks.map((m) => words[m]).join(', ')}` : undefined
      }
    >
      {marks.map((mark, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional
        <i key={i} data-v={mark} />
      ))}
    </span>
  );
}

// ---------- This sitting ----------

function SittingBand({
  sitting,
  cost,
  nameOf,
  characters,
  onOpen,
  onClose,
}: {
  sitting: SittingSummary;
  cost: Spend | null;
  nameOf: (id: string) => string;
  characters: readonly CharacterSummary[];
  onOpen: (round: ArenaRound) => void;
  onClose: () => void;
}) {
  const moves = [...sitting.moves].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  const span = sitting.sitting.end - sitting.sitting.start;
  return (
    <section className="w3-ar-sitting" aria-label="This sitting">
      <div className="w3-ar-sitting__n">
        {sitting.rounds.length}
        <small>{sitting.rounds.length === 1 ? 'round' : 'rounds'} this sitting</small>
      </div>
      <div className="w3-ar-sitting__moves">
        {moves.map(([id, v]) => (
          <span key={id}>
            {nameOf(id)} <b data-dir={v > 0 ? 'up' : 'down'}>{v > 0 ? `+${v}` : `−${-v}`}</b>
          </span>
        ))}
        {sitting.upset ? (
          <button
            type="button"
            className="w3-ar-sitting__upset"
            onClick={() => onOpen(sitting.upset!.round)}
          >
            Biggest upset: {nameOf(sitting.upset.winnerId)} over {nameOf(sitting.upset.loserId)} on{' '}
            {cardName(characters, sitting.upset.round.characterId)}
          </button>
        ) : null}
      </div>
      <div className="w3-ar-sitting__meta">
        {span > 0 ? formatSpan(span) : 'Just now'}
        {cost?.priced ? (
          <>
            <br />
            {formatUsd(cost.usd)}
            {cost.complete ? '' : '+'} · {kTokensShort(cost.tokens)} tokens
          </>
        ) : null}
      </div>
      <button type="button" className="w3-ar-x" aria-label="Hide this sitting" onClick={onClose}>
        <Icon name="close" size="sm" />
      </button>
    </section>
  );
}

// ---------- One recorded round, reopened ----------

function RoundSheet({
  round,
  number,
  arena,
  nameOf,
  characters,
  onClose,
}: {
  round: ArenaRound;
  number: number;
  arena: ArenaController;
  nameOf: (id: string) => string;
  characters: readonly CharacterSummary[];
  onClose: () => void;
}) {
  const display = arena.displayFor(round.characterId);
  const ref = useRef<HTMLElement>(null);
  // Opened from a tick or an upset far down the page: bring it to where you are looking.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll once per round opened
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [round.id]);
  const verdict =
    round.verdict === 'tie'
      ? 'You called it a tie'
      : round.verdict === 'bad'
        ? 'You threw both out'
        : null;
  return (
    <section ref={ref} className="w3-ar-sheet" aria-label={`Round ${number}`}>
      <header className="w3-ar-sheet__head">
        <img src={characterApi.imageUrl(round.characterId)} alt="" />
        <div>
          <b>
            Round {number} · {cardName(characters, round.characterId)}
          </b>
          <small>
            {new Date(round.created).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
            {verdict ? ` · ${verdict}` : ''}
          </small>
        </div>
        <span className="w3-ar-gap" />
        <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onClose}>
          Close
        </button>
      </header>
      {round.probe ? (
        <p className="w3-ar-sheet__cue">
          {round.probe.replace(/\{\{char\}\}/gi, cardName(characters, round.characterId))}
        </p>
      ) : null}
      <div className="w3-ar-sheet__two">
        {(['left', 'right'] as const).map((side) => {
          const s = round[side];
          const won = round.verdict === side;
          return (
            <div key={side} className="w3-ar-sheet__side" data-won={won ? '' : undefined}>
              <p className="w3-ar-sheet__who">
                <b>{nameOf(s.contenderId)}</b>
                {won ? <span className="w3-ar-pick">Your pick</span> : null}
                <small>
                  {wordCount(s.text)} words
                  {s.usage?.ms ? ` · ${formatSeconds(s.usage.ms)}` : ''}
                </small>
              </p>
              <div className="w3-ar-prose">
                <Markdown text={display.output(s.text)} className="w3-ar-md" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- The numbers ----------

function Stats({
  rounds,
  view,
  established,
  contenders,
  nameOf,
  colourOf,
  characters,
  onOpen,
}: {
  rounds: readonly ArenaRound[];
  view: ReturnType<typeof replay>;
  established: string[];
  contenders: ArenaController['merged']['contenders'];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
  characters: readonly CharacterSummary[];
  onOpen: (round: ArenaRound) => void;
}) {
  const cards = useMemo(() => bestPerCard(rounds).slice(0, 6), [rounds]);
  const lengths = useMemo(() => lengthVsWins(rounds), [rounds]);
  const mix = useMemo(() => voteMix(rounds), [rounds]);
  const surprises = useMemo(() => upsets(rounds, contenders, 3), [rounds, contenders]);
  const h2hIds = established.slice(0, 9);
  const table = useMemo(() => headToHead(rounds), [rounds]);

  return (
    <>
      <div className="w3-ar-stats-h">
        <h2>The numbers</h2>
      </div>
      <div className="w3-ar-stats">
        <section className="w3-ar-panel w3-ar-panel--wide">
          <header className="w3-ar-panel__h">
            <b>Ratings over time</b>
            <small>Click a name to light its line</small>
          </header>
          <RaceChart view={view} ids={established} nameOf={nameOf} colourOf={colourOf} />
          <Ticks ordered={view.ordered} onOpen={onOpen} />
        </section>

        {h2hIds.length > 1 ? (
          <section className="w3-ar-panel">
            <header className="w3-ar-panel__h">
              <b>Head to head</b>
              <small>How often the row beat the column</small>
            </header>
            <div className="w3-ar-h2h">
              <table>
                <thead>
                  <tr>
                    <th />
                    {h2hIds.map((id) => (
                      <th key={id} scope="col">
                        <span>{nameOf(id)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {h2hIds.map((a) => (
                    <tr key={a}>
                      <th scope="row">{nameOf(a)}</th>
                      {h2hIds.map((b) => {
                        if (a === b) return <td key={b} className="w3-ar-h2h__self" />;
                        const m = matchupOf(table, a, b);
                        const rate = winRate(m);
                        if (rate === null) {
                          return (
                            <td key={b} className="w3-ar-h2h__none" title="They have not met">
                              –
                            </td>
                          );
                        }
                        const pct = Math.round(rate * 100);
                        return (
                          <td
                            key={b}
                            style={{
                              background:
                                pct >= 50
                                  ? `oklch(${0.55 + (pct - 50) / 110} ${0.04 + (pct - 50) / 330} 140)`
                                  : `oklch(${0.55 + (50 - pct) / 130} ${0.04 + (50 - pct) / 380} 28)`,
                            }}
                            title={`${nameOf(a)} against ${nameOf(b)}: ${m.wins}–${m.losses}–${m.ties}`}
                          >
                            {pct}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {cards.length ? (
          <section className="w3-ar-panel">
            <header className="w3-ar-panel__h">
              <b>Best for each character</b>
              <small>Who wins most on that card</small>
            </header>
            <div className="w3-ar-cards">
              {cards.map((card) => {
                const [top, next] = card.leaders;
                return (
                  <div key={card.characterId} className="w3-ar-cardrow">
                    <img src={characterApi.imageUrl(card.characterId)} alt="" />
                    <span>
                      <b>{nameOf(top!.contenderId)}</b>
                      <small>
                        on {cardName(characters, card.characterId)}
                        {next
                          ? ` · ${nameOf(next.contenderId)} next, ${next.wins}–${next.losses}`
                          : ''}
                      </small>
                    </span>
                    <span className="w3-ar-cardrow__r">
                      <em>
                        {top!.wins}–{top!.losses}
                      </em>
                      won–lost
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {lengths.length > 1 ? (
          <section className="w3-ar-panel">
            <header className="w3-ar-panel__h">
              <b>Do longer replies win?</b>
              <small>Average reply length against points won</small>
            </header>
            <Scatter points={lengths} nameOf={nameOf} colourOf={colourOf} />
          </section>
        ) : null}

        <section className="w3-ar-panel">
          <header className="w3-ar-panel__h">
            <b>How you vote</b>
            <small>And who you throw out most</small>
          </header>
          <div className="w3-ar-mix">
            {(
              [
                ['left', 'A', 'var(--w3-ar-up)'],
                ['right', 'B', 'var(--w3-ar-up2)'],
                ['tie', 'Tie', 'var(--w3-ar-tie)'],
                ['bad', 'Both bad', 'var(--w3-ar-bad)'],
              ] as const
            ).map(([key, label, colour]) =>
              mix[key] ? (
                <i
                  key={key}
                  style={{ flex: mix[key], background: colour }}
                  title={`${label}: ${mix[key]} rounds`}
                >
                  {Math.round((mix[key] / mix.total) * 100) >= 8
                    ? `${label} ${Math.round((mix[key] / mix.total) * 100)}%`
                    : ''}
                </i>
              ) : null,
            )}
          </div>
          {mix.left + mix.right >= 10 ? (
            <p className="w3-ar-note">
              {Math.abs(mix.left - mix.right) / (mix.left + mix.right) < 0.1
                ? 'A and B win about as often as each other: no side bias.'
                : `You pick ${mix.left > mix.right ? 'A' : 'B'} more often. Sides are a coin flip, so this leans on position.`}
            </p>
          ) : null}
          {mix.bothBad.some((b) => b.share > 0) ? (
            <div className="w3-ar-badrows">
              <p className="w3-ar-label">“Both bad” share</p>
              {mix.bothBad
                .filter((b) => b.share > 0)
                .slice(0, 5)
                .map((b) => (
                  <div key={b.contenderId} className="w3-ar-badrow">
                    <span>{nameOf(b.contenderId)}</span>
                    <span className="w3-ar-badrow__bar">
                      <i style={{ width: `${Math.min(100, b.share * 400)}%` }} />
                    </span>
                    <span className="w3-ar-num">{Math.round(b.share * 100)}%</span>
                  </div>
                ))}
            </div>
          ) : null}
        </section>

        {surprises.length ? (
          <section className="w3-ar-panel w3-ar-panel--wide">
            <header className="w3-ar-panel__h">
              <b>Biggest upsets</b>
              <small>A lower-rated model beating a higher one, rated as they stood then</small>
            </header>
            <div className="w3-ar-upsets">
              {surprises.map((u) => (
                <button
                  key={u.round.id}
                  type="button"
                  className="w3-ar-upset"
                  onClick={() => onOpen(u.round)}
                >
                  <b>
                    {nameOf(u.winnerId)} beat {nameOf(u.loserId)}
                  </b>
                  <small>
                    Round {u.number} · {cardName(characters, u.round.characterId)} ·{' '}
                    {shortDate(u.round.created)}
                  </small>
                  <span>{u.gap} below</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

function RaceChart({
  view,
  ids,
  nameOf,
  colourOf,
}: {
  view: ReturnType<typeof replay>;
  ids: string[];
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
}) {
  const [lit, setLit] = useState<string[] | null>(null);
  const on = lit ?? ids.slice(0, 6);
  const W = 760;
  const H = 260;
  const pad = { l: 40, r: 140, t: 10, b: 24 };
  const n = view.ordered.length + 1;
  const lines = view.series.filter((s) => ids.includes(s.contenderId));
  const all = lines.flatMap((s) => s.points.map((p) => p.rating));
  const lo = Math.floor((Math.min(1500, ...all) - 15) / 50) * 50;
  const hi = Math.ceil((Math.max(1500, ...all) + 15) / 50) * 50;
  const y = (r: number) => pad.t + (1 - (r - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const xAt = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const step = Math.max(1, Math.floor(n / 200));
  const grid: number[] = [];
  const gstep = hi - lo > 400 ? 100 : 50;
  for (let v = lo; v <= hi; v += gstep) grid.push(v);
  const dates = [0, 1, 2, 3].map((k) =>
    Math.min(view.ordered.length - 1, Math.round((k / 3) * (view.ordered.length - 1))),
  );
  const first = view.ordered[0]?.created ?? 0;
  const span = (view.ordered.at(-1)?.created ?? 0) - first;
  const when = (at: number) =>
    span < 2 * 86_400_000
      ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : shortDate(at);

  const labels = lines
    .filter((s) => on.includes(s.contenderId))
    .map((s) => ({ id: s.contenderId, y: y(s.points[s.points.length - 1]?.rating ?? 1500) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++)
    labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + 14);

  return (
    <div className="w3-ar-race">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ratings over time">
        {grid.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              className={v === 1500 ? 'w3-ar-grid w3-ar-grid--mid' : 'w3-ar-grid'}
            />
            <text x={pad.l - 8} y={y(v) + 3} textAnchor="end" className="w3-ar-axis">
              {v}
            </text>
          </g>
        ))}
        {view.ordered.length > 1
          ? dates.map((i) => (
              <text key={i} x={xAt(i + 1)} y={H - 6} textAnchor="middle" className="w3-ar-axis">
                {when(view.ordered[i]!.created)}
              </text>
            ))
          : null}
        {lines
          .slice()
          .sort((a, b) => Number(on.includes(a.contenderId)) - Number(on.includes(b.contenderId)))
          .map((s) => {
            const lit = on.includes(s.contenderId);
            const d = s.points
              .filter((_, i) => i % step === 0 || i === s.points.length - 1)
              .map((p, i) => `${i ? 'L' : 'M'}${xAt(p.index).toFixed(1)},${y(p.rating).toFixed(1)}`)
              .join('');
            return (
              <path
                key={s.contenderId}
                d={d}
                className="w3-ar-line"
                data-lit={lit ? '' : undefined}
                style={lit ? { stroke: colourOf(s.contenderId) } : undefined}
              />
            );
          })}
        {labels.map((l) => (
          <text
            key={l.id}
            x={W - pad.r + 10}
            y={l.y + 4}
            className="w3-ar-endlabel"
            style={{ fill: colourOf(l.id) }}
          >
            {nameOf(l.id).slice(0, 22)}
          </text>
        ))}
      </svg>
      <div className="w3-ar-legend">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={on.includes(id)}
            onClick={() => setLit(on.includes(id) ? on.filter((x) => x !== id) : [...on, id])}
          >
            <i style={{ background: colourOf(id) }} />
            {nameOf(id)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Ticks({
  ordered,
  onOpen,
}: {
  ordered: readonly ArenaRound[];
  onOpen: (round: ArenaRound) => void;
}) {
  const last = ordered.slice(-120);
  const offset = ordered.length - last.length;
  return (
    <div className="w3-ar-ticks-wrap">
      <div className="w3-ar-ticks">
        {last.map((round, i) => (
          <button
            key={round.id}
            type="button"
            data-v={round.verdict}
            title={`Round ${offset + i + 1}`}
            aria-label={`Open round ${offset + i + 1}`}
            onClick={() => onOpen(round)}
          />
        ))}
      </div>
      <small>
        The last {last.length} rounds. Each mark opens its round: both replies, who wrote them, what
        you picked.
      </small>
    </div>
  );
}

function Scatter({
  points,
  nameOf,
  colourOf,
}: {
  points: ReturnType<typeof lengthVsWins>;
  nameOf: (id: string) => string;
  colourOf: (id: string) => string;
}) {
  const W = 520;
  const H = 230;
  const pad = { l: 40, r: 70, t: 12, b: 30 };
  const words = points.map((p) => p.words);
  const shares = points.map((p) => p.share * 100);
  const wlo = Math.floor(Math.min(...words) / 50) * 50;
  const whi = Math.ceil(Math.max(...words) / 50) * 50 || wlo + 50;
  const slo = Math.max(0, Math.floor((Math.min(...shares) - 5) / 10) * 10);
  const shi = Math.min(100, Math.ceil((Math.max(...shares) + 5) / 10) * 10);
  const x = (v: number) => pad.l + ((v - wlo) / (whi - wlo || 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - slo) / (shi - slo || 1)) * (H - pad.t - pad.b);
  const yTicks: number[] = [];
  for (let v = slo; v <= shi; v += 10) yTicks.push(v);
  const xTicks = [wlo, Math.round((wlo + whi) / 2), whi];
  return (
    <svg
      className="w3-ar-scatter"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Reply length against points won"
    >
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="w3-ar-grid" />
          <text x={pad.l - 8} y={y(v) + 3} textAnchor="end" className="w3-ar-axis">
            {v}%
          </text>
        </g>
      ))}
      {xTicks.map((v) => (
        <text key={v} x={x(v)} y={H - 8} textAnchor="middle" className="w3-ar-axis">
          {v} words
        </text>
      ))}
      {points.map((p) => (
        <g key={p.contenderId}>
          <circle
            cx={x(p.words)}
            cy={y(p.share * 100)}
            r="6"
            style={{ fill: colourOf(p.contenderId) }}
          >
            <title>
              {nameOf(p.contenderId)}: {p.words} words on average, {Math.round(p.share * 100)}% of
              points, {p.rounds} rounds
            </title>
          </circle>
          <text x={x(p.words) + 9} y={y(p.share * 100) + 4} className="w3-ar-dotlabel">
            {nameOf(p.contenderId).split(/[\s-]/)[0]}
          </text>
        </g>
      ))}
    </svg>
  );
}
