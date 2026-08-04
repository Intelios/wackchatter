import type { CardBudget } from './budget.ts';
import type { LintFinding } from './lint.ts';
import './Inspector.css';

interface InspectorProps {
  budget: CardBudget;
  contextLimit: number | undefined;
  findings: readonly LintFinding[];
  onSelectSection: (section: LintFinding['section']) => void;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/** The Studio's always-visible portability and prompt-cost summary. */
export function Inspector({ budget, contextLimit, findings, onSelectSection }: InspectorProps) {
  const permanent = budget.permanent + budget.lorebookConstant;
  const ordered = [...findings].sort((left, right) => {
    const priority = { error: 0, warning: 1, info: 2 } as const;
    return priority[left.level] - priority[right.level];
  });

  return (
    <aside className="studio-inspector" aria-label="Card inspector">
      <section className="studio-inspector__section">
        <div className="studio-inspector__heading">
          <h2>Token budget</h2>
          <strong>{formatTokens(permanent)}</strong>
        </div>
        <meter
          className="studio-inspector__meter"
          aria-label="Permanent card token budget"
          min={0}
          value={permanent}
          max={contextLimit ?? Math.max(permanent, 1)}
        />
        <p className="wc-hint">
          {contextLimit
            ? `${formatTokens(permanent)} of ${formatTokens(contextLimit)} context for permanent card text.`
            : 'Choose a preset with a context limit to compare this card.'}
        </p>
        <dl className="studio-inspector__breakdown">
          <div>
            <dt>Permanent</dt>
            <dd>{formatTokens(budget.permanent)}</dd>
          </div>
          <div>
            <dt>Constant lore</dt>
            <dd>{formatTokens(budget.lorebookConstant)}</dd>
          </div>
          <div>
            <dt>Opening greeting</dt>
            <dd>{formatTokens(budget.greeting)}</dd>
          </div>
        </dl>
      </section>

      <section className="studio-inspector__section">
        <div className="studio-inspector__heading">
          <h2>Checks</h2>
          <strong>{findings.length}</strong>
        </div>
        {ordered.length ? (
          <ul className="studio-inspector__findings">
            {ordered.map((finding) => (
              <li key={finding.id} data-level={finding.level}>
                <button type="button" onClick={() => onSelectSection(finding.section)}>
                  <span aria-hidden="true">
                    {finding.level === 'error' ? '!' : finding.level === 'warning' ? '!' : 'i'}
                  </span>
                  {finding.message}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="studio-inspector__clear">No portability or quality concerns found.</p>
        )}
      </section>
    </aside>
  );
}
