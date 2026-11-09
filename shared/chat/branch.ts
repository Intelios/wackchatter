/**
 * Branch-time repair of the message-id references stored in chat metadata.
 *
 * `branchChat` copies the transcript prefix with fresh message ids, so every id a
 * metadata field stores — the summary checkpoint, Nexus evidence — points at the parent's
 * messages and never resolves in the branch. The consumers treat an unresolvable id as
 * "start from the top", which is the right call for a message deleted from *this* chat and
 * the wrong one for a message that was never supposed to be here at all.
 *
 * Pure: given the source transcript and the old→new map of the copied prefix, rewrites
 * the references so the branch is self-consistent at the moment of the snapshot.
 * `branchedFrom.messageId` is deliberately not touched — it names a message of the
 * *parent* chat and always will.
 */

import { branchNexus } from '../nexus/state.ts';
import type { ChatMetadata } from '../types/chat.ts';

export function remapBranchMetadata(
  metadata: ChatMetadata,
  /** The source transcript the stored ids were written against. */
  source: readonly { id: string }[],
  /**
   * Copied messages only, in transcript order: original id → fresh branch id. The last
   * entry is the branch point, and `idMap.size` the length of the copied prefix.
   */
  idMap: Map<string, string>,
): ChatMetadata {
  if (metadata.nexus) metadata = { ...metadata, nexus: branchNexus(metadata.nexus, idMap) };
  if (!metadata.summary?.checkpointMessageId || idMap.size === 0) return metadata;

  const cut = idMap.size - 1;
  const position = new Map(source.map((message, index) => [message.id, index]));
  return { ...metadata, ...remapSummary(metadata, position, idMap, cut) };
}

function remapSummary(
  metadata: ChatMetadata,
  position: Map<string, number>,
  idMap: Map<string, string>,
  cut: number,
): Partial<ChatMetadata> {
  const summary = metadata.summary;
  const checkpoint = summary?.checkpointMessageId;
  if (!summary || !checkpoint) return {};
  const index = position.get(checkpoint);
  // Past the fork, the checkpoint stays pointing at the parent on purpose: the summary
  // text then describes events the branch did not take, and leaving it unresolvable is
  // what makes `summaryBacklog` restart at the top, so the next summarise run rewrites
  // the summary from this branch's own transcript instead of carrying the parent's
  // version forward as if it were true here.
  if (index === undefined || index > cut) return {};
  return { summary: { ...summary, checkpointMessageId: idMap.get(checkpoint)! } };
}
