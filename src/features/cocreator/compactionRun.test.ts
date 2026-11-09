import { afterEach, describe, expect, test } from 'bun:test';
import { makeCompactionPlan } from '@shared/cocreator/compaction.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { ChatCompletionBody } from '@shared/providers/types.ts';
import { runCompaction } from './compactionRun.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const model = {
  id: 'selected-connection',
  name: 'Selected',
  model: 'selected-model',
  provider: 'custom' as const,
  baseUrl: 'http://local',
};
const plan = makeCompactionPlan({
  kind: 'preset',
  maxPromptTokens: 10000,
  countText: (text) => Math.ceil(text.length / 4),
  messages: Array.from({ length: 12 }, (_, i) => ({
    id: `${i}`,
    group: `${i}`,
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: 'Design detail. '.repeat(100),
  })),
})!;
const options = (signal = new AbortController().signal) => ({
  plan,
  model,
  preset: createDefaultPreset(),
  signal,
  sessionId: 'design-session',
  feature: 'presetCocreator' as const,
  countText: (text: string) => Math.ceil(text.length / 4),
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('Co-Creator compaction generation', () => {
  test('uses the selected model and session, no tools or app output cap, and records provider usage in the ledger', async () => {
    const sent: { body: ChatCompletionBody; connectionId: string; sessionId: string }[] = [];
    const ledger: { id: string; sessionId: string; inputTokens: number; outputTokens: number }[] =
      [];
    globalThis.fetch = (async (url, init) => {
      if (url === '/api/usage') {
        ledger.push(JSON.parse(String(init?.body)));
        return json({ ok: true });
      }
      sent.push(JSON.parse(String(init?.body)));
      return json({
        choices: [
          {
            message: { content: 'Goal: preserve restrained prose. No test has run.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3000, completion_tokens: 20 },
      });
    }) as typeof fetch;
    const record = await runCompaction({ ...options(), streaming: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      connectionId: model.id,
      sessionId: 'design-session',
      body: { model: model.model },
    });
    expect(sent[0]!.body).not.toHaveProperty('max_tokens');
    expect(sent[0]!.body).not.toHaveProperty('tools');
    expect(sent[0]!.body.stream).toBe(false);
    expect(record).toMatchObject({
      status: 'complete',
      model: { connectionId: model.id, modelId: model.model },
      inputTokens: 3000,
      outputTokens: 20,
    });
    expect(record.checkpoint?.throughId).toBe(plan.throughId);
    expect(ledger).toMatchObject([
      { id: record.id, sessionId: 'design-session', inputTokens: 3000, outputTokens: 20 },
    ]);
  });

  test('cut-off, empty and failed summaries never establish coverage and never retry automatically', async () => {
    for (const response of [
      {
        choices: [{ message: { content: 'Incomplete summary' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      },
      { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: 'Filtered summary' }, finish_reason: 'content_filter' }] },
      {
        choices: [
          {
            message: {
              content: 'I will call a tool',
              tool_calls: [
                { id: 'bad', type: 'function', function: { name: 'read_preset', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { error: { message: 'Provider unavailable' } },
    ]) {
      let generations = 0;
      globalThis.fetch = (async (url) => {
        if (url === '/api/usage') return json({ ok: true });
        generations++;
        return json(response);
      }) as typeof fetch;
      const record = await runCompaction(options());
      expect(generations).toBe(1);
      expect(record.status).toBe('failed');
      expect(record.checkpoint).toBeUndefined();
      if ('usage' in response) expect(record.outputTokens).toBe(10);
    }
  });

  test('Stop retains received usage but discards the partial summary; a pre-aborted attempt never contacts a provider', async () => {
    const controller = new AbortController();
    let generations = 0;
    globalThis.fetch = (async (url) => {
      if (url === '/api/usage') return json({ ok: true });
      generations++;
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial summary' } }], usage: { prompt_tokens: 1000, completion_tokens: 3 } })}\n\n`,
              ),
            );
            setTimeout(() => controller.abort(), 0);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const record = await runCompaction(options(controller.signal));
    expect(record).toMatchObject({ status: 'aborted', inputTokens: 1000, outputTokens: 3 });
    expect(record.checkpoint).toBeUndefined();
    const preAborted = await runCompaction(options(controller.signal));
    expect(preAborted.status).toBe('aborted');
    expect(generations).toBe(1);
  });
});
