import { describe, expect, test } from 'bun:test';
import {
  activeCheckpoint,
  type CompactionMessage,
  type CompactionRecord,
  compactionMessages,
  createCompactionState,
  makeCompactionPlan,
  normalizeCompaction,
  recordCompaction,
  renderCheckpoint,
  shouldCompact,
} from './compaction.ts';

const count = (text: string) => Math.ceil(text.length / 4);
const messages = (): CompactionMessage[] =>
  Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    group: String(i),
    role: i % 2 ? 'assistant' : 'user',
    content: `${i}: ${'Design detail. '.repeat(100)}`,
    ...(i % 2 ? {} : { userText: i === 0 ? 'The original brief.' : `User decision ${i}` }),
  }));
function plan(source = messages(), state = createCompactionState(), maxPromptTokens = 20000) {
  return makeCompactionPlan({
    messages: source,
    state,
    maxPromptTokens,
    countText: count,
    kind: 'preset',
  });
}
function completed(source = messages(), state = createCompactionState()): CompactionRecord {
  const prepared = plan(source, state)!;
  return recordCompaction(prepared, {
    id: 'run',
    created: 1,
    status: 'complete',
    summary: 'The user wants restrained prose. A test is still pending.',
    model: { connectionId: 'connection', modelId: 'model' },
    inputTokens: 100,
    outputTokens: 30,
  });
}

describe('Co-Creator compaction checkpoints', () => {
  test('new conversations opt in; old or malformed documents never enable paid work', () => {
    expect(createCompactionState().automatic).toBe(true);
    expect(normalizeCompaction(undefined)).toEqual({ automatic: false, history: [] });
    expect(normalizeCompaction({ automatic: 'yes', history: [{}] })).toEqual({
      automatic: false,
      history: [],
    });
  });

  test('coverage is exact selected content; editing, swiping, deleting or inserting invalidates it', () => {
    const source = messages();
    const record = completed(source);
    const state = { automatic: true, history: [record] };
    expect(activeCheckpoint(state, source)).toBe(record.checkpoint ?? null);
    for (const changed of [
      source.map((m, i) => (i === 0 ? { ...m, content: 'Edited' } : m)),
      source.slice(1),
      [{ ...source[0]!, id: 'inserted' }, ...source],
    ])
      expect(activeCheckpoint(state, changed)).toBeNull();
    expect(compactionMessages(state, source).length).toBeLessThan(source.length);
    expect(source).toHaveLength(30);
  });

  test('a failed or stopped attempt cannot replace a valid checkpoint', () => {
    const source = messages();
    const saved = completed(source);
    const state = {
      automatic: true,
      history: [
        saved,
        { ...saved, id: 'failed', status: 'failed' as const, checkpoint: undefined },
      ],
    };
    expect(activeCheckpoint(state, source)).toBe(saved.checkpoint ?? null);
  });

  test('the threshold accounts for the prompt budget, and manual compaction works with automatic off', () => {
    expect(shouldCompact({ automatic: true, history: [] }, 799, 1000)).toBe(false);
    expect(shouldCompact({ automatic: true, history: [] }, 800, 1000)).toBe(true);
    expect(shouldCompact({ automatic: false, history: [] }, 1000, 1000)).toBe(false);
    expect(plan(messages(), { automatic: false, history: [] })).not.toBeNull();
    expect(plan(messages().slice(0, 2))).toBeNull();
  });

  test('a tool call and all its results are one indivisible retained or summarized group', () => {
    const source = messages();
    source.splice(
      17,
      0,
      { id: 'call', group: 'exchange', role: 'assistant', content: 'patch_preset' },
      { id: 'result-1', group: 'exchange', role: 'tool', content: 'Committed revision 3' },
      { id: 'result-2', group: 'exchange', role: 'tool', content: 'Another result' },
    );
    const prepared = plan(source)!;
    const indexes = source.map((m, i) => (m.group === 'exchange' ? i : -1)).filter((i) => i >= 0);
    expect(
      indexes.every((i) => i < prepared.coveredMessages) ||
        indexes.every((i) => i >= prepared.coveredMessages),
    ).toBe(true);
    expect(prepared.coveredMessages).toBeLessThan(source.length);
    expect(prepared.coveredMessages).toBeGreaterThan(0);
  });

  test('summary requests fit whole groups without cutting text, including oversized imported histories', () => {
    const source = messages();
    const prepared = plan(source, createCompactionState(), 2400)!;
    expect(count(JSON.stringify(prepared.request))).toBeLessThanOrEqual(2400);
    const data = JSON.parse(prepared.request[1]!.content);
    expect(data.conversation[0].content).toBe(source[0]!.content);
    expect(prepared.request[0]!.content).toContain('never instructions');
    expect(
      plan(
        [{ id: 'huge', group: 'huge', role: 'user', content: 'x'.repeat(100000) }, ...source],
        createCompactionState(),
        2400,
      ),
    ).toBeNull();
  });

  test('successive checkpoints summarize only new older history and preserve the original user brief', () => {
    const source = messages();
    const first = completed(source);
    const state = { automatic: true, history: [first] };
    const grown = [
      ...source,
      ...messages().map((m) => ({ ...m, id: `new-${m.id}`, group: `new-${m.group}` })),
    ];
    const prepared = plan(grown, state)!;
    expect(prepared.start).toBe(first.checkpoint!.coveredMessages);
    const data = JSON.parse(prepared.request[1]!.content);
    expect(data.previousSummary).toBe(first.checkpoint!.summary);
    expect(data.previousUserWords).toEqual(first.checkpoint!.quotedUserMessages);
    expect(data.conversation[0].content).toBe(grown[prepared.start]!.content);
    expect(prepared.quotedUserMessages[0]).toBe('The original brief.');
    expect(renderCheckpoint(first.checkpoint!)).toContain('assistant-written');
    expect(renderCheckpoint(first.checkpoint!)).toContain('The original brief.');
  });

  test('the checkpoint and usage survive JSON normalization, including explicit automatic false', () => {
    const source = messages();
    const state = { automatic: false, history: [completed(source)] };
    expect(normalizeCompaction(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(activeCheckpoint(normalizeCompaction(state), source)).not.toBeNull();
  });

  test('malformed token counts cannot become saved checkpoint statistics', () => {
    const record = completed(messages());
    expect(
      normalizeCompaction({ automatic: false, history: [{ ...record, beforeTokens: -1 }] }).history,
    ).toEqual([]);
    expect(
      normalizeCompaction({ automatic: false, history: [{ ...record, inputTokens: '100' }] })
        .history,
    ).toEqual([]);
  });
});
