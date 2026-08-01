/**
 * Why the lore did what it did.
 *
 * "Why didn't my entry fire?" is the question this feature generates, so answering it is
 * part of the feature — every skipped entry names its reason rather than just being
 * absent, which is the difference between a debuggable book and a haunted one.
 */

import type { ActivationResult, SkipReason } from '@shared/worldinfo/activate.ts';
import './WorldInfoReport.css';

const SKIP_LABELS: Record<SkipReason, string> = {
  disabled: 'turned off',
  empty: 'no content',
  vectorized: 'vector-only — never fires here',
  budget: 'no budget left',
  probability: 'lost its probability roll',
  group: 'lost its inclusion group',
  delayed: 'waiting for recursion',
};

const PLACEMENT_LABELS = {
  before: 'Before',
  after: 'After',
  depth: 'At depth',
} as const;

export function WorldInfoReport({ result }: { result: ActivationResult | null }) {
  if (!result) {
    return <div className="wc-empty">No lorebooks are active for this chat.</div>;
  }

  const { activated, skipped } = result;

  return (
    <div className="wi-report">
      <div className="wi-report__summary">
        <span>
          {activated.length} of {activated.length + skipped.length} fired
        </span>
        <span>
          {result.tokens}/{result.budget} tokens
        </span>
        {result.budgetExhausted ? (
          <span className="wi-report__warn" title="Entries were skipped for want of budget">
            budget spent
          </span>
        ) : null}
      </div>

      {activated.length > 0 ? (
        <ul className="wi-report__list">
          {activated.map((entry) => (
            <li key={`${entry.sourceIndex}:${entry.uid}`} className="wi-report__row">
              <span className="wi-report__source">{entry.sourceKind}</span>
              <span className="wi-report__label" title={entry.sourceName}>
                {entry.label}
              </span>
              <span className="wi-report__why">
                {entry.reason}
                {entry.pass > 0 ? ` ×${entry.pass}` : ''}
              </span>
              <span className="wi-report__where">
                {PLACEMENT_LABELS[entry.placement]}
                {entry.placement === 'depth' ? ` ${entry.depth}` : ''}
                {/* Folding is silent otherwise, and a mysteriously relocated entry is
                    worse than one that says where it went and why. */}
                {entry.foldedFrom ? ` (${entry.foldedFrom} unsupported)` : ''}
              </span>
              <span className="wi-report__tokens">{entry.tokens}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wc-hint">Nothing fired this turn.</p>
      )}

      {skipped.length > 0 ? (
        <details className="wi-report__skipped">
          <summary>{skipped.length} not used</summary>
          <ul className="wi-report__list">
            {skipped.map((entry) => (
              <li key={`${entry.sourceIndex}:${entry.uid}`} className="wi-report__row">
                <span className="wi-report__source">{entry.sourceKind}</span>
                <span className="wi-report__label" title={entry.sourceName}>
                  {entry.label}
                </span>
                <span className="wi-report__why wi-report__why--skip">
                  {SKIP_LABELS[entry.reason]}
                </span>
                <span className="wi-report__tokens">{entry.tokens ?? ''}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
