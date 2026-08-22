/**
 * One column of a comparison.
 *
 * Two things it deliberately does not decide: who it is running, and whether that may be
 * shown. `masked` is passed in because blindness belongs to the mode, not the column — and
 * keeping the decision at the caller is what makes it checkable in one place rather than
 * inferred from four props here.
 *
 * When masked, the identity is not merely hidden with CSS. Nothing about the contender
 * reaches the DOM at all: no name, no model, no provider, no colour, and no metrics — a
 * stream that took 400ms to first token against one that took 4s is as good as a label.
 *
 * The reply is set at the transcript's own size and weight (`--wc-text-base`/500), not the
 * UI's. This screen exists to have prose read and judged on it, and it was previously
 * asking for that at two steps down the scale from where the same prose is rendered in a
 * chat. And it does not scroll: two independently-scrolling boxes side by side lose their
 * alignment the moment either one moves, which is the one thing a comparison cannot afford.
 * A genuinely enormous reply folds instead, so the page stays navigable without the wheel
 * ever being captured.
 */

import type { CSSProperties } from 'react';
import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { StreamingText } from '../chat/StreamingText.tsx';
import type { StreamStore } from '../chat/state/streamStore.ts';
import type { ArenaDisplay } from './display.ts';
import type { RunEntry } from './state/arenaReducer.ts';

/** The figures the tape can report for one column. */
export type MeasureKey = 'firstToken' | 'total' | 'tokens' | 'rate';

/**
 * Which column won each measure, by id — so a column can only ever mark what it actually is.
 *
 * `tokens` is deliberately never populated. Length is not a thing to win: a reply twice as
 * long is twice as long, and putting a winner's mark on it would be the layout telling the
 * reader something the benchmark does not believe.
 */
export type ColumnLeaders = Partial<Record<MeasureKey, string>>;

interface ContenderColumnProps {
  entry: RunEntry;
  /** The live store for this column, or null when this run is not the one generating. */
  stream: StreamStore | null;
  display: ArenaDisplay;
  /** This contender's corner colour, as a `var(--wc-series-N)`. Never set while masked. */
  colour?: string;
  /** Hide everything that identifies the contender. */
  masked?: boolean;
  /** What to call it while masked — "A" or "B". */
  maskLabel?: string;
  /**
   * Withhold the reply until it has settled.
   *
   * Streaming cadence is an identity leak on its own, so a blind round shows a waiting
   * state rather than live text. The request still streams; only the rendering waits.
   */
  hold?: boolean;
  /** Reply length as a fraction of the longest in this run, for the bar. */
  lengthRatio?: number;
  /** Who won each measure across the run. Only ever rendered unmasked. */
  leaders?: ColumnLeaders;
  onReroll?: () => void;
  rerollDisabledReason?: string | null;
  /** Shown in place of the identity once a blind round is revealed. */
  reveal?: { name: string; rating: number; delta: number } | null;
}

interface Measure {
  key: MeasureKey;
  value: string;
  unit?: string;
  label: string;
}

function measures(entry: RunEntry): Measure[] {
  const list: Measure[] = [];
  if (entry.firstTokenMs !== null) {
    list.push({
      key: 'firstToken',
      value: (entry.firstTokenMs / 1000).toFixed(1),
      unit: 's',
      label: 'To first',
    });
  }
  if (entry.elapsedMs !== null) {
    list.push({
      key: 'total',
      value: (entry.elapsedMs / 1000).toFixed(1),
      unit: 's',
      label: 'Total',
    });
  }
  if (entry.completionTokens !== null) {
    list.push({ key: 'tokens', value: String(entry.completionTokens), label: 'Tokens' });
    if (entry.elapsedMs) {
      list.push({
        key: 'rate',
        value: ((entry.completionTokens / entry.elapsedMs) * 1000).toFixed(1),
        label: 'Tok/s',
      });
    }
  }
  return list;
}

/**
 * Live verbosity, straight off the stream store.
 *
 * Its own leaf and its own subscription, exactly like `StreamingText`: this repaints thirty
 * times a second and must not drag the run log above it into a render. Words rather than
 * tokens because a word count is free and honest, where a live token count would either
 * cost a tokenizer pass per frame or be a guess dressed up as a measurement.
 */
