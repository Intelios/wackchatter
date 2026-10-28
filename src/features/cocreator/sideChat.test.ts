import { describe, expect, test } from 'bun:test';
import { assistantPlaceholder, setText, userMessage } from '@shared/chat/message.ts';
import {
  appendDraft,
  captureSideSnapshot,
  quoteForSideChat,
  resolveSideSettings,
} from '@shared/cocreator/sideChat.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { DEFAULT_SIDE_CHAT } from '@shared/types/cocreator.ts';
import { buildSidePrompt, SIDE_CHAT_BOUNDARY, SIDE_CHAT_INSTRUCTION } from './sidePrompt.ts';
import { parseCocreatorInput } from './slashCommands.ts';

const counter: TokenCounter = {
  countText: (text) => text.length,
  countChat: (messages) => messages.reduce((n, m) => n + m.content.length + 4, 3),
};
const main = userMessage('main', 'You', 'She guards a lighthouse.', null);
const ask = userMessage('side', 'You', 'Name ideas?', null);
const snapshot = () =>
  captureSideSnapshot({
    systemPrompt: 'Design instructions.',
    exampleBlock: 'Frozen examples.',
    messages: [main],
    capturedAt: 123,
  });
const build = (overrides: Partial<Parameters<typeof buildSidePrompt>[0]> = {}) =>
  buildSidePrompt({
    snapshot: snapshot(),
    messages: [ask],
    countTokens: counter,
    maxPromptTokens: 10000,
    ...overrides,
  });

describe('side context', () => {
  test('captures selected text, not alternate takes, reasoning, or live references', () => {
    const reply = setText(assistantPlaceholder('a', 'Assistant'), 'Chosen text.', {
      extra: { reasoning: 'Private thinking.' },
    });
    reply.swipes.push('Alternate text.');
    const frozen = captureSideSnapshot({
      systemPrompt: 'System.',
      exampleBlock: 'Examples.',
      messages: [main, reply, assistantPlaceholder('blank', 'Assistant')],
    });
    main.swipes[0] = 'Changed later.';
    expect(frozen.messages.map((m) => m.content)).toEqual([
      'She guards a lighthouse.',
      'Chosen text.',
    ]);
    expect(JSON.stringify(frozen)).not.toContain('Private thinking');
    main.swipes[0] = 'She guards a lighthouse.';
  });

  test('separates main background from the side question and retains the focused instruction', () => {
    const prompt = build();
    expect(prompt.messages[0]?.content).toContain(SIDE_CHAT_INSTRUCTION);
    expect(prompt.messages[0]?.content).toContain('Design instructions.');
    expect(prompt.messages[1]?.content).toBe('Frozen examples.');
    expect(prompt.messages.at(-2)?.content).toBe(SIDE_CHAT_BOUNDARY);
    expect(prompt.messages.at(-1)?.content).toBe('Name ideas?');
  });

  test('drops old main context before side history and reports omissions without modifying the snapshot', () => {
    const frozen = snapshot();
    const full = build({ snapshot: frozen });
    const packed = build({
      snapshot: frozen,
      maxPromptTokens: full.totalTokens - main.swipes[0]!.length,
    });
    expect(packed.droppedMainMessages).toBe(1);
    expect(packed.droppedSideMessages).toBe(0);
    expect(packed.messages.at(-1)?.content).toBe('Name ideas?');
    expect(frozen.messages).toHaveLength(1);
  });

  test('fixed overflow and an oversized latest question cannot silently produce an unrelated request', () => {
    expect(build({ maxPromptTokens: 2 }).fixedOverflow).toBe(true);
    const huge = userMessage('huge', 'You', 'x'.repeat(20000), null);
    expect(build({ messages: [huge] }).droppedSideMessages).toBe(1);
  });
});

describe('side settings and drafts', () => {
  const connection = {
    id: 'cheap',
    name: 'Cheap',
    provider: 'custom' as const,
    model: 'saved',
    baseUrl: 'http://localhost',
  };
  test('never falls back to the main or first endpoint', () => {
    expect(resolveSideSettings(DEFAULT_SIDE_CHAT, {}, [connection]).connection).toBeNull();
    expect(
      resolveSideSettings({ ...DEFAULT_SIDE_CHAT, connectionId: 'deleted' }, {}, [connection])
        .connection,
    ).toBeNull();
  });
  test('endpoint-bound model overrides and session choices resolve independently', () => {
    const defaults = {
      ...DEFAULT_SIDE_CHAT,
      connectionId: 'cheap',
      modelOverride: { connectionId: 'cheap', model: 'default-cheap' },
    };
    expect(resolveSideSettings(defaults, {}, [connection]).connection?.model).toBe('default-cheap');
    expect(
      resolveSideSettings(
        defaults,
        {
          connectionId: 'cheap',
          modelOverride: { connectionId: 'other', model: 'wrong' },
          outputTokens: 100,
        },
        [connection],
      ),
    ).toMatchObject({ connection: { model: 'saved' }, outputTokens: 100 });
  });
  test('quotes and transfers append without discarding either draft', () => {
    expect(appendDraft('My answer.', 'Elowen.')).toBe('My answer.\n\nElowen.');
    expect(appendDraft('Existing side draft.', quoteForSideChat('Line one\nLine two'))).toBe(
      'Existing side draft.\n\n> Line one\n> Line two\n\n',
    );
  });
  test('typed commands route to side actions and malformed commands never fall through to main send', () => {
    expect(parseCocreatorInput('/side')).toEqual({ type: 'openSide' });
    expect(parseCocreatorInput('/side Name ideas?')).toEqual({
      type: 'sendSide',
      text: 'Name ideas?',
    });
    expect(parseCocreatorInput('/sideways Name ideas?').type).toBe('error');
    expect(parseCocreatorInput('Tell me about /side')).toEqual({
      type: 'message',
      text: 'Tell me about /side',
    });
  });
});
