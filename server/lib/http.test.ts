import { describe, expect, test } from 'bun:test';
import { contentDisposition, errorResponse, handle, json, notFound, readJson } from './http.ts';

describe('contentDisposition', () => {
  test('formats ASCII filename properly', () => {
    expect(contentDisposition('Default.json')).toBe(
      'attachment; filename="Default.json"; filename*=UTF-8\'\'Default.json',
    );
  });

  test('encodes UTF-8 filename with ASCII fallback (Café Preset)', () => {
    expect(contentDisposition('Café Preset.json')).toBe(
      'attachment; filename="Caf Preset.json"; filename*=UTF-8\'\'Caf%C3%A9%20Preset.json',
    );
  });

  test('falls back to export.ext when filename has only non-ASCII characters before extension', () => {
    expect(contentDisposition('☕.json')).toBe(
      'attachment; filename="export.json"; filename*=UTF-8\'\'%E2%98%95.json',
    );
    expect(contentDisposition('猫娘.png')).toBe(
      'attachment; filename="export.png"; filename*=UTF-8\'\'%E7%8C%AB%E5%A8%98.png',
    );
  });

  test('falls back to export when filename has only non-ASCII characters without extension', () => {
    expect(contentDisposition('☕')).toBe(
      'attachment; filename="export"; filename*=UTF-8\'\'%E2%98%95',
    );
  });

  test('encodes RFC 5987 special characters like single quotes, parentheses and asterisks', () => {
    expect(contentDisposition("Jack's (Special) *Star*.json")).toBe(
      'attachment; filename="Jacks Special Star.json"; filename*=UTF-8\'\'Jack%27s%20%28Special%29%20%2AStar%2A.json',
    );
  });

  test('supports inline disposition type', () => {
    expect(contentDisposition('Café Preset.json', 'inline')).toBe(
      'inline; filename="Caf Preset.json"; filename*=UTF-8\'\'Caf%C3%A9%20Preset.json',
    );
  });
});

describe('http helpers', () => {
  test('json sets application/json with utf-8 charset', async () => {
    const res = json({ hello: 'world' });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  test('errorResponse sets status code and error field', async () => {
    const res = errorResponse('Bad request', 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request' });
  });

  test('notFound returns 404', async () => {
    const res = notFound('Missing item');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Missing item' });
  });

  test('readJson parses valid JSON and returns null for invalid JSON', async () => {
    const valid = new Request('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(await readJson<{ a: number }>(valid)).toEqual({ a: 1 });

    const invalid = new Request('http://localhost/test', {
      method: 'POST',
      body: 'invalid json',
      headers: { 'content-type': 'application/json' },
    });
    expect(await readJson(invalid)).toBeNull();
  });

  test('handle catches error and returns 500 error response', async () => {
    const res = await handle(() => {
      throw new Error('Boom');
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Boom' });
  });
});
