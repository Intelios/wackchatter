import { memo, useMemo, useState } from 'react';
import { formatValue, type PresetChange } from './presetChanges.ts';
import { type DiffPart, diffText, foldParts } from './textDiff.ts';

/**
 * Preset changes, drawn for reading: prompt text as a word diff with the untouched
 * stretches folded away, settings as "before → after", prompt additions and removals by
 * name, and the order as sentences. Shared by History and the Co-Creator's edit cards so
 * the two never disagree about what an edit did.
 *
 * Memoised throughout: both hosts re-render on every streamed token, and a long prompt's
 * diff is the one thing here worth not recomputing.
 */

/**
 * Whitespace-only changes are invisible as themselves, so they are drawn as marks — ↵ for a
 * line break, · for a space. An added break still breaks the line; a removed one does not,
 * because it is not in the text any more.
 */
function visibleWhitespace(text: string, kind: 'removed' | 'added'): string {
  const marked = text.replace(/ /g, '·').replace(/\t/g, '→');
  return kind === 'added' ? marked.replace(/\n/g, '↵\n') : marked.replace(/\n/g, '↵');
}

function Change({ kind, text }: { kind: 'removed' | 'added'; text: string }) {
  const Tag = kind === 'removed' ? 'del' : 'ins';
  if (text.trim()) return <Tag>{text}</Tag>;
  return (
    <Tag
      className="preset-cc-diff__space"
      title={kind === 'removed' ? 'Whitespace removed' : 'Whitespace added'}
    >
      {visibleWhitespace(text, kind)}
    </Tag>
  );
}

/**
 * A run of diff parts with the long unchanged stretches folded, each fold expandable in
 * place. Shared by History's rows and the Compare tab's two columns.
 */
export const DiffParts = memo(function DiffParts({ parts }: { parts: readonly DiffPart[] }) {
  const shown = useMemo(() => foldParts(parts), [parts]);
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <>
      {shown.map((part, index) => {
        const key = `${index}:${part.kind}`;
        if (part.kind === 'same') return <span key={key}>{part.text}</span>;
        if (part.kind === 'fold') {
          return opened.has(index) ? (
            <span key={key}>{part.text}</span>
          ) : (
            <button
              type="button"
              className="preset-cc-diff__fold"
              key={key}
              title="Show the unchanged text"
              onClick={() => setOpened((current) => new Set(current).add(index))}
            >
              ⋯ {part.words} unchanged word{part.words === 1 ? '' : 's'} ⋯
            </button>
          );
        }
        return <Change key={key} kind={part.kind} text={part.text} />;
      })}
    </>
  );
});

const TextChangeRow = memo(function TextChangeRow({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  const diff = useMemo(() => diffText(before, after), [before, after]);

  return (
    <li className="preset-cc-change">
      <div className="preset-cc-change__head">
        <span className="preset-cc-change__label">{label}</span>
        <span className="preset-cc-change__meta">
          {diff.mode === 'words' ? (
            <>
              {diff.addedWords ? <ins>+{diff.addedWords}</ins> : null}
              {diff.removedWords ? <del>−{diff.removedWords}</del> : null}
              {diff.addedWords || diff.removedWords ? ' words' : 'whitespace only'}
            </>
          ) : (
            `rewritten · ${diff.removedWords} → ${diff.addedWords} words`
          )}
        </span>
      </div>
      {diff.mode === 'words' ? (
        <div className="preset-cc-diff">
          <DiffParts parts={diff.parts} />
        </div>
      ) : (
        <div className="preset-cc-diff preset-cc-diff--rewritten">
          <div className="preset-cc-diff__pane">
            <span className="preset-cc-diff__side">Before</span>
            <del>{diff.before}</del>
          </div>
          <div className="preset-cc-diff__pane">
            <span className="preset-cc-diff__side">After</span>
            <ins>{diff.after}</ins>
          </div>
        </div>
      )}
    </li>
  );
});

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function ChangeRow({ change }: { change: PresetChange }) {
  if (change.kind === 'text') {
    return <TextChangeRow label={change.label} before={change.before} after={change.after} />;
  }
  if (change.kind === 'value') {
    return (
      <li className="preset-cc-change">
        <div className="preset-cc-change__head">
          <span className="preset-cc-change__label">{change.label}</span>
          <span className="preset-cc-change__value">
            <del>{formatValue(change.before)}</del>
            <span aria-hidden="true">→</span>
            <span className="wc-visually-hidden">changed to</span>
            <ins>{formatValue(change.after)}</ins>
          </span>
        </div>
      </li>
    );
  }
  if (change.kind === 'prompt') {
    const Tag = change.change === 'added' ? 'ins' : 'del';
    const words = wordCount(change.content);
    return (
      <li className="preset-cc-change" data-change={change.change}>
        <div className="preset-cc-change__head">
          <span className="preset-cc-change__label">{change.label}</span>
          <span className="preset-cc-change__meta">
            {change.change === 'added' ? 'new prompt' : 'prompt removed'}
            {words ? ` · ${words} words` : ''}
          </span>
        </div>
        {change.content ? (
          <details className="preset-cc-change__content">
            <summary>
              {change.change === 'added' ? 'Show its content' : 'Show what it said'}
            </summary>
            <div className="preset-cc-diff">
              <Tag>{change.content}</Tag>
            </div>
          </details>
        ) : null}
      </li>
    );
  }
  return (
    <li className="preset-cc-change">
      <div className="preset-cc-change__head">
        <span className="preset-cc-change__label">{change.label}</span>
      </div>
      <ul className="preset-cc-change__lines">
        {change.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </li>
  );
}

export const PresetChangeList = memo(function PresetChangeList({
  changes,
  limit,
}: {
  changes: readonly PresetChange[];
  /** Show only this many until asked — the conversation's edit cards stay compact. */
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!changes.length) return <p className="wc-hint">No change to the preset itself.</p>;
  const visible = limit && !showAll ? changes.slice(0, limit) : changes;
  return (
    <>
      <ul className="preset-cc-changes">
        {visible.map((change) => (
          <ChangeRow change={change} key={change.key} />
        ))}
      </ul>
      {visible.length < changes.length ? (
        <button
          type="button"
          className="wc-button wc-button--ghost preset-cc-changes__more"
          onClick={() => setShowAll(true)}
        >
          Show all {changes.length} changes
        </button>
      ) : null}
    </>
  );
});
