import { describe, expect, test } from 'bun:test';
import type { ChatReasoningEfforts } from '@shared/models/reasoning.ts';
import { DEFAULT_NEXUS } from '@shared/nexus/types.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { StreamState } from '@shared/providers/sse.ts';
import type { ResolvedModel } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ApiMessage } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import {
  type ChatRequestInput,
  completionsFor,
  continueSeed,
  prepareChatRequest,
  recordReply,
} from './chatRequest.ts';
import {
  type ChatState,
  chatReducer,
  type GenMode,
  initialChatState,
} from './state/chatReducer.ts';

const countText = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const countTokens: TokenCounter = {
  countText,
  countChat: (messages: readonly ApiMessage[]) =>
    messages.reduce((total, message) => total + countText(message.content), 0),
};

const model: ResolvedModel = {
  id: 'conn',
  name: 'Conn',
  provider: 'openrouter',
  baseUrl: 'https://example.test/v1',
  model: 'vendor/model',
};

const character: CardDataV2 = {
  name: 'Seraphina',
  description: 'A forest guardian.',
  personality: '',
  scenario: '',
  first_mes: 'Welcome.',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
};

/** A greeting and user turn, plus a reply when the mode needs one, ready to generate. */
function started(mode: GenMode = 'send'): ChatState {
  const loaded = chatReducer(initialChatState, {
    type: 'chat/loaded',
    chat: {
      id: 'c1',
      characterId: 'Seraphina.png',
      title: 'T',
      created: 0,
      modified: 0,
      revision: 0,
      metadata: { persona: null },
      messages: [
        {
          id: 'g',
          name: 'Seraphina',
          is_user: false,
          is_system: false,
          mes: 'Welcome.',
          send_date: '',
        },
        {
          id: 'u',
          name: 'User',
          is_user: true,
          is_system: false,
          mes: 'Hello there.',
          send_date: '',
        },
        ...(mode !== 'send' && mode !== 'impersonate'
          ? [
              {
                id: 'a',
                name: 'Seraphina',
                is_user: false,
                is_system: false,
                mes: 'The forest stirs.',
                send_date: '',
              },
            ]
          : []),
      ],
    },
  });
  return chatReducer(loaded, { type: 'gen/started', mode, newId: 'p', name: 'Seraphina' });
}

function input(overrides: Partial<ChatRequestInput> = {}): ChatRequestInput {
  return {
    mode: 'send',
    started: started(),
    model,
    preset: createDefaultPreset(),
    character,
    persona: null,
    lore: null,
    nexusRecall: undefined,
    memoryMode: 'off',
    nexusSettings: DEFAULT_NEXUS,
    globalVariables: {},
    countTokens,
    ...overrides,
  };
}

describe('prepareChatRequest', () => {
  test('the body runs on the resolved model and the inspection carries it', () => {
    const request = prepareChatRequest(input());
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.body.model).toBe('vendor/model');
    expect(request.inspection.body).toBe(request.body);
    expect(request.inspection.generationType).toBe('normal');
    // The empty placeholder excludes the reply being written from its own prompt.
    const contents = request.assembled.messages.map((m) => m.content);
    expect(contents).toContain('Hello there.');
  });

  test('impersonation appends the preset’s control prompt dead last', () => {
    const preset: Preset = { ...createDefaultPreset(), impersonation_prompt: 'Write as {{user}}.' };
    const request = prepareChatRequest(
      input({ mode: 'impersonate', started: started('impersonate'), preset }),
    );
    expect(request.ok && request.assembled.messages.at(-1)?.content).toBe('Write as User.');
  });

  test('a cleared impersonation prompt sends no control at all', () => {
    const preset: Preset = { ...createDefaultPreset(), impersonation_prompt: '' };
    const request = prepareChatRequest(
      input({ mode: 'impersonate', started: started('impersonate'), preset }),
    );
    expect(request.ok && request.assembled.messages.at(-1)?.content).toBe('Hello there.');
  });

  test('a prompt that cannot fit fails with an inspectable overflow and no body', () => {
    const preset: Preset = {
      ...createDefaultPreset(),
      openai_max_context: 10,
      openai_max_tokens: 5,
    };
    const request = prepareChatRequest(input({ preset }));
    expect(request.ok).toBe(false);
    if (request.ok) return;
    expect(request.message).toContain('Context overflow');
    expect(request.inspection.body).toBeNull();
    expect(request.inspection.overflow).toBeDefined();
  });
});

