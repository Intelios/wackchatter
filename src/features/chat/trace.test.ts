import { describe, expect, test } from 'bun:test';
import { markStream, settleTrace, type TraceMarks } from './trace.ts';

describe('a reply’s trace', () => {
  test('thinking, then text, each noted once', () => {
    const marks: TraceMarks = { start: 1000, sent: 1300 };
    markStream(marks, 1500, { content: '', reasoning: '' }, '');
    markStream(marks, 2100, { content: '', reasoning: 'hmm' }, '');
    markStream(marks, 2400, { content: '', reasoning: 'hmm, so' }, '');
    markStream(marks, 4000, { content: 'Hi', reasoning: 'hmm, so' }, '');
    markStream(marks, 4500, { content: 'Hi there', reasoning: 'hmm, so' }, '');
    expect(settleTrace(marks, 6000.4, 'finished', { reasoning_tokens: 90 })).toEqual({
      sent: 300,
      thinking: 1100,
      writing: 3000,
      end: 5000,
      outcome: 'finished',
      thinkingTokens: 90,
    });
  });

  test('a continue counts text only once it grows past where it started', () => {
    const marks: TraceMarks = { start: 0, sent: 10 };
    markStream(marks, 20, { content: 'Earlier text', reasoning: '' }, 'Earlier text');
    expect(marks.writing).toBeUndefined();
    markStream(marks, 30, { content: 'Earlier text and more', reasoning: '' }, 'Earlier text');
    expect(marks.writing).toBe(30);
  });

  test('reasoning that arrives after the text is not a thinking phase', () => {
    const marks: TraceMarks = { start: 0, sent: 10 };
    markStream(marks, 20, { content: 'Hi', reasoning: '' }, '');
    markStream(marks, 30, { content: 'Hi', reasoning: 'late' }, '');
    expect(marks.thinking).toBeUndefined();
  });

  test('a request that never went out was all preparation', () => {
    expect(settleTrace({ start: 0, lore: { ms: 4.4, fired: 2 } }, 80, 'failed')).toEqual({
      sent: 80,
      lore: { ms: 4, fired: 2 },
      end: 80,
      outcome: 'failed',
    });
  });
});