const LiveWords = memo(function LiveWords({ store }: { store: StreamStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const words = snapshot.text.trim() ? snapshot.text.trim().split(/\s+/).length : 0;
  if (words === 0) return null;
  return (
    <span className="arena-column__live">
      <i className="arena-column__pulse" aria-hidden="true" />
      {words} words
    </span>
  );
});

export const ContenderColumn = memo(function ContenderColumn({
  entry,
  stream,
  display,
  colour,
  masked = false,
  maskLabel = '?',
  hold = false,
  lengthRatio = 0,
  leaders,
  onReroll,
  rerollDisabledReason,
  reveal = null,
}: ContenderColumnProps) {
  const live = entry.status === 'pending' || entry.status === 'streaming';
  /*
   * `hold` withholds a settled reply too, not only a streaming one.
   *
   * Otherwise the first column to finish would reveal itself the moment it landed, and
   * "which one appeared first" is exactly the timing signal holding exists to suppress.
   * The caller sets it from the whole run, never from this entry.
   */
  const revealed = !hold && !live;
  const waiting = !revealed;

  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [foldable, setFoldable] = useState(false);

  /*
   * Measured rather than guessed from the character count: the same 2000 characters is two
   * screens of dialogue or half a screen of one dense paragraph, and folding the second is
   * an annoyance with nothing behind it. Skipped once expanded, so the collapse control
   * does not remove itself by making the box fit.
   */
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element || expanded || !revealed) return;
    setFoldable(element.scrollHeight > element.clientHeight + 4);
  }, [expanded, revealed]);

  const folded = foldable && !expanded;
  const shown = measures(entry);

  return (
    <section
      className="arena-column"
      data-status={entry.status}
      data-masked={masked}
      data-revealed={reveal !== null}
      // The colour is the identity, so a masked column must not carry it — a lime stripe
      // and a blue one are a label written in another alphabet.
      style={masked && !reveal ? undefined : ({ '--wc-corner': colour } as CSSProperties)}
    >
      <span className="arena-column__stripe" aria-hidden="true" />

      <header className="arena-column__head">
        <div className="arena-column__identity">
          {masked && !reveal ? (
            <>
              <span className="arena-column__seal">{maskLabel}</span>
              <span className="arena-column__sealed">Sealed until you vote</span>
            </>
          ) : reveal ? (
            <>
              <span className="arena-column__seal" data-broken="true">
                {maskLabel}
              </span>
              <span className="arena-column__revealed">
                <span className="arena-column__name">{reveal.name}</span>
                <span className="arena-column__model">
                  {reveal.rating - reveal.delta} &rarr; {reveal.rating}
                </span>
              </span>
              <span
                className="arena-column__delta"
                data-sign={reveal.delta > 0 ? 'up' : reveal.delta < 0 ? 'down' : 'flat'}
              >
                {reveal.delta > 0 ? `+${reveal.delta}` : reveal.delta < 0 ? reveal.delta : '—'}
              </span>
            </>
          ) : (
            <>
              <span className="arena-column__name" title={entry.name}>
                {entry.name}
              </span>
              <span className="arena-column__model" title={`${entry.provider} · ${entry.model}`}>
                {entry.model}
              </span>
            </>
          )}
        </div>

        {/* Live verbosity is a timing signal, so it is unmasked-only like the metrics. */}
        {!masked && entry.status === 'streaming' && stream && !hold ? (
          <LiveWords store={stream} />
        ) : null}

        {onReroll ? (
          <button
            type="button"
            className="wc-button wc-button--ghost arena-column__reroll"
            onClick={onReroll}
            disabled={Boolean(rerollDisabledReason)}
            title={rerollDisabledReason ?? 'Generate another reply to the same prompt'}
            aria-label="Re-roll this column"
          >
            <RefreshIcon />
          </button>
        ) : null}
      </header>

      <div className="arena-column__body" data-folded={folded} ref={bodyRef}>
        {waiting && !(entry.status === 'streaming' && !hold) ? (
          <p className="arena-column__waiting">
            {/* Deliberately vague. "Connecting" versus "writing" tells a blind reader
                which model is slow to start, which is half of recognising it. */}
            <span className="arena-column__pulse" aria-hidden="true" />
            {masked ? 'Writing…' : entry.status === 'pending' ? 'Connecting…' : 'Writing…'}
          </p>
        ) : null}

        {!hold && entry.status === 'streaming' && stream ? <StreamingText store={stream} /> : null}

        {revealed ? (
          <>
            {entry.reasoning && !masked ? (
              <Reasoning text={display.reasoning(entry.reasoning)} />
            ) : null}
            {entry.text ? (
              <Markdown text={display.output(entry.text)} className="arena-column__text" />
            ) : entry.status === 'failed' ? null : (
              <p className="arena-column__empty">Nothing came back.</p>
            )}
          </>
        ) : null}

        {revealed && entry.status === 'failed' && entry.error ? (
          <p className="arena-column__error">{entry.error}</p>
        ) : null}
        {revealed && entry.status === 'aborted' ? (
          <p className="arena-column__note">Stopped.</p>
        ) : null}
      </div>

      {foldable && revealed ? (
        <button
          type="button"
          className="arena-column__fold"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Fold this reply' : 'Show the rest'}
        </button>
      ) : null}

      {/*
       * Length said out loud rather than left to the layout.
       *
       * Columns are equal width on purpose, so a longer reply cannot widen its own column —
       * but that only stops length being smuggled in, it does not stop a reader half-noticing
       * it. Stating it is the honest version: the bar is the whole comparison in one glance,
       * and it is the same figure the tape reports in tokens.
       */}
      {!masked && revealed && entry.text ? (
        <footer className="arena-column__foot">
          <div className="arena-column__length">
            <span className="arena-column__bar">
              <span
                className="arena-column__fill"
                style={{ width: `${Math.max(2, Math.round(lengthRatio * 100))}%` }}
              />
            </span>
          </div>

          {shown.length > 0 ? (
            <dl className="arena-tape">
              {shown.map((measure) => (
                <div key={measure.key} className="arena-tape__cell">
                  <dd
                    className="arena-tape__value"
                    // Marked only when there is someone to have beaten: a single-column run
                    // has no comparison in it, and every figure "winning" says nothing.
                    data-best={leaders?.[measure.key] === entry.contenderId}
                  >
                    {measure.value}
                    {measure.unit ? <small>{measure.unit}</small> : null}
                  </dd>
                  <dt className="arena-tape__key">{measure.label}</dt>
                </div>
              ))}
            </dl>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
});