describe('chat reasoning effort overrides', () => {
  function request(overrides: Partial<ChatRequestInput> = {}) {
    const prepared = prepareChatRequest(input(overrides));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.message);
    // Inspection shows the actual body, including provider-specific effort handling.
    expect(prepared.inspection.body).toBe(prepared.body);
    expect(prepared.body.messages).toBe(prepared.assembled.messages);
    return prepared;
  }

  const samplers = {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    min_p: 0.05,
    top_a: 0.1,
    repetition_penalty: 1.1,
    frequency_penalty: 0.5,
    presence_penalty: -0.25,
  };
  const extraSamplers = ['top_k', 'min_p', 'top_a', 'repetition_penalty'];
  const claude: ResolvedModel = { ...model, model: 'anthropic/claude-sonnet-4.5' };
  const google: ResolvedModel = {
    ...model,
    provider: 'custom',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
  };

  test('switching model or connection selects only that pair’s saved effort', () => {
    const efforts: ChatReasoningEfforts = Object.freeze({
      conn: Object.freeze({ 'vendor/model': 'low', 'vendor/second': 'high' }),
      other: Object.freeze({ 'vendor/model': 'medium' }),
    });
    const preset: Preset = { ...createDefaultPreset(), reasoning_effort: 'max' };
    for (const [connectionId, modelId, effort] of [
      ['conn', 'vendor/model', 'low'],
      ['conn', 'vendor/second', 'high'],
      ['other', 'vendor/model', 'medium'],
      ['conn', 'vendor/model', 'low'],
    ] as const) {
      const { body } = request({
        model: { ...model, id: connectionId, model: modelId },
        preset,
        chatReasoningEfforts: efforts,
      });
      expect(body.model).toBe(modelId);
      expect(body.reasoning).toEqual({ exclude: false, effort });
    }
  });

  test('a later settings snapshot cannot change an earlier request’s model and effort', () => {
    const earlier = input({
      model: { ...model },
      chatReasoningEfforts: Object.freeze({
        conn: Object.freeze({ 'vendor/model': 'low' }),
      }),
    });
    const later = input({
      model: { ...model, model: 'vendor/second' },
      chatReasoningEfforts: Object.freeze({
        conn: Object.freeze({ 'vendor/model': 'high', 'vendor/second': 'medium' }),
      }),
    });
    expect(request(later).body.reasoning).toEqual({ exclude: false, effort: 'medium' });
    expect(request(earlier).body).toMatchObject({
      model: 'vendor/model',
      reasoning: { exclude: false, effort: 'low' },
    });
  });

  test('without a saved effort the current live preset remains the fallback', () => {
    const preferences: (ChatReasoningEfforts | undefined)[] = [
      undefined,
      {},
      { conn: { 'vendor/second': 'low' } },
      { other: { 'vendor/model': 'low' } },
    ];
    for (const chatReasoningEfforts of preferences) {
      for (const effort of ['high', 'medium', 'auto'] as const) {
        const { body } = request({
          preset: { ...createDefaultPreset(), reasoning_effort: effort },
          chatReasoningEfforts,
        });
        expect(body.reasoning).toEqual({
          exclude: false,
          ...(effort === 'auto' ? {} : { effort }),
        });
      }
    }
  });

  test('explicit Auto overrides a high preset without sending effort or a thinking budget', () => {
    for (const target of [
      { ...model, provider: 'custom' as const },
      model,
      claude,
      google,
      { ...google, model: 'gemini-2.5-flash' },
    ]) {
      const { body } = request({
        model: target,
        preset: { ...createDefaultPreset(), ...samplers, reasoning_effort: 'high' },
        chatReasoningEfforts: { [target.id]: { [target.model]: 'auto' } },
      });
      expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
      expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
      expect(body.reasoning).toEqual(
        target.provider === 'openrouter' ? { exclude: false } : undefined,
      );
      expect(body.extra_body).toEqual(
        target.baseUrl === google.baseUrl
          ? { google: { thinking_config: { include_thoughts: true } } }
          : undefined,
      );
      expect(body.temperature).toBe(samplers.temperature);
      expect(body.top_p).toBe(samplers.top_p);
      expect(body.top_k).toBe(target.provider === 'openrouter' ? samplers.top_k : undefined);
    }
  });

  for (const provider of ['custom', 'openrouter'] as const) {
    test(`${provider} keeps its request shape and samplers with a saved effort`, () => {
      const { body } = request({
        model: { ...model, provider, showReasoning: false, reportUsage: true },
        preset: { ...createDefaultPreset(), ...samplers, reasoning_effort: 'high' },
        chatReasoningEfforts: { conn: { 'vendor/model': 'medium' } },
      });
      expect(body.reasoning_effort).toBe(provider === 'custom' ? 'medium' : undefined);
      expect(body.reasoning).toEqual(
        provider === 'openrouter' ? { exclude: true, effort: 'medium' } : undefined,
      );
      expect(Object.hasOwn(body, 'extra_body')).toBe(false);
      expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
      expect(body.temperature).toBe(samplers.temperature);
      expect(body.top_p).toBe(samplers.top_p);
      for (const key of extraSamplers) {
        expect(Object.hasOwn(body, key)).toBe(provider === 'openrouter');
      }
      expect(body.usage).toEqual(provider === 'openrouter' ? { include: true } : undefined);
      expect(body.stream_options).toEqual(
        provider === 'custom' ? { include_usage: true } : undefined,
      );
    });
  }

  test('Claude uses the saved effort for its budget and removes conflicting samplers', () => {
    const { body } = request({
      model: { ...claude, showReasoning: false },
      preset: {
        ...createDefaultPreset(),
        ...samplers,
        reasoning_effort: 'low',
        openai_max_context: 16384,
        openai_max_tokens_unlimited: false,
        openai_max_tokens: 4096,
      },
      chatReasoningEfforts: { conn: { [claude.model]: 'high' } },
    });
    expect(body.reasoning).toEqual({ exclude: true, max_tokens: 2048 });
    expect(body.max_tokens).toBe(6144);
    expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
    for (const key of ['temperature', 'top_p', ...extraSamplers]) {
      expect(Object.hasOwn(body, key)).toBe(false);
    }
    expect(body.frequency_penalty).toBe(samplers.frequency_penalty);
    expect(body.presence_penalty).toBe(samplers.presence_penalty);
  });

  test('uncapped Claude retains the existing reply allowance above its saved thinking budget', () => {
    const { body } = request({
      model: claude,
      preset: { ...createDefaultPreset(), reasoning_effort: 'auto' },
      chatReasoningEfforts: { conn: { [claude.model]: 'medium' } },
    });
    expect(body.reasoning).toEqual({ exclude: false, max_tokens: 8000 });
    expect(body.max_tokens).toBe(40000);
  });

  for (const [modelId, config] of [
    ['gemini-3.8-flash', { thinking_level: 'medium' }],
    ['gemini-2.5-flash', { thinking_budget: 8192 }],
  ] as const) {
    test(`${modelId} puts its saved effort only in Google thinking_config`, () => {
      const { body } = request({
        model: { ...google, model: modelId, showReasoning: false },
        preset: { ...createDefaultPreset(), reasoning_effort: 'high' },
        chatReasoningEfforts: { conn: { [modelId]: 'medium' } },
      });
      expect(body.extra_body).toEqual({
        google: { thinking_config: { ...config, include_thoughts: false } },
      });
      expect(Object.hasOwn(body, 'reasoning_effort')).toBe(false);
      expect(Object.hasOwn(body, 'reasoning')).toBe(false);
    });
  }

  for (const effort of ['min', 'max'] as const) {
    test(`saved ${effort} preserves each provider’s existing handling`, () => {
      const wireEffort = effort === 'min' ? 'low' : 'high';
      for (const target of [{ ...model, provider: 'custom' as const }, model]) {
        const { body } = request({
          model: target,
          chatReasoningEfforts: { conn: { [target.model]: effort } },
        });
        expect(body.reasoning_effort).toBe(target.provider === 'custom' ? wireEffort : undefined);
        expect(body.reasoning).toEqual(
          target.provider === 'openrouter' ? { exclude: false, effort: wireEffort } : undefined,
        );
      }
      for (const modelId of ['gemini-3.8-flash', 'gemini-2.5-flash']) {
        const { body } = request({
          model: { ...google, model: modelId },
          chatReasoningEfforts: { conn: { [modelId]: effort } },
        });
        expect(body.extra_body).toEqual({
          google: {
            thinking_config: {
              include_thoughts: true,
              ...(modelId === 'gemini-2.5-flash'
                ? { thinking_budget: effort === 'min' ? 1024 : 24576 }
                : { thinking_level: wireEffort }),
            },
          },
        });
      }
      const { body } = request({
        model: claude,
        preset: {
          ...createDefaultPreset(),
          openai_max_context: 16384,
          openai_max_tokens_unlimited: false,
          openai_max_tokens: 4096,
        },
        chatReasoningEfforts: { conn: { [claude.model]: effort } },
      });
      const budget = effort === 'min' ? 1024 : 3891;
      expect(body.reasoning).toEqual({ exclude: false, max_tokens: budget });
      expect(body.max_tokens).toBe(4096 + budget);
    });
  }

  test('overriding effort changes only the body, never assembly or the caller’s preset', () => {
    const preset: Preset = {
      ...createDefaultPreset(),
      ...samplers,
      reasoning_effort: 'auto',
    };
    const original = structuredClone(preset);
    Object.freeze(preset);
    const efforts: ChatReasoningEfforts = Object.freeze({
      conn: Object.freeze({ [claude.model]: 'high' }),
    });
    const baseline = request({ model: claude, preset });
    const overridden = request({ model: claude, preset, chatReasoningEfforts: efforts });
    expect(overridden.body.reasoning).toEqual({ exclude: false, max_tokens: 16000 });
    expect(overridden.assembled).toEqual(baseline.assembled);
    expect(preset).toEqual(original);
    expect(preset.reasoning_effort).toBe('auto');
    expect(efforts).toEqual({ conn: { [claude.model]: 'high' } });
  });

  for (const [label, mode, guidance] of [
    ['send', 'send', undefined],
    ['regenerate', 'regenerate', undefined],
    ['swipe', 'swipe', undefined],
    ['continue', 'continue', undefined],
    ['impersonate', 'impersonate', undefined],
    ['guided reply', 'send', 'Keep it mysterious.'],
    ['guided swipe', 'swipe', 'Keep it mysterious.'],
  ] as const) {
    test(`${label} inherits the saved effort while keeping its completion rules`, () => {
      const state = started(mode);
      expect(state.status).toBe('connecting');
      const { body, completions, assembled } = request({
        mode,
        started: state,
        guidance,
        preset: { ...createDefaultPreset(), n: 3, reasoning_effort: 'high' },
        chatReasoningEfforts: { conn: { 'vendor/model': 'low' } },
      });
      expect(body.reasoning).toEqual({ exclude: false, effort: 'low' });
      const single = mode === 'continue' || mode === 'impersonate';
      expect(completions).toBe(single ? 1 : 3);
      expect(body.n).toBe(single ? undefined : 3);
      if (guidance)
        expect(assembled.messages.some((message) => message.content.includes(guidance))).toBe(true);
    });
  }
});

