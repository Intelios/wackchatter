import { describe, expect, test } from 'bun:test';
import {
  activeCheckpoint,
  makeCompactionPlan,
  recordCompaction,
} from '@shared/cocreator/compaction.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type {
  PresetCocreatorMessage,
  PresetCocreatorSession,
} from '@shared/types/preset-cocreator.ts';
import { buildAssistantRequest, presetCompactionSources } from './assistantRequest.ts';
import { presetToolHistory } from './toolHistory.ts';

const model = {
  id: 'c',
  name: 'Chosen',
  model: 'chosen-model',
  provider: 'custom' as const,
  baseUrl: 'http://local',
};
const countText = (text: string) => Math.ceil(text.length / 4);
function sessionWith(messages: PresetCocreatorMessage[]): PresetCocreatorSession {
  const current = {
    revision: 2,
    created: 0,
    source: 'manual' as const,
    summary: 'Latest accepted draft',
    turnId: null,
    operationId: 'manual',
    preset: { ...createDefaultPreset(), temperature: 0.42 },
    diff: [],
  };
  return {
    id: 'session',
    title: 'Design',
    created: 0,
    modified: 0,
    sourcePresetId: null,
    targetPresetId: null,
    draftRevision: 2,
    documentRevision: 0,
    targetPresetVersion: null,
    testCount: 0,
    lastMessage: '',
    current,
    history: [current],
    document: {
      compaction: { automatic: true, history: [] },
      settings: {
        assistant: {
          model: { connectionId: 'c', modelId: 'chosen-model' },
          temperature: 0.7,
          maxTokens: 3000,
          reasoningEffort: 'auto',
        },
        testing: { model: null, temperature: 1, maxTokens: 1000, reasoningEffort: 'auto' },
        assistantInstructions: 'Do not remove documentation.',
      },
      messages,
      tests: [],
      activeTestId: null,
      proposedTests: [],
      batchQueue: {
        items: [],
        note: '',
        includeTranscript: true,
        includePrompt: true,
        includeDiagnostics: true,
      },
    },
  };
}
const history = (): PresetCocreatorMessage[] =>
  Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    created: i,
    content: `Conversation ${i}: ${'Retain concise dialogue. '.repeat(100)}`,
  }));
function compact(session: PresetCocreatorSession) {
  const sources = presetCompactionSources(
    presetToolHistory(session.document.messages, session.history),
  );
  const plan = makeCompactionPlan({
    messages: sources,
    state: session.document.compaction,
    maxPromptTokens: 50000,
    countText,
    kind: 'preset',
  })!;
  const record = recordCompaction(plan, {
    id: 'summary',
    created: 1,
    status: 'complete',
    model: { connectionId: 'c', modelId: 'chosen-model' },
    summary:
      'User prefers concise dialogue. Revision 1 test showed repetition; revision 2 has not been tested. An edit remains a suggestion.',
  });
  session.document.compaction = { automatic: true, history: [record] };
  return record;
}
const build = (session: PresetCocreatorSession, mode?: 'comparison') =>
  buildAssistantRequest({
    session,
    messages: session.document.messages,
    model,
    contextTokens: 64000,
    countText,
    referenceNames: ['Example.json'],
    mode,
  });

