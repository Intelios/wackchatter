import type { ModelUsage } from '@shared/types/stats.ts';
import { compact, seconds } from '../format.ts';

/**
 * The detail behind the donut: what each model cost in tokens, and how fast it wrote.
 *
 * Speed and latency come from `gen_started`/`gen_finished`, which the app has been
 * recording per swipe all along — an em dash means that swipe was never timed rather than
 * that it was instant.
 */
export function ModelTable({ models }: { models: readonly ModelUsage[] }) {
  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Provider</th>
          <th scope="col">Tokens</th>
          <th scope="col">Speed</th>
          <th scope="col">Latency</th>
        </tr>
      </thead>
      <tbody>
        {models.map((model) => (
          <tr key={`${model.model}:${model.api}`}>
            <th scope="row" title={model.model}>
              {model.model}
            </th>
            {/* Rendered as recorded: older rows carry provider ids the app no longer has. */}
            <td className="stats-table__mono">{model.api || '—'}</td>
            <td>{compact(model.tokens)}</td>
            <td>{model.tokensPerSecond === null ? '—' : `${model.tokensPerSecond}/s`}</td>
            <td>{seconds(model.avgLatencyMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
