import { describe, expect, test } from 'bun:test';
import { createStreamAccumulator, parseCompletion } from '@shared/providers/sse.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import { runGeneration } from '../../lib/generation.ts';
import { assistantResponseMessage, assistantWireMessages } from './assistant.ts';

const model: ResolvedModel = {
  id: 'deepseek',
  name: 'DeepSeek',
  provider: 'custom',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
};
const tool = {
  id: 'read',
  type: 'function' as const,
  function: { name: 'read_preset', arguments: '{}' },
};
const result: PresetCocreatorMessage = {
  id: 'result',
  role: 'tool',
  content: '{"revision":0}',
  created: 2,
  toolCallId: 'read',
};
function saved(fields: Record<string, unknown>, source = model) {
  return assistantResponseMessage(
    parseCompletion({
      model: 'provider-canonical-model',
      choices: [
        {
          message: { content: 'I will inspect it.', tool_calls: [tool], ...fields },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    undefined,
    source,
  );
}
function wire(message: PresetCocreatorMessage, target = model) {
  return assistantWireMessages([message, result], [], target)[0];
}

describe('Preset Co-Creator provider reasoning replay', () => {
  test('a reasoning endpoint accepts the actual follow-up body after a streamed tool response', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests += 1;
      if (requests === 1) {
        const frames = [
          { choices: [{ delta: { reasoning_content: 'Inspect the draft.' } }] },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: 'tool_calls' },
            ],
          },
        ];
        return new Response(
          `${frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      }
      const request = JSON.parse(String(init?.body));
      if (request.body.messages[0].reasoning_content !== 'Inspect the draft.') {
        return new Response(JSON.stringify({ error: 'reasoning_content must be passed back' }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Draft inspected.' }, finish_reason: 'stop' }],
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    try {
      const signal = new AbortController().signal;
      const first = await runGeneration({
        model,
        signal,
        body: { messages: [] },
        onTick: () => {},
      });
      const message = JSON.parse(
        JSON.stringify(assistantResponseMessage(first, undefined, model)),
      ) as PresetCocreatorMessage;
      const second = await runGeneration({
        model,
        signal,
        body: { messages: assistantWireMessages([message, result], [], model) },
        onTick: () => {},
      });
      expect(second.content).toBe('Draft inspected.');
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('streamed reasoning_content survives saving and the next tool request without usage reporting', () => {
    const accumulator = createStreamAccumulator();
    for (const delta of [
      { reasoning_content: 'Inspect ' },
      { reasoning_content: 'the draft.' },
      { tool_calls: [{ index: 0, ...tool }] },
    ]) {
      accumulator.push({
        data: JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }] }),
      });
    }
    const message = assistantResponseMessage(accumulator.snapshot(), undefined, model);
    const reloaded = JSON.parse(JSON.stringify(message)) as PresetCocreatorMessage;
    expect(reloaded.usage).toBeUndefined();
    expect(wire(reloaded)).toMatchObject({
      reasoning_content: 'Inspect the draft.',
      tool_calls: [tool],
    });
    expect(reloaded.providerSource).toEqual({
      connectionId: model.id,
      modelId: model.model,
      provider: model.provider,
      baseUrl: model.baseUrl,
    });
  });

  test('the exact explicit field is replayed, preserving empty strings', () => {
    for (const field of ['reasoning', 'reasoning_content', 'reasoning_text']) {
      for (const content of ['', 'Original thought']) {
        expect(wire(saved({ [field]: content }))).toHaveProperty(field, content);
      }
    }
  });

  test('explicit reasoning is replayed for finished text-only turns too', () => {
    const message = assistantResponseMessage(
      parseCompletion({
        choices: [
          {
            message: { content: 'Finished.', reasoning_content: 'Final reasoning' },
            finish_reason: 'stop',
          },
        ],
      }),
      undefined,
      model,
    );
    expect(assistantWireMessages([message], [], model)[0]).toMatchObject({
      reasoning_content: 'Final reasoning',
    });
  });

  test('structured reasoning is preferred over a duplicate text mirror', () => {
    const details = [{ type: 'reasoning.text', text: 'Thought', signature: 'opaque' }];
    const source = {
      ...model,
      provider: 'openrouter' as const,
      baseUrl: 'https://openrouter.ai/api/v1',
    };
    const message = saved({ reasoning: 'Thought', reasoning_details: details }, source);
    const replay = wire(message, source);
    expect(replay).toHaveProperty('reasoning_details', details);
    expect(replay).not.toHaveProperty('reasoning');
    expect(message.reasoningFields).toEqual({ reasoning: 'Thought' });
  });

  test('custom endpoints use reasoning_content when both aliases describe the same thought', () => {
    const replay = wire(saved({ reasoning: 'Mirror', reasoning_content: 'Original' }));
    expect(replay).toHaveProperty('reasoning_content', 'Original');
    expect(replay).not.toHaveProperty('reasoning');
  });

  test('changing model, connection, provider or endpoint removes old opaque provider state', () => {
    const message = saved({
      reasoning_content: 'Thought',
      reasoning_details: [{ data: 'encrypted' }],
      extra_content: { google: { thought_signature: 'message-signature' } },
      tool_calls: [{ ...tool, extra_content: { google: { thought_signature: 'tool-signature' } } }],
    });
    const original = structuredClone(message);
    for (const target of [
      { ...model, model: 'other-model' },
      { ...model, id: 'another-connection' },
      { ...model, provider: 'openrouter' as const },
      { ...model, baseUrl: 'https://other.example/v1' },
    ]) {
      const replay = wire(message, target);
      expect(replay).not.toHaveProperty('reasoning_details');
      expect(replay).not.toHaveProperty('extra_content');
      expect(replay).not.toHaveProperty('reasoning_content', 'Thought');
      expect(replay).toHaveProperty('tool_calls', [tool]);
    }
    expect(message).toEqual(original);
    expect(wire(message)).toHaveProperty('reasoning_details', [{ data: 'encrypted' }]);
  });

  test('trailing slashes do not change the endpoint identity and response aliases do not change the requested model', () => {
    expect(
      wire(saved({ reasoning_content: 'Thought' }), { ...model, baseUrl: `${model.baseUrl}/` }),
    ).toHaveProperty('reasoning_content', 'Thought');
  });

  test('inline thought tags and interrupted partial reasoning are never guessed as replay state', () => {
    const inline = saved(
      { content: '<think>Visible thought</think>Answer' },
      { ...model, baseUrl: 'https://custom.example/v1' },
    );
    expect(wire(inline, { ...model, baseUrl: 'https://custom.example/v1' })).not.toHaveProperty(
      'reasoning_content',
    );
    const partial = {
      ...saved({ reasoning_content: 'Incomplete thought' }),
      incomplete: 'stopped' as const,
    };
    expect(wire(partial)).not.toHaveProperty('reasoning_content', 'Incomplete thought');
    expect(partial.reasoningFields?.reasoning_content).toBe('Incomplete thought');
  });

  test('known legacy DeepSeek reasoning can be recovered from its recorded usage origin', () => {
    const message: PresetCocreatorMessage = {
      id: 'old',
      role: 'assistant',
      content: 'Answer',
      created: 1,
      reasoning: 'Saved thought',
      usage: { connectionId: model.id, model: model.model, inputTokens: 1, outputTokens: 1 },
    };
    expect(wire(message)).toHaveProperty('reasoning_content', 'Saved thought');
    expect(wire({ ...message, usage: undefined })).toHaveProperty('reasoning_content', '');
    expect(
      wire(message, { ...model, baseUrl: 'https://api.deepseek.com.attacker.example/v1' }),
    ).not.toHaveProperty('reasoning_content');
  });

  test('the saved source contains no connection headers or other settings', () => {
    const message = saved(
      { reasoning_content: 'Thought' },
      {
        ...model,
        headers: { Authorization: 'private-header' },
        routing: { order: ['private-route'] },
      },
    );
    expect(JSON.stringify(message.providerSource)).not.toContain('private');
    expect(message.providerSource).not.toHaveProperty('headers');
    expect(message.providerSource).not.toHaveProperty('routing');
  });

  test('a malformed legacy tool exchange cannot replay raw reasoning after its calls are removed', () => {
    const message = saved({
      reasoning_content: 'Invalid exchange',
      tool_calls: [{ ...tool, id: '' }],
    });
    // Reproduce the older shape that saved malformed calls without an incomplete flag.
    message.toolCalls = message.incompleteToolCalls;
    delete message.incomplete;
    delete message.incompleteToolCalls;
    const payload = wire(message);
    expect(payload).not.toHaveProperty('tool_calls');
    expect(payload).not.toHaveProperty('reasoning_content', 'Invalid exchange');
    expect(message.reasoningFields?.reasoning_content).toBe('Invalid exchange');
  });
});
