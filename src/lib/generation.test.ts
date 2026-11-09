import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatCompletionBody, ResolvedModel } from '@shared/providers/types.ts';
import {
  GenerationSlot,
  isAbortError,
  runGeneration,
  type StreamHandlers,
  type UsageMeta,
} from './generation.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const signal = new AbortController().signal;
const noop = { onTick: () => {} };

const model = (id = 'test-connection', name = 'test-model'): ResolvedModel => ({
  id,
  name: 'Test',
  provider: 'custom',
  baseUrl: 'http://localhost/v1',
  model: name,
});

function run(
  body: ChatCompletionBody,
  handlers: StreamHandlers = noop,
  options: { model?: ResolvedModel; usage?: UsageMeta } = {},
) {
  return runGeneration({
    model: options.model ?? model(),
    body,
    signal,
    ...handlers,
    ...(options.usage ? { usage: options.usage } : {}),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const data of frames) {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('runGeneration', () => {
  test('a non-streamed completion returns its content', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: 'hello' } }] })) as unknown as typeof fetch;

    const state = await run({});
    expect(state.content).toBe('hello');
    expect(state.error).toBeUndefined();
  });

  test('the model’s connection travels beside the body, and the body runs on that model', async () => {
    let payload: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse({ choices: [{ message: { content: 'summary' } }] });
    }) as unknown as typeof fetch;

    // Built against another model: the one it was asked to run on wins.
    await run({ model: 'stale', temperature: 1 }, noop, {
      model: model('summary-connection', 'summary-model'),
    });
    expect(payload).toEqual({
      body: { model: 'summary-model', temperature: 1 },
      connectionId: 'summary-connection',
    });
  });

  test('conversation ids travel beside the body, independently of per-request generation ids', async () => {
    const posted: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/generate') {
        posted.push(JSON.parse(String(init?.body)));
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const body = { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }] };
    const features = ['chat', 'summary', 'memory'] as const;
    for (const [i, feature] of features.entries()) {
      await run(body, noop, {
        model: model('go-connection'),
        usage: {
          feature,
          sessionId: i === 2 ? 'chat-2' : 'chat-1',
          generationId: `generation-${i}`,
          countText: () => 1,
        },
      });
    }
    expect(posted).toEqual([
      { body, connectionId: 'go-connection', sessionId: 'chat-1' },
      { body, connectionId: 'go-connection', sessionId: 'chat-1' },
      { body, connectionId: 'go-connection', sessionId: 'chat-2' },
    ]);
  });

  test('a streamed request also forwards its session', async () => {
    let payload: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/generate') {
        payload = JSON.parse(String(init?.body));
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }),
        ]);
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await run({ stream: true }, noop, {
      usage: { feature: 'chat', sessionId: 'chat-1', countText: () => 1 },
    });
    expect(payload).toEqual({
      body: { stream: true, model: 'test-model' },
      connectionId: 'test-connection',
      sessionId: 'chat-1',
    });
  });

  test('a completion-shaped error in a 200 non-stream body throws', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'provider exploded' } })) as unknown as typeof fetch;

    expect(run({})).rejects.toThrow('provider exploded');
  });

  test('a non-200 response throws with the provider message', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'overloaded' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    expect(run({})).rejects.toThrow('overloaded');
  });

  test('a streamed completion returns its accumulated content', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        '[DONE]',
      ])) as unknown as typeof fetch;

    const state = await run({});
    expect(state.content).toBe('hello');
    expect(state.error).toBeUndefined();
  });

  test('reasoning starts the visible stream before ordinary content arrives', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '', reasoning: 'Thinking…' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch;

    const ticks: string[] = [];
    let firstToken = 0;
    await run(
      {},
      {
        onFirstToken: () => {
          firstToken += 1;
        },
        onTick: (state) => ticks.push(`${state.reasoning}|${state.content}`),
      },
    );

    expect(firstToken).toBe(1);
    expect(ticks[0]).toBe('Thinking…|');
    expect(ticks.at(-1)).toBe('Thinking…|answer');
  });

  test('an error frame inside a 200 stream throws', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ error: { message: 'rate limited' } }),
      ])) as unknown as typeof fetch;

    expect(run({})).rejects.toThrow('rate limited');
  });

  test('EOF during an ordinary answer is an error and preserves the received words', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'The rest of my' } }] }),
      ])) as unknown as typeof fetch;
    const ticks: string[] = [];
    await expect(run({}, { onTick: (state) => ticks.push(state.content) })).rejects.toThrow(
      'before confirming the reply was complete',
    );
    expect(ticks.at(-1)).toBe('The rest of my');
  });

  test('EOF after complete-looking tool JSON still fails before the tools can run', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: { name: 'read_preset', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      ])) as unknown as typeof fetch;
    await expect(run({})).rejects.toThrow('before confirming the reply was complete');
  });

  test('a finish reason completes a stream even when the provider omits DONE', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Complete.' }, finish_reason: 'stop' }] }),
      ])) as unknown as typeof fetch;
    expect((await run({})).content).toBe('Complete.');
  });

  test('a finish reason on one alternate cannot hide a truncated other choice', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({
          choices: [
            { index: 0, delta: { content: 'Complete.' }, finish_reason: 'stop' },
            { index: 1, delta: { content: 'The other answer' } },
          ],
        }),
      ])) as unknown as typeof fetch;
    await expect(run({})).rejects.toThrow('before confirming the reply was complete');
  });

  test('an unconfirmed stream is logged as failed and keeps its usage', async () => {
    const reports: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/usage') {
        reports.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true });
      }
      return sseResponse([
        JSON.stringify({
          choices: [{ delta: { content: 'Partial' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      ]);
    }) as unknown as typeof fetch;
    await expect(run({}, noop, { usage: { feature: 'presetCocreator' } })).rejects.toThrow(
      'before confirming the reply was complete',
    );
    expect(reports).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        aborted: false,
        inputTokens: 10,
        outputTokens: 2,
      }),
    ]);
  });

  test('the non-stream error does not reach the tick handler', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'provider exploded' } })) as unknown as typeof fetch;

    const ticks: unknown[] = [];
    let firstToken = false;
    await expect(
      run(
        {},
        {
          onTick: (state) => ticks.push(state),
          onFirstToken: () => {
            firstToken = true;
          },
        },
      ),
    ).rejects.toThrow('provider exploded');
    expect(ticks).toEqual([]);
    expect(firstToken).toBe(false);
  });

  test('usage reporting uses meta.countText for estimated output tokens', async () => {
    const posted: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/usage')) {
        posted.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ choices: [{ message: { content: 'hello world' } }] });
    }) as unknown as typeof fetch;

    await run({}, noop, {
      usage: {
        feature: 'memory',
        sessionId: 'chat-1',
        countText: (text) => text.split(' ').length * 10,
      },
    });

    expect(posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      feature: 'memory',
      sessionId: 'chat-1',
      connectionId: 'test-connection',
      outputTokens: 20,
      estimated: true,
    });
  });
});

