import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '../prompt/defaults.ts';
import type { ApiMessage } from '../types/chat.ts';
import type { Preset } from '../types/preset.ts';
import {
  buildHeaders,
  buildRequestBody,
  completionsUrl,
  modelsUrl,
  parseModelList,
} from './request.ts';
import type { ConnectionSettings } from './types.ts';

const messages: ApiMessage[] = [
  { role: 'system', content: 'You are Seraphina.' },
  { role: 'user', content: 'Hello.' },
];

function connection(overrides: Partial<ConnectionSettings> = {}): ConnectionSettings {
  return {
    provider: 'custom',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    ...overrides,
  };
}

function build(preset: Partial<Preset> = {}, conn = connection(), extra = {}) {
  return buildRequestBody({
    messages,
    preset: { ...createDefaultPreset(), ...preset },
    connection: conn,
    stream: true,
    ...extra,
  });
}

describe('the base body', () => {
  test('carries the model, messages and stream flag', () => {
    const body = build();
    expect(body.model).toBe('test-model');
    expect(body.messages).toBe(messages);
    expect(body.stream).toBe(true);
  });

  test('samplers come from the preset', () => {
    const body = build({
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: -0.25,
    });
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(-0.25);
  });

  test('max_tokens comes from the preset, and the request overrides it', () => {
    expect(build({ openai_max_tokens: 512 }).max_tokens).toBe(512);
    expect(build({ openai_max_tokens: 512 }, connection(), { maxTokens: 32 }).max_tokens).toBe(32);
  });
});

describe('stop sequences', () => {
  test('an absent stop list leaves the key off entirely', () => {
    // hasOwn, not toEqual: `stop: undefined` would satisfy toEqual and still be
    // serialised as `"stop": null` by some JSON paths, which several backends 400 on.
    const body = build();
    expect(Object.hasOwn(body, 'stop')).toBe(false);
  });

  test('an empty stop list leaves the key off entirely', () => {
    const body = build({}, connection(), { stop: [] });
    expect(Object.hasOwn(body, 'stop')).toBe(false);
  });

  test('a populated stop list is sent', () => {
    const body = build({}, connection(), { stop: ['\nUser:'] });
    expect(body.stop).toEqual(['\nUser:']);
  });
});

describe('seed', () => {
  test('-1 means unset and is omitted', () => {
    expect(Object.hasOwn(build({ seed: -1 }), 'seed')).toBe(false);
  });

  test('zero is a real seed and is sent', () => {
    // The case a truthiness guard silently breaks.
    const body = build({ seed: 0 });
    expect(Object.hasOwn(body, 'seed')).toBe(true);
    expect(body.seed).toBe(0);
  });

  test('a positive seed is sent', () => {
    expect(build({ seed: 12345 }).seed).toBe(12345);
  });
});

describe('n', () => {
  test('several completions are asked for', () => {
    expect(build({}, connection(), { completions: 4 }).n).toBe(4);
  });

  test('one completion sends nothing — `n: 1` is the universal default', () => {
    expect(Object.hasOwn(build({}, connection(), { completions: 1 }), 'n')).toBe(false);
  });

  test('a caller that says nothing gets nothing', () => {
    expect(Object.hasOwn(build({}), 'n')).toBe(false);
  });

  // The safety property behind `completions` being a request field rather than a preset
  // read: a summary runs on the user's preset, and must not quietly pay for alternates
  // it has nowhere to put.
  test('preset.n alone never reaches the wire', () => {
    expect(Object.hasOwn(build({ n: 4 }), 'n')).toBe(false);
  });

  test('a fractional count is floored rather than sent as-is', () => {
    expect(build({}, connection(), { completions: 2.7 }).n).toBe(2);
  });
});

