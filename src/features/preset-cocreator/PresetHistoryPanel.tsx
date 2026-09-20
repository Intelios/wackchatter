import type { PresetCocreatorController } from './usePresetCocreator.ts';

export function PresetHistoryPanel({ controller }: { controller: PresetCocreatorController }) {
  const seenTurns = new Set<string>();
  return (
    <div className="preset-cc-history">
      {[...controller.session.history].reverse().map((revision) => {
        const canUndoTurn = Boolean(revision.turnId && !seenTurns.has(revision.turnId));
        if (revision.turnId) seenTurns.add(revision.turnId);
        return (
          <article className="preset-cc-history__entry" key={revision.revision}>
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
            {revision.diff.length ? (
              <details>
                <summary>
                  {revision.diff.length} change{revision.diff.length === 1 ? '' : 's'}
                </summary>
                <ul className="preset-cc-history__diff">
                  {revision.diff.map((change, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable diff snapshot, and one path can change twice
                    <li key={`${change.path}:${index}`}>
                      <code>{change.path || '/'}</code>
                      <span>{change.kind}</span>
                      {change.before !== undefined ? (
                        <del>{JSON.stringify(change.before)}</del>
                      ) : null}
                      {change.after !== undefined ? (
                        <ins>{JSON.stringify(change.after)}</ins>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="preset-cc-history__actions">
              <button
                type="button"
                className="wc-button wc-button--ghost"
                disabled={controller.busy || revision.revision === controller.session.draftRevision}
                title={
                  controller.busy
                    ? 'Restoration is locked while the assistant is running.'
                    : undefined
                }
                onClick={() => void controller.restoreDraft(revision.revision)}
              >
                Restore this revision
              </button>
              {canUndoTurn && revision.turnId ? (
                <button
                  type="button"
                  className="wc-button wc-button--ghost"
                  disabled={controller.busy}
                  onClick={() => void controller.undoTurn(revision.turnId!)}
                >
                  Undo this assistant turn
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
