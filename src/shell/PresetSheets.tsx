/**
 * What opens over the bench besides the prompt editor: one reply's evidence (the prompt
 * and request it went out with, and what it used), and two presets side by side.
 */

import type { Preset } from '@shared/types/preset.ts';
import type { PresetTestEvidence } from '@shared/types/preset-cocreator.ts';
import { memo, useMemo, useState } from 'react';
import { DiffParts } from '../features/preset-cocreator/PresetChanges.tsx';
import { formatValue } from '../features/preset-cocreator/presetChanges.ts';
import {
  buildSideBySide,
  type PromptRow,
  splitSides,
} from '../features/preset-cocreator/presetCompare.ts';
import { diffText } from '../features/preset-cocreator/textDiff.ts';
import { Switch } from './controls.tsx';
import { kTokens } from './studio.ts';

function contentOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

export function InspectSheet({
  evidence,
  title,
  nameOf,
  onClose,
}: {
  evidence: PresetTestEvidence | null;
  title: string;
  /** A prompt's name from its identifier, for the token breakdown. */
  nameOf: (identifier: string) => string;
  onClose: () => void;
}) {
  if (!evidence) {
    return (
      <div className="w3-pc-sheet">
        <div className="w3-pc-sheet__head">
          <b>{title}</b>
          <span className="w3-co-gap" />
          <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="w3-pc-problem">This reply’s record is gone.</p>
      </div>
    );
  }
  const facts: [string, string][] = [
    ['Model', evidence.model],
    [
      'Ran on',
      evidence.presetUsed && evidence.presetUsed.source.kind !== 'draft'
        ? evidence.presetUsed.label
        : `Revision ${evidence.draftRevision}`,
    ],
    [
      'Status',
      evidence.status === 'complete' ? (evidence.finishReason ?? 'complete') : evidence.status,
    ],
    [
      'Prompt',
      evidence.promptTokens !== undefined
        ? `${kTokens(evidence.promptTokens)} tokens`
        : `${kTokens(evidence.totalTokens)} tokens (counted here)`,
    ],
    [
      'Reply',
      evidence.completionTokens !== undefined
        ? `${kTokens(evidence.completionTokens)} tokens`
        : '—',
    ],
    [
      'History left out',
      evidence.droppedMessages ? `${evidence.droppedMessages} messages` : 'None',
    ],
  ];
  const counts = Object.entries(evidence.tokenCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="w3-pc-sheet w3-pc-inspect">
      <div className="w3-pc-sheet__head">
        <b>{title}</b>
        <span className="w3-co-gap" />
        <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="w3-pc-inspect__scroll">
        <dl className="w3-pc-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {evidence.error ? <p className="w3-pc-problem">{evidence.error}</p> : null}
        {evidence.macroWarnings.length ? (
          <p className="w3-pc-problem">
            Unknown macros:{' '}
            {evidence.macroWarnings.map((w) => `${w.macro} (in ${w.source})`).join(', ')}
          </p>
        ) : null}
        {counts.length ? (
          <section>
            <p className="w3-pc-newtest__label">Where the prompt’s tokens went</p>
            <div className="w3-pc-counts">
              {counts.map(([name, n]) => (
                <span key={name}>
                  {nameOf(name)} <b>{kTokens(n)}</b>
                </span>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <p className="w3-pc-newtest__label">
            The prompt, as sent · {evidence.messages.length} messages
          </p>
          <div className="w3-pc-sent">
            {evidence.messages.map((message, at) => (
              <details
                // biome-ignore lint/suspicious/noArrayIndexKey: the prompt is positional
                key={at}
                className="w3-pc-sent__msg"
                data-role={message.role}
              >
                <summary>
                  <b>{message.role}</b>
                  <span>{contentOf(message).slice(0, 90).replace(/\s+/g, ' ')}</span>
                </summary>
                <pre>{contentOf(message)}</pre>
              </details>
            ))}
          </div>
        </section>
        {evidence.body ? (
          <details className="w3-pc-sent__msg">
            <summary>
              <b>Request</b>
              <span>The body sent to the provider</span>
            </summary>
            <pre>{JSON.stringify(evidence.body, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

const STATUS: Record<PromptRow['status'], string> = {
  same: 'Same',
  changed: 'Changed',
  added: 'Only in the draft',
  removed: 'Only in the other',
};

export function CompareSheet({
  label,
  here,
  there,
  revision,
  onClose,
}: {
  label: string;
  here: Preset;
  there: Preset;
  revision: number;
  onClose: () => void;
}) {
  const side = useMemo(() => buildSideBySide(there, here), [there, here]);
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const prompts = onlyDifferences
    ? side.prompts.filter((row) => row.status !== 'same')
    : side.prompts;
  const settings = onlyDifferences
    ? side.settings.filter((row) => row.status !== 'same')
    : side.settings;
  return (
    <div className="w3-pc-sheet w3-pc-compare">
      <div className="w3-pc-sheet__head">
        <b>
          {label} <span className="w3-pc-compare__vs">and revision {revision}</span>
        </b>
        <span className="w3-co-gap" />
        <span className="w3-pc-compare__only">
          Only differences
          <Switch
            label="Only show what differs"
            on={onlyDifferences}
            onChange={setOnlyDifferences}
          />
        </span>
        <button type="button" className="w3-st-ghost w3-st-ghost--sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="w3-pc-compare__cols">
        <span>{label}</span>
        <span>Revision {revision}</span>
      </div>
      <div className="w3-pc-inspect__scroll">
        {side.differences === 0 ? <p className="w3-pc-benchempty">The two read the same.</p> : null}
        {side.order.length ? (
          <section className="w3-pc-cmprow">
            <div className="w3-pc-cmprow__head">
              <b>Order</b>
            </div>
            <ul className="w3-pc-change__lines">
              {side.order.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {prompts.map((row) => (
          <CompareRow key={row.key} row={row} />
        ))}
        {settings.length ? (
          <section className="w3-pc-cmprow">
            <div className="w3-pc-cmprow__head">
              <b>Settings</b>
            </div>
            {settings.map((row) => (
              <div key={row.key} className="w3-pc-cmpset" data-status={row.status}>
                <span>{row.label}</span>
                <span>{row.kind === 'value' ? formatValue(row.left) : (row.left ?? '—')}</span>
                <span>{row.kind === 'value' ? formatValue(row.right) : (row.right ?? '—')}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

const CompareRow = memo(function CompareRow({ row }: { row: PromptRow }) {
  const parts = useMemo(
    () =>
      row.status === 'changed' && row.left && row.right
        ? splitSides(diffText(row.left.content, row.right.content))
        : null,
    [row],
  );
  const side = (which: 'left' | 'right') => {
    const prompt = row[which];
    if (!prompt) return <span className="w3-pc-cmprow__none">Not in this one</span>;
    if (prompt.marker) return <span className="w3-pc-cmprow__none">Filled in by the app</span>;
    return (
      <>
        <small>
          {prompt.enabled === false
            ? 'Off · '
            : prompt.enabled === null
              ? 'Not in the order · '
              : ''}
          {prompt.meta}
        </small>
        <div className="w3-pc-diff">
          {parts ? <DiffParts parts={parts[which]} /> : prompt.content || '(empty)'}
        </div>
      </>
    );
  };
  const sameText =
    row.status === 'changed' && row.left && row.right && row.left.content === row.right.content;
  return (
    <section className="w3-pc-cmprow" data-status={row.status}>
      <div className="w3-pc-cmprow__head">
        <b>{row.label}</b>
        <span>{sameText ? 'Same text, a setting on it differs' : STATUS[row.status]}</span>
      </div>
      <div className="w3-pc-cmprow__two">
        <div>{side('left')}</div>
        <div>{side('right')}</div>
      </div>
    </section>
  );
});
