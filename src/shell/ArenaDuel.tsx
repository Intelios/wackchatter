/**
 * Two replies and the seam between them: the blind room's duel, shared by the Benchmark
 * and a tournament match.
 *
 * While blind, nothing that could name a side reaches the DOM — no name, model, timing,
 * cost or colour, and (when held) not even the streaming, since cadence gives a model away.
 * A side is voted for by clicking anywhere on it, or 1 and 2; the seam holds Tie (3) and
 * Both bad (4). After the vote the names drop in over each half and the ratings count from
 * where they were to where the vote put them.
 */

import type { Verdict } from '@shared/types/arena.ts';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ArenaDisplay } from '../features/arena/display.ts';
import type { RunEntry } from '../features/arena/state/arenaReducer.ts';
import { Markdown } from '../features/chat/Markdown.tsx';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import { formatSeconds, type PriceOf, wordCount } from './arenaStats.ts';
import { Icon } from './icons.tsx';
import { formatUsd } from './presetcc.ts';

export interface SideReveal {
  name: string;
  sub: string;
  /** Rating either side of the vote. Null for a round that moves no ratings. */
  before: number | null;
  after: number | null;
  colour?: string;
}

/** What one reply cost, from what the provider counted, at the catalogue's price. */
export function entryCost(entry: RunEntry, priceOf: PriceOf): number | null {
  const price = priceOf(entry.connectionId, entry.model);
  if (!price || (entry.promptTokens === null && entry.completionTokens === null)) return null;
  return (
    (entry.promptTokens ?? 0) * price.prompt + (entry.completionTokens ?? 0) * price.completion
  );
}

