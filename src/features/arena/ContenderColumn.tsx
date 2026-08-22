/**
 * One column of a comparison.
 *
 * Two things it deliberately does not decide: who it is running, and whether that may be
 * shown. `masked` is passed in because blindness belongs to the mode, not the column — and
 * keeping the decision at the caller is what makes it checkable in one place rather than
 * inferred from four props here.
 *
 * When masked, the identity is not merely hidden with CSS. Nothing about the contender
 * reaches the DOM at all: no name, no model, no provider, and no metrics — a stream that
 * took 400ms to first token against one that took 4s is as good as a label.
 */

import { memo } from 'react';
import { RefreshIcon } from '../../layout/icons.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { Reasoning } from '../chat/Reasoning.tsx';
import { StreamingText } from '../chat/StreamingText.tsx';
import type { StreamStore } from '../chat/state/streamStore.ts';
import type { ArenaDisplay } from './display.ts';
import type { RunEntry } from './state/arenaReducer.ts';

interface ContenderColumnProps {
  entry: RunEntry;
  /** The live store for this column, or null when this run is not the one generating. */
  stream: StreamStore | null;
  display: ArenaDisplay;
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
  onReroll?: () => void;
  rerollDisabledReason?: string | null;
}

function metrics(entry: RunEntry): string {
  const parts: string[] = [];
  if (entry.firstTokenMs !== null)
    parts.push(`${(entry.firstTokenMs / 1000).toFixed(1)}s to first`);
  if (entry.elapsedMs !== null) parts.push(`${(entry.elapsedMs / 1000).toFixed(1)}s total`);
  if (entry.completionTokens !== null) {
    parts.push(`${entry.completionTokens} tok`);
    if (entry.elapsedMs) {
      parts.push(`${((entry.completionTokens / entry.elapsedMs) * 1000).toFixed(1)} tok/s`);
    }
  }
  return parts.join(' · ');
}

export const ContenderColumn = memo(function ContenderColumn({
  entry,
  stream,
  display,
  masked = false,
  maskLabel = '?',
  hold = false,
  onReroll,
  rerollDisabledReason,
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

  return (
    <section className="arena-column" data-status={entry.status} data-masked={masked}>
      <header className="arena-column__head">
        <div className="arena-column__identity">
          {masked ? (
            <span className="arena-column__mask">{maskLabel}</span>
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

      <div className="arena-column__body">
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

      {/* Metrics are an identity leak of their own, so they wait for the reveal too. */}
      {!masked && revealed && metrics(entry) ? (
        <footer className="arena-column__metrics">{metrics(entry)}</footer>
      ) : null}
    </section>
  );
});
