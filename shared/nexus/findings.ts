import type { ApiMessage } from '../types/chat.ts';
import { cosine } from './retrieve.ts';
import { textKey } from './state.ts';
import type { NexusDocument, NexusEmbedding, NexusRecord } from './types.ts';

const SYSTEM =
  'Find information relevant to the user’s story question using only the supplied sources. Do not invent an answer. Reply ONLY with JSON {"findings":[{"text":"concise attributed finding","sources":[0]}]}. Sources are the zero-based numbers below. If no source supports an answer return {"findings":[]}. Preserve uncertainty and chronology. Prefer material not listed as already recalled. At most 8 findings.';

export function recallSearchMessages(
  search: string,
  sources: readonly NexusDocument[],
  recalledTexts: readonly string[],
): ApiMessage[] {
  const recalled = recalledTexts.length
    ? `Already recalled into the next request — do not restate these:\n${recalledTexts
        .map((t) => `- ${t}`)
        .join('\n')}\n\n`
    : '';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Question: ${search}\n\n${recalled}${sources
        .map((d, i) => `[${i}] ${d.text}`)
        .join('\n\n')}`,
    },
  ];
}

export interface SourcedFinding {
  text: string;
  docs: readonly NexusDocument[];
}

/** Transcript passages this similar to a loaded record are the same fact retold. */
export const NEAR_DUPLICATE_COSINE = 0.85;

/**
 * Reviewed Recall exists to surface material the automatic selection did not load, so
 * findings that restate it are budget waste. Drops are scoped to the records the
 * automatic selection actually includes — a finding matching an unselected record is
 * the feature working, and stays.
 */
export function filterRecallFindings(options: {
  findings: readonly SourcedFinding[];
  includedRecords: readonly NexusRecord[];
  embeddings: ReadonlyMap<string, NexusEmbedding>;
}): { kept: SourcedFinding[]; dropped: number } {
  const includedIds = new Set(options.includedRecords.map((r) => r.id));
  const includedTexts = new Set(
    options.includedRecords.flatMap((r) => r.revisions.map((v) => textKey(v.text))),
  );
  // A record's cached vector may lag an edit; an older phrasing of the same record is
  // still a faithful near-duplicate witness, so no freshness check applies here.
  const includedVectors = options.includedRecords.flatMap((r) => {
    const vector = options.embeddings.get(`record:${r.id}`)?.vector;
    return vector?.length ? [vector] : [];
  });
  const seen = new Set<string>();
  const kept: SourcedFinding[] = [];
  for (const finding of options.findings) {
    const key = textKey(finding.text);
    const restates =
      (finding.docs.length &&
        finding.docs.every((d) => d.recordId && includedIds.has(d.recordId))) ||
      includedTexts.has(key) ||
      seen.has(key) ||
      nearDuplicatesLoadedRecord(finding.docs, includedVectors, options.embeddings);
    if (restates) continue;
    seen.add(key);
    kept.push(finding);
  }
  return { kept, dropped: options.findings.length - kept.length };
}

function nearDuplicatesLoadedRecord(
  docs: readonly NexusDocument[],
  includedVectors: readonly (readonly number[])[],
  embeddings: ReadonlyMap<string, NexusEmbedding>,
): boolean {
  if (!includedVectors.length) return false;
  return docs.some((d) => {
    if (d.recordId) return false;
    const embedding = embeddings.get(d.id);
    if (!embedding || embedding.fingerprint !== d.fingerprint) return false;
    return includedVectors.some((v) => cosine(embedding.vector, v) >= NEAR_DUPLICATE_COSINE);
  });
}