const StreamText = memo(function StreamText({
  store,
  display,
}: {
  store: StreamStore;
  display: ArenaDisplay;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (!snapshot.text) return <Writing />;
  return <Markdown text={display.output(snapshot.text)} className="w3-ar-md" />;
});

function Writing() {
  return (
    <p className="w3-ar-writing">
      <i aria-hidden="true" />
      Writing…
    </p>
  );
}

function CountUp({ from, to }: { from: number; to: number }) {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setValue(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 900);
      setValue(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, to]);
  const delta = value - from;
  return (
    <span className="w3-ar-count">
      {from} → {value}
      <b data-dir={to > from ? 'up' : to < from ? 'down' : undefined}>
        {delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0'}
      </b>
    </span>
  );
}

export function Duel({
  entries,
  streams,
  display,
  masked,
  hold,
  canVote,
  verdict,
  reveals,
  priceOf,
  ties = true,
  onVote,
  onRetry,
}: {
  entries: readonly RunEntry[];
  streams: readonly StreamStore[];
  display: ArenaDisplay;
  /** Blind and not yet voted: nothing identifying is drawn. */
  masked: boolean;
  /** Hide the streaming text until both replies are in. */
  hold: boolean;
  canVote: boolean;
  /** What was picked, once revealed. */
  verdict: Verdict | null;
  /** Who wrote each side, once revealed. */
  reveals: [SideReveal, SideReveal] | null;
  priceOf: PriceOf;
  /** False after a dead heat in a tournament: one of them must win. */
  ties?: boolean;
  onVote: ((verdict: Verdict) => void) | null;
  onRetry?: (contenderId: string) => void;
}) {
  const settled = entries.every((e) => e.status !== 'pending' && e.status !== 'streaming');
  const holding = hold && masked && !settled;
  const ref = useRef<HTMLDivElement>(null);

  const half = (entry: RunEntry, index: number) => {
    const side: Verdict = index === 0 ? 'left' : 'right';
    const reveal = reveals?.[index] ?? null;
    const won = verdict === side;
    const cost = reveal ? entryCost(entry, priceOf) : null;
    const votable = canVote && onVote !== null;
    const body =
      entry.status === 'pending' || holding ? (
        <Writing />
      ) : entry.status === 'streaming' ? (
        streams[index] ? (
          <StreamText store={streams[index]!} display={display} />
        ) : (
          <Writing />
        )
      ) : (
        <>
          {entry.text ? <Markdown text={display.output(entry.text)} className="w3-ar-md" /> : null}
          {entry.status === 'failed' ? (
            <p className="w3-ar-failed">
              {/* A provider's error names the model, so it waits for the reveal. */}
              {masked ? 'This reply failed.' : (entry.error ?? 'This reply failed.')}
              {onRetry ? (
                <button
                  type="button"
                  className="w3-st-ghost w3-st-ghost--sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(entry.contenderId);
                  }}
                >
                  <Icon name="refresh" size="sm" />
                  Try again
                </button>
              ) : null}
            </p>
          ) : entry.status === 'aborted' ? (
            <p className="w3-ar-failed">Stopped.</p>
          ) : null}
        </>
      );
    const content = (
      <>
        {reveal ? (
          <div
            className="w3-ar-who"
            style={reveal.colour ? { ['--w3-ar-c' as string]: reveal.colour } : undefined}
          >
            <p className="w3-ar-who__name">
              <b>{reveal.name}</b>
              {won ? <span className="w3-ar-pick">Your pick</span> : null}
            </p>
            <p className="w3-ar-who__sub">{reveal.sub}</p>
            <p className="w3-ar-who__nums">
              {reveal.before !== null && reveal.after !== null ? (
                <CountUp from={reveal.before} to={reveal.after} />
              ) : null}
              <span>
                {wordCount(entry.text)} words
                {entry.elapsedMs !== null ? ` · ${formatSeconds(entry.elapsedMs)}` : ''}
                {cost !== null ? ` · ${formatUsd(cost)}` : ''}
              </span>
            </p>
          </div>
        ) : (
          <p className="w3-ar-half__k">
            <b>{index === 0 ? 'A' : 'B'}</b>
          </p>
        )}
        <div className="w3-ar-prose">{body}</div>
      </>
    );
    return votable ? (
      <button
        key={entry.contenderId}
        type="button"
        className="w3-ar-half"
        data-side={side}
        data-votable=""
        aria-label={`Pick ${index === 0 ? 'A' : 'B'}`}
        onClick={() => onVote?.(side)}
      >
        {content}
        <span className="w3-ar-half__hint">
          <kbd className="w3-kbd">{index + 1}</kbd> Click anywhere on this side to pick it
        </span>
      </button>
    ) : (
      <div
        key={entry.contenderId}
        className="w3-ar-half"
        data-side={side}
        data-won={won ? '' : undefined}
        data-lost={verdict && !won && verdict !== 'tie' ? '' : undefined}
      >
        {content}
      </div>
    );
  };

  const [a, b] = entries;
  return (
    <div className="w3-ar-duel" ref={ref} data-revealed={reveals ? '' : undefined}>
      {a ? half(a, 0) : null}
      <div className="w3-ar-seam">
        {reveals || !onVote ? null : (
          <>
            <span className="w3-ar-seam__vs">VS</span>
            {ties ? (
              <>
                <button type="button" disabled={!canVote} onClick={() => onVote('tie')}>
                  <Icon name="lines" size="sm" />
                  Tie <kbd className="w3-kbd">3</kbd>
                </button>
                <button type="button" disabled={!canVote} onClick={() => onVote('bad')}>
                  <Icon name="close" size="sm" />
                  Both bad <kbd className="w3-kbd">4</kbd>
                </button>
              </>
            ) : null}
          </>
        )}
      </div>
      {b ? half(b, 1) : null}
    </div>
  );
}

/** 1/2/3/4 (and = and 0) vote; Enter or Space moves on; Escape stops. */
export function useDuelKeys({
  canVote,
  ties,
  onVote,
  canNext,
  onNext,
  busy,
  onStop,
}: {
  canVote: boolean;
  ties: boolean;
  onVote: (verdict: Verdict) => void;
  canNext: boolean;
  onNext: () => void;
  busy: boolean;
  onStop: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) {
        return;
      }
      if (event.key === 'Escape' && busy) {
        event.preventDefault();
        onStop();
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && canNext) {
        if (target?.tagName === 'BUTTON' && event.key === ' ') return;
        event.preventDefault();
        onNext();
        return;
      }
      if (!canVote) return;
      const verdict: Verdict | null =
        event.key === '1'
          ? 'left'
          : event.key === '2'
            ? 'right'
            : ties && (event.key === '3' || event.key === '=')
              ? 'tie'
              : ties && (event.key === '4' || event.key === '0')
                ? 'bad'
                : null;
      if (!verdict) return;
      event.preventDefault();
      onVote(verdict);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canVote, ties, onVote, canNext, onNext, busy, onStop]);
}
