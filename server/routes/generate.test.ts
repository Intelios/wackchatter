import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeGenerations } from '../lib/generate.ts';
import { PATHS, setDataDir } from '../lib/paths.ts';
import { resetSettingsCache } from '../lib/settings.ts';
import { handleGenerateRoute } from './generate.ts';

const realFetch = globalThis.fetch;
let originalDir: string;
let directory: string;
let quietDebug: ReturnType<typeof spyOn>;
const calls: { url: string; headers: Headers; body: unknown; signal: AbortSignal | null }[] = [];

beforeEach(() => {
  originalDir = PATHS.root;
  directory = mkdtempSync(join(tmpdir(), 'wc-opencode-'));
  setDataDir(directory);
  resetSettingsCache();
  writeFileSync(
    PATHS.settings,
    JSON.stringify({
      connectionId: 'go',
      connections: [
        {
          id: 'go',
          name: 'Go',
          provider: 'custom',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          model: 'test-model',
        },
      ],
    }),
  );
  quietDebug = spyOn(console, 'debug').mockImplementation(() => {});
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal ?? null,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  quietDebug.mockRestore();
  setDataDir(originalDir);
  resetSettingsCache();
  rmSync(directory, { recursive: true, force: true });
});

function request(payload: unknown): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('OpenCode generation proxy', () => {
  test('forwards stable conversation headers without changing the completion payload or abort signal', async () => {
    const body = {
      model: 'test-model',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    };
    for (const sessionId of ['chat-1', 'chat-1', 'chat-2']) {
      const incoming = request({ body, connectionId: 'go', sessionId });
      const response = await handleGenerateRoute(incoming, []);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ choices: [{ message: { content: 'hello' } }] });
      const call = calls.at(-1)!;
      expect(call.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect(call.headers.get('x-opencode-session')).toBe(sessionId);
      expect(call.headers.get('user-agent')).toBe('WackChatter');
      expect(call.headers.has('authorization')).toBe(false);
      expect(call.body).toEqual(body);
      expect(call.signal).toBe(incoming.signal);
      expect(activeGenerations()).toBe(0);
    }
  });

  test.each([null, 1, {}, '', ' ', 'chat 1', 'chat\r\nx-injected: value', '会話', 'x'.repeat(257)])(
    'rejects invalid session ids before making an upstream call: %j',
    async (sessionId) => {
      const response = await handleGenerateRoute(
        request({ body: { model: 'test-model' }, sessionId }),
        [],
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: expect.stringContaining('sessionId') });
      expect(calls).toEqual([]);
      expect(activeGenerations()).toBe(0);
    },
  );
});
