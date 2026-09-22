import type { PresetDiffEntry } from '@shared/preset-cocreator/patch.ts';
import type { ProposedPresetTest } from '@shared/types/preset-cocreator.ts';
import { EyeIcon, NotesIcon, WandIcon } from '../../layout/icons.tsx';
import { type ToolExchange, toolCallArguments } from './assistant.ts';

/**
 * One assistant tool exchange, drawn as a first-class card in the conversation rather
 * than a JSON dump. The model's edits are the whole point of this workspace: they have
 * to read at a glance — what changed, whether it landed, which revision it made — with
 * the raw exchange still one click away for debugging.
 */

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') return String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function DiffRow({ entry }: { entry: PresetDiffEntry }) {
  return (
    <li className="preset-cc-tool__diff-row">
      <code>{entry.path || '/'}</code>
      {entry.before !== undefined ? <del>{compact(entry.before)}</del> : null}
      {entry.after !== undefined ? <ins>{compact(entry.after)}</ins> : null}
      {entry.before === undefined && entry.after === undefined ? <span>removed</span> : null}
    </li>
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
}: {
  exchange: ToolExchange;
  proposalControls?: ProposalControls;
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
        {diff?.length ? (
          <ul className="preset-cc-tool__diff">
            {diff.slice(0, 8).map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable diff snapshot, one path can change twice
              <DiffRow entry={entry} key={`${entry.path}:${index}`} />
            ))}
            {diff.length > 8 ? (
              <li className="preset-cc-tool__diff-more">+{diff.length - 8} more</li>
            ) : null}
          </ul>
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
