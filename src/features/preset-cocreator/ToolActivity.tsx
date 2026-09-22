import type { PresetDiffEntry } from '@shared/preset-cocreator/patch.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { ProposedPresetTest } from '@shared/types/preset-cocreator.ts';
import { useMemo } from 'react';
import { EyeIcon, NotesIcon, WandIcon } from '../../layout/icons.tsx';
import { type ToolExchange, toolCallArguments } from './assistant.ts';
import { PresetChangeList } from './PresetChanges.tsx';
import { describeDiffEntries, describePresetChanges } from './presetChanges.ts';

/**
 * One assistant tool exchange, drawn as a first-class card in the conversation rather
 * than a JSON dump. The model's edits are the whole point of this workspace: they have
 * to read at a glance — what changed, whether it landed, which revision it made — with
 * the raw exchange still one click away for debugging.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The presets either side of a revision, when the session history still holds them. */
export type RevisionPresets = (revision: number) => { before: Preset | null; after: Preset } | null;

/**
 * An edit's changes, read like History reads them. A component of its own so the memo
 * hook sits outside the card's early returns; keyed on the exchange and the two presets,
 * never on the result's diff, which is re-parsed from the tool message on every render.
 */
function PatchChanges({
  exchangeId,
  diff,
  presets,
}: {
  exchangeId: string;
  diff: PresetDiffEntry[];
  presets: ReturnType<RevisionPresets>;
}) {
  const before = presets?.before ?? null;
  const after = presets?.after;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the exchange id stands in for its diff
  const changes = useMemo(
    () =>
      before && after ? describePresetChanges(before, after) : describeDiffEntries(diff, after),
    [exchangeId, before, after],
  );
  return (
    <div className="preset-cc-tool__changes">
      <PresetChangeList changes={changes} limit={2} />
    </div>
  );
}

/**
 * What a proposal card needs to act on the proposal it made. The card is where the model
 * explained *why* it wants the test, so it is the natural place to run it from — the tray
 * beside the testing composer holds the same proposals.
 */
export interface ProposalControls {
  proposals: readonly ProposedPresetTest[];
  /** Why a proposal cannot run right now; null when it can. */
  blockedReason: string | null;
  onRun: (proposal: ProposedPresetTest) => void;
  onDismiss: (id: string) => void;
}

const PROPOSAL_STATUS: Record<ProposedPresetTest['status'], string> = {
  pending: 'waits for you',
  run: 'ran in test',
  dismissed: 'dismissed',
};

export function ToolActivityCard({
  exchange,
  proposalControls,
  revisionPresets,
}: {
  exchange: ToolExchange;
  proposalControls?: ProposalControls;
  revisionPresets?: RevisionPresets;
}) {
  const args = toolCallArguments(exchange.call);
  const result = isRecord(exchange.result) ? exchange.result : {};
  const ok = result.ok === true;
  const failed = result.ok === false;
  const diff = Array.isArray(result.diff) ? (result.diff as PresetDiffEntry[]) : null;
  const revision = typeof result.revision === 'number' ? result.revision : null;
  const currentRevision =
    typeof result.currentRevision === 'number' ? result.currentRevision : null;
  const summary = typeof args.summary === 'string' ? args.summary : null;

  if (exchange.name === 'read_preset') {
    return (
      <div className="preset-cc-tool preset-cc-tool--quiet" key={exchange.id}>
        <EyeIcon />
        <span>
          Read the preset draft
          {revision !== null ? ` · revision ${revision}` : ''}
        </span>
      </div>
    );
  }

  if (exchange.name === 'read_reference_preset') {
    const presetName = typeof args.name === 'string' ? args.name : null;
    return (
      <div className="preset-cc-tool preset-cc-tool--quiet" key={exchange.id}>
        <EyeIcon />
        <span>
          Read reference preset{presetName ? ` "${presetName}"` : ''}
          {failed && typeof result.error === 'string' ? ` — ${result.error}` : ''}
        </span>
      </div>
    );
  }

  if (exchange.name === 'propose_test' && ok) {
    const message = typeof args.message === 'string' ? args.message : '';
    const rationale = typeof args.rationale === 'string' ? args.rationale : '';
    const proposalId = typeof result.proposalId === 'string' ? result.proposalId : null;
    const proposal = proposalId
      ? (proposalControls?.proposals.find((entry) => entry.id === proposalId) ?? null)
      : null;
    const blocked = proposalControls?.blockedReason ?? null;
    return (
      <div
        className="preset-cc-tool preset-cc-tool--proposal"
        data-status={proposal?.status}
        key={exchange.id}
      >
        <header>
          <NotesIcon />
          <strong>Proposed a test</strong>
          {args.restart === true ? <span className="message__badge">fresh</span> : null}
          {proposal ? (
            <span className="preset-cc-tool__badge">{PROPOSAL_STATUS[proposal.status]}</span>
          ) : null}
        </header>
        {rationale ? <p className="preset-cc-tool__summary">{rationale}</p> : null}
        {message ? <blockquote className="preset-cc-tool__quote">{message}</blockquote> : null}
        {proposal?.status === 'pending' && proposalControls ? (
          <div className="preset-cc-tool__actions">
            <button
              type="button"
              className="wc-button wc-button--primary"
              disabled={Boolean(blocked)}
              title={
                blocked ??
                (proposal.restart
                  ? 'Run it in a fresh conversation with the current draft.'
                  : 'Run it in the active conversation with the current draft.')
              }
              onClick={() => proposalControls.onRun(proposal)}
            >
              Run in test
            </button>
            <button
              type="button"
              className="wc-button wc-button--ghost"
              onClick={() => proposalControls.onDismiss(proposal.id)}
            >
              Dismiss
            </button>
            {blocked ? <span className="wc-hint">{blocked}</span> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (exchange.name === 'patch_preset') {
    return (
      <div
        className={
          failed ? 'preset-cc-tool preset-cc-tool--failed' : 'preset-cc-tool preset-cc-tool--edit'
        }
        key={exchange.id}
      >
        <header>
          <WandIcon />
          <strong>{failed ? 'Edit rejected' : 'Edited the preset'}</strong>
          {revision !== null && !failed ? (
            <span className="preset-cc-tool__badge">revision {revision}</span>
          ) : null}
        </header>
        {summary && !failed ? <p className="preset-cc-tool__summary">{summary}</p> : null}
        {failed && typeof result.error === 'string' ? (
          <p className="preset-cc-tool__error">{result.error}</p>
        ) : null}
        {failed && currentRevision !== null ? (
          <p className="wc-hint">
            The draft is now at revision {currentRevision} — the next attempt should use it.
          </p>
        ) : null}
        {diff?.length && !failed ? (
          <PatchChanges
            exchangeId={exchange.id}
            diff={diff}
            presets={revision !== null ? (revisionPresets?.(revision) ?? null) : null}
          />
        ) : null}
        <details className="preset-cc-tool__raw">
          <summary>Raw exchange</summary>
          {exchange.call ? (
            <pre>{`call: ${exchange.call.function.name} ${exchange.call.function.arguments}`}</pre>
          ) : null}
          <pre>{`result: ${JSON.stringify(exchange.result, null, 2)}`}</pre>
        </details>
      </div>
    );
  }

  return (
    <div className="preset-cc-tool preset-cc-tool--quiet" key={exchange.id}>
      <span>
        {exchange.name}
        {failed && typeof result.error === 'string' ? ` — ${result.error}` : ''}
      </span>
    </div>
  );
}
