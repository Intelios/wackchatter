import type { NexusRecall } from '@shared/nexus/types.ts';
export function NexusReport({ recall }: { recall?: NexusRecall | null }) {
  if (!recall) return <p>No Nexus selection yet.</p>;
  return (
    <div className="nexus-report">
      <p>
        <strong>{recall.label}</strong> · {recall.tokens} tokens ·{' '}
        {recall.semantic ? 'Semantic, text and graph' : 'Text and graph'}
      </p>
      {recall.warning ? <p role="status">{recall.warning}</p> : null}
      {recall.hits.length ? (
        recall.hits.map((h) => (
          <details key={h.id}>
            <summary>
              {h.included ? 'Included' : 'Excluded'} · {h.text.slice(0, 100)}
            </summary>
            <p>{h.text}</p>
            <p>
              {h.reasons.join(' · ')} · {h.tokens} tokens
            </p>
          </details>
        ))
      ) : (
        <p>No relevant memories selected.</p>
      )}
    </div>
  );
}
