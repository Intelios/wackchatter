import { describe, expect, test } from 'bun:test';
import type { ChatMetadata } from '../types/chat.ts';
import { remapBranchMetadata } from './branch.ts';

/** m0..m4 copied up to and including m2, so the branch point is m2 → b2. */
function setup() {
  const source = ['m0', 'm1', 'm2', 'm3', 'm4'].map((id) => ({ id }));
  const idMap = new Map([
    ['m0', 'b0'],
    ['m1', 'b1'],
    ['m2', 'b2'],
  ]);
  return { source, idMap };
}

describe('remapBranchMetadata', () => {
  test('a summary checkpoint inside the prefix remaps; one past it stays unresolved', () => {
    const { source, idMap } = setup();

    const covered = remapBranchMetadata(
      { summary: { text: 'so far', checkpointMessageId: 'm0' } },
      source,
      idMap,
    );
    const past = remapBranchMetadata(
      { summary: { text: 'spoils the fork', checkpointMessageId: 'm3' } },
      source,
      idMap,
    );

    expect(covered.summary?.checkpointMessageId).toBe('b0');
    // Left pointing at the parent on purpose: the text describes events the branch did
    // not take, and an unresolvable checkpoint makes summaryBacklog restart at the top,
    // so the next summarise run rewrites it from this branch's own transcript.
    expect(past.summary?.checkpointMessageId).toBe('m3');
  });

  test('metadata with no message-id references comes back untouched', () => {
    const { source, idMap } = setup();
    const plain: ChatMetadata = { scenario: 'a cabin' };

    expect(remapBranchMetadata(plain, source, idMap)).toBe(plain);
  });

  test('provenance is not remapped — branchedFrom names the parent, not this branch', () => {
    const { source, idMap } = setup();
    const meta: ChatMetadata = {
      branchedFrom: { chatId: 'parent', messageId: 'm3' },
      summary: { text: 'so far', checkpointMessageId: 'm0' },
    };

    const branch = remapBranchMetadata(meta, source, idMap);

    expect(branch.branchedFrom).toEqual({ chatId: 'parent', messageId: 'm3' });
  });
});
