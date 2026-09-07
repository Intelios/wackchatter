/**
 * Branch-time repair of the message-id references stored in chat metadata.
 *
 * `branchChat` copies the transcript prefix with fresh message ids, so every id a
 * metadata field stores — a memory's `range`, the memory watermark, the summary
 * checkpoint — points at the parent's messages and never resolves in the branch. The
 * consumers treat an unresolvable id as "nothing covered" or "start from the top",
 * which is the right call for a message deleted from *this* chat and the wrong one for
 * a message that was never supposed to be here at all: hidden messages no code can
 * reveal, and extraction re-reading transcript the copied memories already cover.
 *
 * Pure: given the source transcript and the old→new map of the copied prefix, rewrites
 * the references so the branch is self-consistent at the moment of the snapshot.
 * `branchedFrom.messageId` is deliberately not touched — it names a message of the
 * *parent* chat and always will.
 */

import { branchNexus } from '../nexus/state.ts';
import type { ChatMetadata, Memory } from '../types/chat.ts';

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
  if (
    !metadata.memories?.length &&
    !metadata.memoryWatermark &&
    !metadata.summary?.checkpointMessageId
  ) {
    return metadata;
  }
  if (idMap.size === 0) return metadata;

  const cut = idMap.size - 1;
  const position = new Map(source.map((message, index) => [message.id, index]));
  const branchPointId = idMap.get(source[cut]!.id)!;

  const remapped: Memory[] = [];
  for (const memory of metadata.memories ?? []) {
    const next = remapMemory(memory, position, idMap, cut, branchPointId);
    if (next) remapped.push(next);
  }

  return {
    ...metadata,
    ...(metadata.memories ? { memories: remapped } : {}),
    ...remapWatermark(metadata, position, idMap, cut, branchPointId),
    ...remapSummary(metadata, position, idMap, cut),
  };
}

function remapMemory(
  memory: Memory,
  position: Map<string, number>,
  idMap: Map<string, string>,
  cut: number,
  branchPointId: string,
): Memory | null {
  if (!memory.range) return memory;

  const start = position.get(memory.range.startId);
  const end = position.get(memory.range.endId);
  // Unresolvable in the source too, or corrupt: the parent could not resolve it either,
  // so the branch inherits the state verbatim rather than inventing coverage.
  if (start === undefined || end === undefined || end < start) return memory;

  // Entirely past the fork: the memory describes a stretch of transcript this chat does
  // not have. Dropping it is the metadata half of what branching already does to
  // messages — keeping it would put the parent's untaken future into the branch's
  // prompts as fact, and no id it stores can ever resolve here.
  if (start > cut) return null;

  // Straddles the fork. Clamp to the branch point so the surviving half stays resolvable
  // (hiding, revealing, staleness all key on the range), and flag it: the memory claims
  // coverage of messages this transcript does not contain.
  if (end > cut) {
    return {
      ...memory,
      range: { startId: idMap.get(memory.range.startId)!, endId: branchPointId },
      stale: memory.stale ?? 'deleted',
    };
  }

  return {
    ...memory,
    range: { startId: idMap.get(memory.range.startId)!, endId: idMap.get(memory.range.endId)! },
  };
}

function remapWatermark(
  metadata: ChatMetadata,
  position: Map<string, number>,
  idMap: Map<string, string>,
  cut: number,
  branchPointId: string,
): Partial<ChatMetadata> {
  const watermark = metadata.memoryWatermark;
  if (!watermark) return {};
  const index = position.get(watermark);
  // Unresolvable in the source: inherit the parent's condition rather than silently
  // claiming coverage the branch's memories cannot account for.
  if (index === undefined) return {};
  // Coverage runs past the fork, but the branch owns only up to the branch point.
  if (index > cut) return { memoryWatermark: branchPointId };
  return { memoryWatermark: idMap.get(watermark)! };
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
