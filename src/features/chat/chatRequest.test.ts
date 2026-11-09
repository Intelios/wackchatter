import { describe, expect, test } from 'bun:test';
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
import { type ChatState, chatReducer, initialChatState } from './state/chatReducer.ts';

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

/** A chat with a greeting and a user turn, and the assistant placeholder folded in. */
function started(mode: 'send' | 'impersonate' = 'send'): ChatState {
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
