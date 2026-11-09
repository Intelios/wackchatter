import { afterEach, expect, test } from 'bun:test';
import { contextOrDefault } from '@shared/models/context.ts';
import { resolveModelContext } from './modelContext.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a stopped context lookup releases its waiter without cancelling the shared catalogue', async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;
  const model = {
    id: crypto.randomUUID(),
    name: 'Test',
    provider: 'custom' as const,
    baseUrl: 'http://local',
    model: 'm',
  };
  const controller = new AbortController();
  const stopped = resolveModelContext(model, controller.signal);
  const stillReading = resolveModelContext(model);
  controller.abort();
  await expect(stopped).rejects.toThrow('aborted');
  finish(Response.json({ models: [{ id: 'm', contextLength: 32768 }] }));
  expect(await stillReading).toBe(32768);
  expect(calls).toBe(1);
});

test('a pre-aborted lookup does not fetch, and an unknown model retains the documented fallback', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ models: [] });
  }) as unknown as typeof fetch;
  const model = {
    id: crypto.randomUUID(),
    name: 'Test',
    provider: 'custom' as const,
    baseUrl: 'http://local',
    model: 'unknown',
  };
  const controller = new AbortController();
  controller.abort();
  await expect(resolveModelContext(model, controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await resolveModelContext(model)).toBe(contextOrDefault(null));
});
