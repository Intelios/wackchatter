import { afterEach, describe, expect, test } from 'bun:test';
import { streamGenerate } from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const signal = new AbortController().signal;
const noop = { onTick: () => {} };

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

describe('streamGenerate', () => {
  test('a non-streamed completion returns its content', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ choices: [{ message: { content: 'hello' } }] })) as unknown as typeof fetch;

    const state = await streamGenerate({}, signal, noop);
    expect(state.content).toBe('hello');
    expect(state.error).toBeUndefined();
  });

  test('a completion-shaped error in a 200 non-stream body throws', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'provider exploded' } })) as unknown as typeof fetch;

    expect(streamGenerate({}, signal, noop)).rejects.toThrow('provider exploded');
  });

  test('a non-200 response throws with the provider message', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'overloaded' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    expect(streamGenerate({}, signal, noop)).rejects.toThrow('overloaded');
  });

  test('a streamed completion returns its accumulated content', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      ])) as unknown as typeof fetch;

    const state = await streamGenerate({}, signal, noop);
    expect(state.content).toBe('hello');
    expect(state.error).toBeUndefined();
  });

  test('an error frame inside a 200 stream throws', async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        JSON.stringify({ error: { message: 'rate limited' } }),
      ])) as unknown as typeof fetch;

    expect(streamGenerate({}, signal, noop)).rejects.toThrow('rate limited');
  });

  test('the non-stream error does not reach the tick handler', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'provider exploded' } })) as unknown as typeof fetch;

    const ticks: unknown[] = [];
    let firstToken = false;
    await expect(
      streamGenerate({}, signal, {
        onTick: (state) => ticks.push(state),
        onFirstToken: () => {
          firstToken = true;
        },
      }),
    ).rejects.toThrow('provider exploded');
    expect(ticks).toEqual([]);
    expect(firstToken).toBe(false);
  });
});