describe('provider-specific samplers', () => {
  const samplers = { top_k: 40, min_p: 0.05, top_a: 0.1, repetition_penalty: 1.1 };

  test('a plain OpenAI-compatible endpoint gets none of them, even when the preset sets them', () => {
    const body = build(samplers, connection({ provider: 'custom' }));
    for (const key of ['top_k', 'min_p', 'top_a', 'repetition_penalty']) {
      expect(Object.hasOwn(body, key)).toBe(false);
    }
  });

  test('OpenRouter gets all four', () => {
    const body = build(samplers, connection({ provider: 'openrouter' }));
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
    expect(body.top_a).toBe(0.1);
    expect(body.repetition_penalty).toBe(1.1);
  });
});

describe('OpenRouter routing', () => {
  test('no routing configured means no provider key at all — not an empty object', () => {
    const body = build({}, connection({ provider: 'openrouter' }));
    expect(Object.hasOwn(body, 'provider')).toBe(false);
    expect(Object.hasOwn(body, 'transforms')).toBe(false);
  });

  test('an order list nests allow_fallbacks inside provider, defaulting to true', () => {
    const body = build(
      {},
      connection({ provider: 'openrouter', routing: { order: ['Anthropic', 'Google'] } }),
    );
    expect(body.provider).toEqual({ order: ['Anthropic', 'Google'], allow_fallbacks: true });
  });

  test('allow_fallbacks false is honoured', () => {
    const body = build(
      {},
      connection({
        provider: 'openrouter',
        routing: { order: ['Anthropic'], allow_fallbacks: false },
      }),
    );
    expect((body.provider as Record<string, unknown>).allow_fallbacks).toBe(false);
  });

  test('quantizations alone still produce a provider object', () => {
    const body = build(
      {},
      connection({ provider: 'openrouter', routing: { quantizations: ['fp8'] } }),
    );
    expect(body.provider).toEqual({ quantizations: ['fp8'] });
  });

  test('middleOut becomes the transforms array', () => {
    const body = build({}, connection({ provider: 'openrouter', routing: { middleOut: true } }));
    expect(body.transforms).toEqual(['middle-out']);
  });

  test('routing is ignored for a plain endpoint', () => {
    const body = build({}, connection({ provider: 'custom', routing: { order: ['Anthropic'] } }));
    expect(Object.hasOwn(body, 'provider')).toBe(false);
  });
});

