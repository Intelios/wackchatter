import { describe, expect, test } from 'bun:test';
import { assistantPlaceholder, currentText, setText, userMessage } from '@shared/chat/message.ts';
import {
  activeCheckpoint,
  makeCompactionPlan,
  recordCompaction,
} from '@shared/cocreator/compaction.ts';
import { captureSideSnapshot } from '@shared/cocreator/sideChat.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import { measureCharacterContext } from './characterContext.ts';
import { characterCompactionSources } from './compactionSources.ts';
import { contextView } from './context.ts';
import { buildDesignGeneration } from './generation.ts';
import { buildDesignPrompt } from './prompt.ts';
import { buildSidePrompt, SIDE_CHAT_BOUNDARY } from './sidePrompt.ts';
import {
  type CocreatorState,
  cocreatorReducer,
  initialCocreatorState,
  toPersistedMessages,
  toPersistedSideChat,
} from './state/cocreatorReducer.ts';

const counter: TokenCounter = {
  countText: (text) => Math.ceil(text.length / 4),
  countChat: (messages) =>
    messages.reduce((sum, message) => sum + counter.countText(message.content) + 4, 3),
};
const model = {
  id: 'c',
  name: 'Model',
  model: 'design-model',
  provider: 'custom' as const,
  baseUrl: 'http://local',
};
const transcript = () =>
  Array.from({ length: 20 }, (_, i) =>
    i % 2
      ? setText(
          assistantPlaceholder(`a${i}`, 'Assistant'),
          `Suggestion ${i}: ${'tentative idea '.repeat(100)}`,
        )
      : userMessage(`u${i}`, 'You', `User decision ${i}: ${'restrained prose '.repeat(60)}`, null),
  );
const summarize = (
  messages: ReturnType<typeof characterCompactionSources>,
  kind: 'character' | 'side',
) => {
  const plan = makeCompactionPlan({
    messages,
    kind,
    maxPromptTokens: 50000,
    countText: counter.countText,
  });
  expect(plan).not.toBeNull();
  return recordCompaction(plan!, {
    id: 'checkpoint',
    created: 1,
    status: 'complete',
    summary:
      'Goal: a lighthouse keeper. Preferences: restrained prose. No suggestions have been filed.',
    model: { connectionId: 'c', modelId: 'design-model' },
  });
};

