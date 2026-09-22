import type { ProposedPresetTest } from '@shared/types/preset-cocreator.ts';
import { useEffect, useRef, useState } from 'react';
import { ChevronIcon, CloseIcon, EditIcon, NotesIcon } from '../../layout/icons.tsx';

interface ProposalTrayProps {
  /** Pending proposals only, oldest first — the newest sits nearest the composer. */
  proposals: readonly ProposedPresetTest[];
  /** The proposal currently loaded into the message box, if any. */
  editingId: string | null;
  /** Why no proposal can run right now; null when they can. */
  blockedReason: string | null;
  /** Why a proposal cannot be edited into the message box; null when it can. */
  editBlockedReason: string | null;
  onRun: (proposal: ProposedPresetTest) => void;
  onEdit: (proposal: ProposedPresetTest) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}

/**
 * The Co-Creator's proposed tests, docked directly above the testing composer.
 *
 * They used to sit at the top of the testing panel, above the scenario and the whole
 * transcript — so running one meant scrolling all the way up, away from the conversation
 * it was about to extend. Here they ride the composer's sticky edge instead: wherever the
 * transcript is scrolled, the next test to run is one click from where you type.
 *
 * Rows are clamped (a proposal can run to several hundred characters); the full message
 * and rationale are the row's tooltip, and Edit loads the whole text into the message box.
 */
export function ProposalTray({
  proposals,
  editingId,
  blockedReason,
  editBlockedReason,
  onRun,
  onEdit,
  onDismiss,
  onDismissAll,
}: ProposalTrayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const count = proposals.length;
  const previousCount = useRef(count);

  // A new proposal is news: reopen the tray rather than leave it folded out of sight.
  useEffect(() => {
    if (count > previousCount.current) setCollapsed(false);
    previousCount.current = count;
  }, [count]);

  if (!count) return null;

  return (
    <section className="preset-cc-tray" aria-label="Proposed tests">
      <header className="preset-cc-tray__head">
        <button
          type="button"
          className="preset-cc-tray__toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <NotesIcon className="preset-cc-icon-sm" />
          <span>
            {count} proposed test{count === 1 ? '' : 's'}
          </span>
          <span className="preset-cc-tray__chevron" data-collapsed={collapsed || undefined}>
            <ChevronIcon className="preset-cc-icon-sm" />
          </span>
        </button>
        {count > 1 && !collapsed ? (
          <button
            type="button"
            className="wc-button wc-button--ghost preset-cc-tray__clear"
            onClick={onDismissAll}
          >
            Dismiss all
          </button>
        ) : null}
      </header>
      {collapsed ? null : (
        <ul className="preset-cc-tray__list">
          {proposals.map((proposal) => {
            const editing = proposal.id === editingId;
            return (
              <li
                className="preset-cc-tray__row"
                data-editing={editing || undefined}
                key={proposal.id}
                title={
                  proposal.rationale
                    ? `${proposal.rationale}\n\n${proposal.message}`
                    : proposal.message
                }
              >
                <div className="preset-cc-tray__text">
                  {proposal.rationale ? (
                    <span className="preset-cc-tray__rationale">{proposal.rationale}</span>
                  ) : null}
                  <span className="preset-cc-tray__message">
                    {proposal.restart ? <span className="message__badge">fresh</span> : null}
                    {proposal.message}
                  </span>
                </div>
                <div className="preset-cc-tray__actions">
                  {editing ? (
                    <span className="preset-cc-tray__state">in message box</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="wc-button wc-button--primary"
                        disabled={Boolean(blockedReason)}
                        title={
                          blockedReason ??
                          (proposal.restart
                            ? 'Run it in a fresh conversation with the current draft.'
                            : 'Run it in the active conversation with the current draft.')
                        }
                        onClick={() => onRun(proposal)}
                      >
                        Run
                      </button>
                      <button
                        type="button"
                        className="wc-button wc-button--ghost message__action"
                        disabled={Boolean(editBlockedReason)}
                        title={editBlockedReason ?? 'Edit in the message box before running'}
                        aria-label="Edit before running"
                        onClick={() => onEdit(proposal)}
                      >
                        <EditIcon />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="wc-button wc-button--ghost message__action"
                    title="Dismiss"
                    aria-label="Dismiss"
                    onClick={() => onDismiss(proposal.id)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
