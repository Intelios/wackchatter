import { describe, expect, test } from 'bun:test';
import type { ChatMetadata, Memory } from '../types/chat.ts';
import { remapBranchMetadata } from './branch.ts';

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: crypto.randomUUID(),
    title: 'A scene',
    text: 'Something happened.',
    keywords: ['key'],
    pinned: false,
    enabled: true,
    source: 'generated',
    edited: false,
    generatedAt: 0,
    ...overrides,
  };
}

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
  test('a range inside the copied prefix maps onto the branch message ids', () => {
    const { source, idMap } = setup();
    const within = memory({ range: { startId: 'm0', endId: 'm1' } });

    const branch = remapBranchMetadata({ memories: [within] }, source, idMap);

    expect(branch.memories![0]!.range).toEqual({ startId: 'b0', endId: 'b1' });
    expect(branch.memories![0]!.stale).toBeUndefined();
  });

  test('a memory whose range sits entirely past the branch point is dropped', () => {
    const { source, idMap } = setup();
    const past = memory({ range: { startId: 'm3', endId: 'm4' } });
    const within = memory({ range: { startId: 'm0', endId: 'm2' } });

    const branch = remapBranchMetadata({ memories: [past, within] }, source, idMap);

    expect(branch.memories).toHaveLength(1);
    expect(branch.memories![0]!.range).toEqual({ startId: 'b0', endId: 'b2' });
  });

  test('a range straddling the branch point clamps to it and is flagged stale', () => {
    const { source, idMap } = setup();
    const straddling = memory({ range: { startId: 'm1', endId: 'm4' } });

    const branch = remapBranchMetadata({ memories: [straddling] }, source, idMap);

    expect(branch.memories![0]!.range).toEqual({ startId: 'b1', endId: 'b2' });
    expect(branch.memories![0]!.stale).toBe('deleted');
  });

  test('clamping keeps an existing stale flag rather than overwriting it', () => {
    const { source, idMap } = setup();
    const straddling = memory({ range: { startId: 'm1', endId: 'm4' }, stale: 'edited' });

    const branch = remapBranchMetadata({ memories: [straddling] }, source, idMap);

    expect(branch.memories![0]!.stale).toBe('edited');
  });

  test('a memory without a range survives untouched', () => {
    const { source, idMap } = setup();
    const manual = memory();

    const branch = remapBranchMetadata({ memories: [manual] }, source, idMap);

    expect(branch.memories![0]).toBe(manual);
  });

  test('a range unresolvable in the source is inherited verbatim', () => {
    const { source, idMap } = setup();
    const orphaned = memory({ range: { startId: 'gone', endId: 'm1' } });
    const backwards = memory({ range: { startId: 'm2', endId: 'm0' } });

    const branch = remapBranchMetadata({ memories: [orphaned, backwards] }, source, idMap);

    expect(branch.memories![0]).toBe(orphaned);
    expect(branch.memories![1]).toBe(backwards);
  });

  test('the watermark remaps when covered, and becomes the branch point when it sits past it', () => {
    const { source, idMap } = setup();

    const covered = remapBranchMetadata({ memoryWatermark: 'm1' }, source, idMap);
    const past = remapBranchMetadata({ memoryWatermark: 'm4' }, source, idMap);
    const unresolvable = remapBranchMetadata({ memoryWatermark: 'gone' }, source, idMap);

    expect(covered.memoryWatermark).toBe('b1');
    expect(past.memoryWatermark).toBe('b2');
    expect(unresolvable.memoryWatermark).toBe('gone');
  });

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
      memories: [memory({ range: { startId: 'm0', endId: 'm1' } })],
    };

    const branch = remapBranchMetadata(meta, source, idMap);

    expect(branch.branchedFrom).toEqual({ chatId: 'parent', messageId: 'm3' });
  });
});