describe('compacted Character Co-Creator requests', () => {
  test('pins the accepted card and examples independently of a summary, with the recent transcript verbatim', () => {
    const messages = transcript();
    const record = summarize(characterCompactionSources(messages), 'character');
    const compaction = { automatic: true, history: [record] };
    const options = {
      messages,
      systemPrompt: 'Design instructions',
      exampleBlock: 'Literal example {{char}}',
      draftBlock: 'Accepted working card {{char}}',
      countTokens: counter,
      maxPromptTokens: 50000,
      compaction,
    };
    const prompt = buildDesignPrompt(options);
    expect(prompt.messages.slice(0, 3).map((m) => m.content)).toEqual([
      'Design instructions',
      'Literal example {{char}}',
      'Accepted working card {{char}}',
    ]);
    expect(prompt.messages[3]?.role).toBe('user');
    expect(prompt.messages[3]?.content).toContain('Suggestions remain suggestions');
    expect(prompt.messages.slice(4).map((m) => m.content)).toEqual(
      messages.slice(record.checkpoint!.coveredMessages).map(currentText),
    );
    expect(prompt.droppedMessages).toBe(0);
    expect(
      Object.values(prompt.tokenCounts).reduce((sum, n) => sum + n, counter.countChat([])),
    ).toBe(prompt.totalTokens);
    const request = buildDesignGeneration({
      ...options,
      mode: 'send',
      preset: createDefaultPreset(),
      connection: model,
      settings: { contextTokens: 50000 },
      streaming: true,
    });
    expect(request.body.messages).toEqual(prompt.messages);
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(messages).toHaveLength(20);
    const changed = messages.map((m, i) => (i === 0 ? setText(m, 'Edited brief') : m));
    expect(activeCheckpoint(compaction, characterCompactionSources(changed))).toBeNull();
    expect(buildDesignPrompt({ ...options, messages: changed }).messages[3]?.content).toBe(
      'Edited brief',
    );
  });

  test('side compaction summarizes frozen background as data and keeps its card and side boundary pinned', () => {
    const frozen = captureSideSnapshot({
      systemPrompt: 'Frozen instructions',
      exampleBlock: 'Frozen example',
      draftBlock: 'Frozen accepted card',
      messages: transcript(),
      capturedAt: 5,
    });
    const side = transcript().slice(-6);
    const sources = characterCompactionSources(side, frozen);
    expect(
      sources.slice(0, frozen.messages.length).every((m) => m.role === 'reference' && !m.userText),
    ).toBe(true);
    const record = summarize(sources, 'side');
    const compaction = { automatic: false, history: [record] };
    const before = JSON.stringify({ frozen, side });
    const prompt = buildSidePrompt({
      snapshot: frozen,
      messages: side,
      compaction,
      countTokens: counter,
      maxPromptTokens: 50000,
    });
    expect(prompt.messages.slice(0, 3).map((m) => m.content)).toEqual([
      expect.stringContaining('Frozen instructions'),
      'Frozen example',
      'Frozen accepted card',
    ]);
    expect(prompt.messages.some((m) => m.content === SIDE_CHAT_BOUNDARY)).toBe(true);
    expect(prompt.messages.at(-1)?.content).toBe(currentText(side.at(-1)!));
    expect(prompt.droppedMainMessages + prompt.droppedSideMessages).toBe(0);
    expect(JSON.stringify({ frozen, side })).toBe(before);
  });

  test('context measurement uses the catalogue window, fixed card and saved summary, without dropping history to hide fullness', () => {
    const messages = transcript();
    const options = {
      messages,
      preset: createDefaultPreset(),
      model,
      contextTokens: 16000,
      settings: { contextTokens: 999999, outputTokens: 1000 },
      systemPrompt: 'Instructions',
      exampleBlock: 'Examples',
      draftBlock: 'Accepted',
      countTokens: counter,
    };
    const before = measureCharacterContext(options);
    const record = summarize(before.sources, 'character');
    const state = { automatic: true, history: [record] };
    const after = measureCharacterContext({ ...options, compaction: state });
    expect(after.budget.promptTokens + after.budget.reservedTokens + 128).toBe(16000);
    expect(after.fixed).toBe(before.fixed);
    expect(after.summary).toBeGreaterThan(0);
    expect(after.used).toBeLessThan(before.used);
    const view = contextView({
      label: 'Main',
      model: model.model,
      total: 16000,
      assumed: false,
      used: after.used,
      fixed: after.fixed,
      summary: after.summary,
      reserved: after.budget.reservedTokens,
      promptBudget: after.budget.promptTokens,
      messages: after.sources,
      state,
      busy: false,
      compacting: false,
      countText: counter.countText,
      kind: 'character',
    });
    expect(view.checkpoint?.id).toBe(record.id);
    expect(view.automatic).toBe(true);
    expect(
      contextView({
        ...view,
        messages: after.sources,
        state,
        busy: true,
        countText: counter.countText,
        kind: 'character',
      }).disabledReason,
    ).toContain('current request');
  });

  test('main and side checkpoints and automatic switches persist independently without deleting transcript; reset keeps the side preference', () => {
    const messages = transcript();
    const record = summarize(characterCompactionSources(messages), 'character');
    let state: CocreatorState = {
      ...initialCocreatorState,
      messages,
      compaction: { automatic: true, history: [] },
    };
    state = cocreatorReducer(state, { type: 'compaction/recorded', record });
    state = cocreatorReducer(state, {
      type: 'side/opened',
      snapshot: captureSideSnapshot({ systemPrompt: 'Instructions', exampleBlock: '', messages }),
    });
    state = cocreatorReducer(state, {
      type: 'compaction/automatic',
      target: 'side',
      automatic: false,
    });
    state = cocreatorReducer(state, { type: 'compaction/recorded', target: 'side', record });
    expect(toPersistedMessages(state)).toHaveLength(messages.length);
    expect(toPersistedSideChat(state)?.compaction?.history).toHaveLength(1);
    expect(state.compaction.automatic).toBe(true);
    expect(state.compaction.history).toHaveLength(1);
    state = cocreatorReducer(state, {
      type: 'side/reset',
      snapshot: { ...state.sideChat!.snapshot, capturedAt: 100 },
    });
    expect(state.sideChat?.compaction).toEqual({ automatic: false, history: [] });
    expect(state.compaction.history).toHaveLength(1);
  });
});