describe('completions and seeds', () => {
  const preset: Preset = { ...createDefaultPreset(), n: 3, continue_postfix: '\n' };

  test('only modes that own a swipe array ask for alternates', () => {
    expect(completionsFor('send', preset)).toBe(3);
    expect(completionsFor('swipe', preset)).toBe(3);
    expect(completionsFor('continue', preset)).toBe(1);
    expect(completionsFor('impersonate', preset)).toBe(1);
  });

  test('continue builds on the reply so far, joined by the preset postfix', () => {
    const target = started().messages[0]!;
    expect(continueSeed('continue', target, preset)).toBe('Welcome.\n');
    expect(continueSeed('send', target, preset)).toBe('');
  });
});

describe('recordReply', () => {
  const final = (overrides: Partial<StreamState> = {}): StreamState => ({
    content: 'one two three',
    reasoning: '',
    finishReason: 'stop',
    done: true,
    ...overrides,
  });
  const base = {
    model,
    presetId: 'p1',
    nexusRecall: undefined,
    generationId: 'g1',
    completions: 1,
    countText,
  };

  test('a single completion trusts the provider’s count and says so', () => {
    const { extra, alternates } = recordReply({
      ...base,
      final: final({ usage: { completion_tokens: 42, prompt_tokens: 7 } }),
    });
    expect(alternates).toEqual([]);
    expect(extra).toMatchObject({
      api: 'openrouter',
      model: 'vendor/model',
      connection_id: 'conn',
      preset_id: 'p1',
      prompt_tokens: 7,
      token_count: 42,
      usage_reported: true,
      generation_id: 'g1',
    });
  });

  test('with alternates the reported count covers them all, so each swipe is estimated', () => {
    const { extra, alternates } = recordReply({
      ...base,
      completions: 3,
      final: final({
        usage: { completion_tokens: 99 },
        alternates: [
          { content: 'four five', reasoning: '', finishReason: 'stop' },
          { content: '   ', reasoning: '', finishReason: 'stop' },
        ],
      }),
    });
    expect(alternates).toHaveLength(1);
    expect(alternates[0]?.extra?.token_count).toBe(2);
    expect(extra.token_count).toBe(3);
    expect(extra).not.toHaveProperty('usage_reported');
  });

  test('the model the provider names wins over the one asked for', () => {
    expect(recordReply({ ...base, final: final({ model: 'vendor/model-2025' }) }).extra.model).toBe(
      'vendor/model-2025',
    );
  });
});
