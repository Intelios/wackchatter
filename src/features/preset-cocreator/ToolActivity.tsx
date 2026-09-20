import type { PresetDiffEntry } from '@shared/preset-cocreator/patch.ts';
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

export function ToolActivityCard({ exchange }: { exchange: ToolExchange }) {
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

  if (exchange.name === 'propose_test' && ok) {
    const message = typeof args.message === 'string' ? args.message : '';
    const rationale = typeof args.rationale === 'string' ? args.rationale : '';
    return (
      <div className="preset-cc-tool preset-cc-tool--proposal" key={exchange.id}>
        <header>
          <NotesIcon />
          <strong>Proposed a test</strong>
          <span className="preset-cc-tool__badge">waits for you</span>
        </header>
        {rationale ? <p className="preset-cc-tool__summary">{rationale}</p> : null}
        {message ? <blockquote className="preset-cc-tool__quote">{message}</blockquote> : null}
        <p className="wc-hint">Run it from the testing panel — it never generates by itself.</p>
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