describe('Preset Co-Creator context projection', () => {
  test('app continuation controls stay in context without being quoted as the user’s own words', () => {
    const source = presetCompactionSources([
      { id: 'user', role: 'user', created: 0, content: 'Keep the voice restrained.' },
      {
        id: 'continue',
        role: 'user',
        created: 1,
        content: 'Continue from the last tool call.',
        appAction: 'continue',
      },
    ]);
    expect(source[0]?.userText).toBe('Keep the voice restrained.');
    expect(source[1]?.userText).toBeUndefined();
    expect(source[1]?.content).toBe('Continue from the last tool call.');
  });
  test('pins the latest preset revision, instructions and reference catalogue outside the summary', () => {
    const session = sessionWith(history());
    const original = structuredClone(session.document.messages);
    const before = build(session);
    const record = compact(session);
    const after = build(session);
    expect(after.body.messages![0]!.content).toContain('Do not remove documentation.');
    expect(after.body.messages![0]!.content).toContain('Example.json');
    expect(after.body.messages![0]!.content).toContain('0.42');
    expect(after.body.messages![1]!.content).toContain('revision 2 has not been tested');
    expect(after.body.messages!.slice(2).map((m) => m.content)).toEqual(
      original.slice(record.checkpoint!.coveredMessages).map((m) => m.content),
    );
    expect(after.used).toBeLessThan(before.used);
    expect(after.fixed).toBe(before.fixed);
    expect(after.body).not.toHaveProperty('max_tokens');
    expect(after.body.tools).toBeDefined();
    expect(session.document.messages).toEqual(original);
    expect(build(session, 'comparison').body).not.toHaveProperty('tools');
  });

  test('assistant calls and all results stay whole, including provider replay metadata on the retained tail', () => {
    const messages = history();
    const calls = ['read_preset', 'read_reference_preset'].map((name, i) => ({
      id: `call${i}`,
      type: 'function' as const,
      function: { name, arguments: '{}' },
      extra_content: { google: { thought_signature: 'signature' } },
    }));
    messages.push(
      { id: 'calls', role: 'assistant', content: '', created: 21, toolCalls: calls },
      ...calls.map(
        (call, i): PresetCocreatorMessage => ({
          id: `result${i}`,
          role: 'tool',
          toolCallId: call.id,
          toolName: call.function.name,
          content: '{"ok":true}',
          created: 22,
        }),
      ),
      { id: 'latest', role: 'user', content: 'Continue using these results.', created: 23 },
    );
    const session = sessionWith(messages);
    compact(session);
    const request = build(session);
    const assistant = request.body
      .messages!.filter((m) => m.role === 'assistant')
      .find((m) => m.tool_calls?.length);
    expect(assistant?.tool_calls).toEqual(calls);
    const index = request.body.messages!.indexOf(assistant!);
    expect(
      request.body
        .messages!.slice(index + 1, index + 3)
        .map((m) => (m.role === 'tool' ? m.tool_call_id : null)),
    ).toEqual(calls.map((call) => call.id));
    const sources = request.sources.filter((m) => m.id === 'calls' || m.id.startsWith('result'));
    expect(new Set(sources.map((m) => m.group)).size).toBe(1);
    expect(JSON.stringify(sources)).not.toContain('signature');
  });

  test('comparison evidence is frozen source data, and changes to covered evidence invalidate a checkpoint', () => {
    const messages = history();
    messages[0] = {
      id: 'comparison',
      role: 'user',
      content: 'Focus on dialogue',
      created: 0,
      comparison: {
        focus: 'Focus on dialogue',
        draft: { label: 'Draft', revision: 1, preset: createDefaultPreset() },
        other: {
          label: 'Other',
          source: { kind: 'reference', id: 'Other.json' },
          preset: { ...createDefaultPreset(), temperature: 0.2 },
        },
      },
    };
    const session = sessionWith(messages);
    const sources = build(session).sources;
    expect(sources[0]?.userText).toBe('Focus on dialogue');
    expect(sources[0]?.content).toContain('0.2');
    compact(session);
    expect(activeCheckpoint(session.document.compaction, build(session).sources)).not.toBeNull();
    messages[0]!.comparison!.other.preset.temperature = 0.3;
    expect(activeCheckpoint(session.document.compaction, build(session).sources)).toBeNull();
  });

  test('a repaired missing tool result remains evidence of interruption, never a successful edit', () => {
    const messages = history();
    messages.splice(1, 0, {
      id: 'interrupted',
      turnId: 'old',
      role: 'assistant',
      content: '',
      created: 1,
      toolCalls: [
        { id: 'unknown', type: 'function', function: { name: 'patch_preset', arguments: '{}' } },
      ],
    });
    const session = sessionWith(messages);
    const sources = build(session).sources;
    const result = sources.find((m) => m.id === 'interrupted:recovered:0');
    expect(result?.group).toBe('interrupted');
    expect(result?.content).toContain('outcomeUnknown');
    compact(session);
    expect(session.document.messages.some((m) => m.role === 'tool')).toBe(false);
  });
});