describe('reasoning and usage', () => {
  test('OpenRouter is asked to include reasoning by default', () => {
    const body = build({}, connection({ provider: 'openrouter' }));
    expect(body.reasoning).toEqual({ exclude: false });
  });

  test('showReasoning false excludes it', () => {
    const body = build({}, connection({ provider: 'openrouter', showReasoning: false }));
    expect(body.reasoning).toEqual({ exclude: true });
  });

  test('OpenRouter uses its own usage flag, not OpenAI stream_options', () => {
    const body = build({}, connection({ provider: 'openrouter', reportUsage: true }));
    expect(body.usage).toEqual({ include: true });
    expect(Object.hasOwn(body, 'stream_options')).toBe(false);
  });

  test('a plain endpoint uses stream_options, and only when asked', () => {
    expect(Object.hasOwn(build({}, connection()), 'stream_options')).toBe(false);
    const body = build({}, connection({ reportUsage: true }));
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('reasoning effort', () => {
  test('auto sends nothing, so unsupported models see an unchanged request', () => {
    const custom = build({ reasoning_effort: 'auto' });
    expect(Object.hasOwn(custom, 'reasoning_effort')).toBe(false);

    const openrouter = build({ reasoning_effort: 'auto' }, connection({ provider: 'openrouter' }));
    expect(openrouter.reasoning).toEqual({ exclude: false });
  });

  test('an absent effort sends nothing either', () => {
    const body = build({ reasoning_effort: undefined });
    expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
  });

  test('low, medium and high pass through on a plain endpoint', () => {
    expect(build({ reasoning_effort: 'low' }).reasoning_effort).toBe('low');
    expect(build({ reasoning_effort: 'medium' }).reasoning_effort).toBe('medium');
    expect(build({ reasoning_effort: 'high' }).reasoning_effort).toBe('high');
  });

  test('min and max are UI conveniences that resolve to low and high', () => {
    expect(build({ reasoning_effort: 'min' }).reasoning_effort).toBe('low');
    expect(build({ reasoning_effort: 'max' }).reasoning_effort).toBe('high');
  });

  test('OpenRouter nests effort inside its reasoning object', () => {
    const body = build({ reasoning_effort: 'medium' }, connection({ provider: 'openrouter' }));
    expect(body.reasoning).toEqual({ exclude: false, effort: 'medium' });
  });

  test('effort coexists with excluded reasoning on OpenRouter', () => {
    const body = build(
      { reasoning_effort: 'high' },
      connection({ provider: 'openrouter', showReasoning: false }),
    );
    expect(body.reasoning).toEqual({ exclude: true, effort: 'high' });
  });
});

describe('headers', () => {
  test('a key becomes a bearer token', () => {
    const headers = buildHeaders(connection(), 'sk-test', 'http://localhost:5173');
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  test('a null key produces no Authorization header at all', () => {
    // `Bearer null` makes llama.cpp and KoboldCpp reject a request they would serve.
    const headers = buildHeaders(connection(), null, 'http://localhost:5173');
    expect(Object.hasOwn(headers, 'authorization')).toBe(false);
  });

  test('OpenRouter gets its attribution headers', () => {
    const headers = buildHeaders(
      connection({ provider: 'openrouter' }),
      'sk-or-test',
      'http://localhost:5173',
    );
    expect(headers['HTTP-Referer']).toBe('http://localhost:5173');
    expect(headers['X-Title']).toBe('WackChatter');
  });

  test('a plain endpoint gets neither', () => {
    const headers = buildHeaders(connection(), 'sk-test', 'http://localhost:5173');
    expect(Object.hasOwn(headers, 'HTTP-Referer')).toBe(false);
    expect(Object.hasOwn(headers, 'X-Title')).toBe(false);
  });

  test('user headers are merged last so a proxy can override our auth', () => {
    const headers = buildHeaders(
      connection({ headers: { authorization: 'Custom abc', 'x-extra': '1' } }),
      'sk-test',
      'http://localhost:5173',
    );
    expect(headers.authorization).toBe('Custom abc');
    expect(headers['x-extra']).toBe('1');
  });
});

describe('urls', () => {
  test('the completions path is appended to the base', () => {
    expect(completionsUrl(connection())).toBe('https://api.example.com/v1/chat/completions');
  });

  test('trailing slashes and whitespace are tolerated', () => {
    expect(completionsUrl(connection({ baseUrl: '  https://api.example.com/v1//  ' }))).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  test('the models path uses the same base', () => {
    expect(modelsUrl(connection())).toBe('https://api.example.com/v1/models');
  });
});

describe('parsing a model list', () => {
  test('reads ids, names, context length and pricing', () => {
    const models = parseModelList({
      data: [
        {
          id: 'anthropic/claude-opus-4',
          name: 'Claude Opus 4',
          context_length: 200000,
          pricing: { prompt: '0.000015', completion: '0.000075' },
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'anthropic/claude-opus-4',
        name: 'Claude Opus 4',
        contextLength: 200000,
        promptPrice: 0.000015,
        completionPrice: 0.000075,
      },
    ]);
  });

  test('a bare OpenAI model list works without pricing', () => {
    const models = parseModelList({ data: [{ id: 'gpt-4o' }] });
    expect(models[0]).toEqual({ id: 'gpt-4o', name: 'gpt-4o' });
  });

  test('junk entries are dropped rather than throwing', () => {
    expect(parseModelList({ data: [null, {}, 'x', { id: 'ok' }] })).toEqual([
      { id: 'ok', name: 'ok' },
    ]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: 'nope' })).toEqual([]);
  });
});
