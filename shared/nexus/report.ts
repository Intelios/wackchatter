import type { AssembleResult } from '../prompt/assemble.ts';
import type { NexusRecall } from './types.ts';
/** Selection is diagnostic until the assembled payload actually carries its text. */
export function reportNexusAssembly(
  recall: NexusRecall | undefined,
  assembled: AssembleResult,
): NexusRecall | undefined {
  if (!recall) return undefined;
  const carried =
    assembled.ok &&
    Boolean(recall.text) &&
    assembled.messages.some((m) => m.content.includes(recall.text));
  if (carried || !recall.text) return recall;
  const reason = assembled.ok
    ? 'Nexus text was not included by the injection template or placement'
    : 'Request rejected: context overflow';
  return {
    ...recall,
    tokens: 0,
    hits: recall.hits.map((h) => ({
      ...h,
      included: false,
      reasons: h.included ? [...h.reasons, reason] : h.reasons,
    })),
    warning: reason,
  };
}