test('isAbortError tells a stop from a failure', () => {
  expect(isAbortError(new DOMException('stopped', 'AbortError'))).toBe(true);
  expect(isAbortError(new Error('provider exploded'))).toBe(false);
  expect(isAbortError(null)).toBe(false);
});

/** Every client source file, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test('the generation service is the only way to the generate proxy', () => {
  const root = join(import.meta.dir, '..');
  const offenders = sources(root).filter((path) => {
    if (path === join(import.meta.dir, 'generation.ts')) return false;
    const text = readFileSync(path, 'utf8');
    // The URL as a string literal — prose in a comment naming the route is fine.
    return /['"`](\/api)?\/generate['"`]/.test(text);
  });
  expect(offenders).toEqual([]);
});

describe('GenerationSlot', () => {
  test('a claim owns the slot until a newer claim replaces it', () => {
    const slot = new GenerationSlot();
    const first = slot.claim();
    expect(slot.busy).toBe(true);
    expect(first.owns()).toBe(true);
    const second = slot.claim();
    expect(first.owns()).toBe(false);
    // The stale claim's cleanup must not free the newer one's slot.
    expect(first.release()).toBe(false);
    expect(slot.busy).toBe(true);
    expect(second.release()).toBe(true);
    expect(slot.busy).toBe(false);
  });

  test('ownership also ends when the claim’s context moves on', () => {
    const slot = new GenerationSlot();
    let chatId = 'a';
    const claim = slot.claim(() => chatId === 'a');
    chatId = 'b';
    expect(claim.owns()).toBe(false);
    expect(claim.ensureActive()).toBe(false);
    // The slot itself is still held, and its holder may still release it.
    expect(claim.release()).toBe(true);
  });

  test('Stop aborts the holder, which then settles as stopped', () => {
    const slot = new GenerationSlot();
    const claim = slot.claim();
    expect(claim.live()).toBe(true);
    slot.abort();
    expect(claim.signal.aborted).toBe(true);
    expect(claim.live()).toBe(false);
    expect(() => claim.ensureActive()).toThrow('aborted');
    expect(slot.busy).toBe(true);
  });
});
