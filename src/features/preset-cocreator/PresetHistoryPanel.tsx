import type { Preset } from '@shared/types/preset.ts';
import type { PresetDraftRevision } from '@shared/types/preset-cocreator.ts';
import { memo, useMemo, useState } from 'react';
import { PresetChangeList } from './PresetChanges.tsx';
import { describeDiffEntries, describePresetChanges } from './presetChanges.ts';

interface PresetHistoryPanelProps {
  history: readonly PresetDraftRevision[];
  draftRevision: number;
  busy: boolean;
  onRestore: (revision: number) => Promise<void>;
  onUndoTurn: (turnId: string) => Promise<void>;
  /** Open the Compare tab on this revision against the current draft. */
  onCompare: (revision: number) => void;
}

interface HistoryEntryProps {
  revision: PresetDraftRevision;
  /** The revision before this one, to diff against; null for the first. */
  previous: Preset | null;
  defaultOpen: boolean;
  canUndoTurn: boolean;
  draftRevision: number;
  busy: boolean;
  onRestore: (revision: number) => Promise<void>;
  onUndoTurn: (turnId: string) => Promise<void>;
  onCompare: (revision: number) => void;
}

/**
 * One revision. Its changes are read from the preset before and after it — see
 * `describePresetChanges` for why not from the stored diff — and the word diffs inside
 * are only built once the entry is opened, so a long history costs nothing up front.
 */
const HistoryEntry = memo(function HistoryEntry({
  revision,
  previous,
  defaultOpen,
  canUndoTurn,
  draftRevision,
  busy,
  onRestore,
  onUndoTurn,
  onCompare,
}: HistoryEntryProps) {
  const [open, setOpen] = useState(defaultOpen);
  const changes = useMemo(
    () =>
      previous
        ? describePresetChanges(previous, revision.preset)
        : describeDiffEntries(revision.diff, revision.preset),
    [previous, revision],
  );

  return (
    <article className="preset-cc-history__entry">
      <header>
        <div>
          <strong>Revision {revision.revision}</strong>
          <span>{revision.summary}</span>
        </div>
        <time>{new Date(revision.created).toLocaleString()}</time>
      </header>
      <p className="wc-hint">
        {revision.source}
        {revision.restoredFrom !== undefined
          ? ` · restored from revision ${revision.restoredFrom}`
          : ''}
      </p>
      {changes.length ? (
        <details
          className="preset-cc-history__changes"
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary>
            {changes.length} change{changes.length === 1 ? '' : 's'}
          </summary>
          {open ? <PresetChangeList changes={changes} /> : null}
        </details>
      ) : null}
      <div className="preset-cc-history__actions">
        <button
          type="button"
          className="wc-button wc-button--ghost"
          disabled={busy || revision.revision === draftRevision}
          title={busy ? 'Restoration is locked while the assistant is running.' : undefined}
          onClick={() => void onRestore(revision.revision)}
        >
          Restore this revision
        </button>
        <button
          type="button"
          className="wc-button wc-button--ghost"
          disabled={revision.revision === draftRevision}
          title={
            revision.revision === draftRevision
              ? 'This is the current draft.'
              : 'Show this revision side by side with the current draft.'
          }
          onClick={() => onCompare(revision.revision)}
        >
          Compare with current
        </button>
        {canUndoTurn && revision.turnId ? (
          <button
            type="button"
            className="wc-button wc-button--ghost"
            disabled={busy}
            onClick={() => void onUndoTurn(revision.turnId!)}
          >
            Undo this assistant turn
          </button>
        ) : null}
      </div>
    </article>
  );
});

/**
 * Memoised on narrow props rather than handed the whole controller: the panel stays
 * mounted behind the other tabs, and the workspace re-renders on every streamed token.
 * None of these props move while a reply streams, so a hidden History costs nothing.
 */
export const PresetHistoryPanel = memo(function PresetHistoryPanel({
  history,
  draftRevision,
  busy,
  onRestore,
  onUndoTurn,
  onCompare,
}: PresetHistoryPanelProps) {
  const seenTurns = new Set<string>();
  const newest = history.at(-1)?.revision;
  return (
    <div className="preset-cc-history">
      {history
        .map((revision, index) => ({ revision, previous: history[index - 1]?.preset ?? null }))
        .reverse()
        .map(({ revision, previous }) => {
          const canUndoTurn = Boolean(revision.turnId && !seenTurns.has(revision.turnId));
          if (revision.turnId) seenTurns.add(revision.turnId);
          return (
            <HistoryEntry
              key={revision.revision}
              revision={revision}
              previous={previous}
              defaultOpen={revision.revision === newest}
              canUndoTurn={canUndoTurn}
              draftRevision={draftRevision}
              busy={busy}
              onRestore={onRestore}
              onUndoTurn={onUndoTurn}
              onCompare={onCompare}
            />
          );
        })}
    </div>
  );
});
