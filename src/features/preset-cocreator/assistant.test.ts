import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import { ApiError } from '../../lib/api.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantWireMessages,
  correlateToolMessages,
  editAssistantConversationMessage,
  executePresetToolCall,
  parsePresetToolCall,
  presetReference,
  referencePresetView,
  renderAssistantSystem,
  toolCallArguments,
  toolFailureResult,
} from './assistant.ts';

function call(name: string, args: unknown): ProviderToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

describe('Preset Co-Creator assistant boundary', () => {
  test('only the preset-scoped tools parse', () => {
    expect(parsePresetToolCall(call('read_preset', {}))).toEqual({ name: 'read_preset' });
    expect(
      parsePresetToolCall(
        call('propose_test', { message: 'Say hello', restart: true, rationale: 'Check voice' }),
      ),
    ).toEqual({
      name: 'propose_test',
      message: 'Say hello',
      restart: true,
      rationale: 'Check voice',
    });
    expect(parsePresetToolCall(call('read_reference_preset', { name: 'Good One' }))).toEqual({
      name: 'read_reference_preset',
      presetName: 'Good One',
    });
    expect(() => parsePresetToolCall(call('write_file', { path: '/tmp/a' }))).toThrow(
      'Unknown tool',
    );
  });

  test('read_reference_preset takes only a non-empty name', () => {
    expect(() => parsePresetToolCall(call('read_reference_preset', {}))).toThrow(
      'needs a preset name',
    );
    expect(() => parsePresetToolCall(call('read_reference_preset', { name: '  ' }))).toThrow(
      'needs a preset name',
    );
    expect(() =>
      parsePresetToolCall(call('read_reference_preset', { name: 'Fine', path: '/etc/passwd' })),
    ).toThrow('unexpected argument');
  });

  test('session ids, filenames, and extra authority are rejected', () => {
    expect(() =>
      parsePresetToolCall(
        call('patch_preset', {
          expectedRevision: 0,
          operations: [{ op: 'replace', path: '/temperature', value: 0.5 }],
          summary: 'Change temperature',
          sessionId: 'someone-else',
          file: '/etc/passwd',
        }),
      ),
    ).toThrow('unexpected argument');
  });

  test('malformed and incomplete calls never become executable commands', () => {
    expect(() => parsePresetToolCall(call('patch_preset', '{"expectedRevision":'))).toThrow(
      'valid JSON',
    );
    expect(() =>
      parsePresetToolCall(call('patch_preset', { expectedRevision: 0, operations: [] })),
    ).toThrow('at least one');
  });

  test('tool calls and reasoning blocks are echoed back in provider order', () => {
    const messages: PresetCocreatorMessage[] = [
      { id: 'u', role: 'user', content: 'Improve it', created: 1 },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        created: 2,
        reasoningDetails: [{ type: 'reasoning.text', text: 'Plan', signature: 'sig' }],
        toolCalls: [call('read_preset', {})],
      },
      {
        id: 't',
        role: 'tool',
        content: '{"revision":0}',
        created: 3,
        toolCallId: 'call-1',
        toolName: 'read_preset',
      },
    ];

    expect(assistantWireMessages(messages)).toEqual([
      { role: 'user', content: 'Improve it' },
      {
        role: 'assistant',
        content: null,
        reasoning_details: [{ type: 'reasoning.text', text: 'Plan', signature: 'sig' }],
        tool_calls: [call('read_preset', {})],
      },
      { role: 'tool', content: '{"revision":0}', tool_call_id: 'call-1', name: 'read_preset' },
    ]);
  });

  test('the preset reference shows ordered blocks without granting a path', () => {
    const reference = presetReference(createDefaultPreset(), 3);
    expect(reference.revision).toBe(3);
    expect(reference.order[0]).toMatchObject({ identifier: 'main', enabled: true });
    expect(JSON.stringify(reference)).not.toContain('filename');
  });

  test('every order entry carries the exact pointers for editing or toggling it', () => {
    const reference = presetReference(createDefaultPreset(), 0);
    const main = reference.order.find((entry) => entry.identifier === 'main')!;
    const promptsIndex = createDefaultPreset().prompts!.findIndex(
      (prompt) => prompt.identifier === 'main',
    );
    const liveSlot = createDefaultPreset().prompt_order!.findIndex(
      (list) => Number(list.character_id) === 100001,
    );
    const orderIndex = reference.order.findIndex((entry) => entry.identifier === 'main');

    expect(main.promptPath).toBe(`/prompts/${promptsIndex}`);
    expect(main.enabledPath).toBe(`/prompt_order/${liveSlot}/order/${orderIndex}/enabled`);
    // The pointers are real: applying them through the patch engine works untouched.
  });

  test('a tool failure becomes result data, and a stale conflict names the live revision', () => {
    expect(toolFailureResult(new Error('JSON patch path "/nope" does not exist.'))).toEqual({
      ok: false,
      error: 'JSON patch path "/nope" does not exist.',
    });

    const stale = new ApiError('The session changed elsewhere.', 409, {
      error: 'stale',
      currentRevision: 4,
    });
    expect(toolFailureResult(stale)).toEqual({
      ok: false,
      error: 'The session changed elsewhere.',
      currentRevision: 4,
    });

    const conflictWithoutRevision = new ApiError('Preset conflict', 409, { other: true });
    expect(toolFailureResult(conflictWithoutRevision)).not.toHaveProperty('currentRevision');
  });

  test('executing a call rejects rather than half-applying, so the caller can feed it back', async () => {
    const patches: unknown[] = [];
    const proposals: unknown[] = [];
    const deps = {
      currentRevision: () => ({
        revision: 2,
        preset: createDefaultPreset(),
      }),
      // Faithful to the real dep: the server rejects an invalid patch, the executor passes
      // that rejection through, and nothing half-applies.
      patchDraft: async (input: { operations: Array<{ path: string }> }) => {
        if (input.operations.some((operation) => operation.path === '/nope')) {
          throw new Error('JSON patch path "/nope" does not exist.');
        }
        patches.push(input);
        return { revision: 3, diff: [{ path: '/temperature', kind: 'replace' as const }] };
      },
      proposeTest: (proposal: unknown) => proposals.push(proposal),
      readReference: async (name: string) => {
        if (name === 'Missing') throw new Error('Reference preset "Missing" not found.');
        return referencePresetView(name, 'abc123', createDefaultPreset());
      },
    };

    const read = await executePresetToolCall(call('read_preset', {}), 'turn-1', deps);
    expect(read).toMatchObject({ revision: 2 });

    const patched = await executePresetToolCall(
      call('patch_preset', {
        expectedRevision: 2,
        operations: [{ op: 'replace', path: '/temperature', value: 0.8 }],
        summary: 'Cool it down',
      }),
      'turn-1',
      deps,
    );
    expect(patched).toEqual({
      ok: true,
      revision: 3,
      diff: [{ path: '/temperature', kind: 'replace' }],
    });
    expect(patches[0]).toMatchObject({ operationId: 'tool:turn-1:call-1', turnId: 'turn-1' });

    await executePresetToolCall(
      call('propose_test', { message: 'Hi', restart: false, rationale: 'Voice check' }),
      'turn-1',
      deps,
    );
    expect(proposals[0]).toMatchObject({ message: 'Hi', status: 'pending' });

    await expect(
      executePresetToolCall(
        call('patch_preset', {
          expectedRevision: 2,
          operations: [{ op: 'replace', path: '/nope', value: 1 }],
          summary: 'Bad path',
        }),
        'turn-1',
        deps,
      ),
    ).rejects.toThrow();
    // Only the successful call was dispatched — the rejected one applied nothing.
    expect(patches).toHaveLength(1);
  });

  test('read_reference_preset resolves through the dep, and a miss rejects for the caller', async () => {
    const deps = {
      currentRevision: () => ({ revision: 0, preset: createDefaultPreset() }),
      patchDraft: async () => ({ revision: 1, diff: [] }),
      proposeTest: () => {},
      readReference: async (name: string) => {
        if (name === 'Missing') throw new Error('Reference preset "Missing" not found.');
        return referencePresetView(name, 'abc123', createDefaultPreset());
      },
    };

    const found = (await executePresetToolCall(
      call('read_reference_preset', { name: 'Good One' }),
      'turn-1',
      deps,
    )) as { name: string; version: string; order: unknown[] };
    expect(found.name).toBe('Good One');
    expect(found.version).toBe('abc123');
    // The view carries the same ordered-block overview the draft reference does.
    expect(found.order[0]).toMatchObject({ identifier: 'main', enabled: true });
    expect(found).not.toHaveProperty('revision');

    await expect(
      executePresetToolCall(call('read_reference_preset', { name: 'Missing' }), 'turn-1', deps),
    ).rejects.toThrow('not found');
  });

  test('the system prompt lists reference names only when there are any', () => {
    const revision = { revision: 0, preset: createDefaultPreset() };
    const without = renderAssistantSystem(revision, '', []);
    expect(without).not.toContain('Reference presets available');

    const withTwo = renderAssistantSystem(revision, '', ['Good One', 'Another']);
    expect(withTwo).toContain('Reference presets available through read_reference_preset');
    expect(withTwo).toContain('- Good One');
    expect(withTwo).toContain('- Another');
  });

  test('editing replaces only the targeted text', () => {
    const toolCall = call('read_preset', {});
    const messages: PresetCocreatorMessage[] = [
      { id: 'u', role: 'user', content: 'Improve it', created: 1 },
      {
        id: 'a',
        role: 'assistant',
        content: 'Sure',
        created: 2,
        reasoning: 'A plan',
        toolCalls: [toolCall],
      },
    ];

    const edited = editAssistantConversationMessage(messages, 'a', 'Better answer');
    expect(edited[1]).toMatchObject({ content: 'Better answer' });
    // Tool calls and reasoning stay attached — the next request's wire form stays valid.
    expect(edited[1]?.toolCalls).toEqual([toolCall]);
    expect(edited[1]?.reasoning).toBe('A plan');
    expect(edited[0]).toEqual(messages[0]);

    expect(editAssistantConversationMessage(messages, 'missing', 'x')[1]?.content).toBe('Sure');
    expect(editAssistantConversationMessage(messages, 'a', 'Sure')[1]?.content).toBe('Sure');
  });

  test('assistant turns have a hard provider-request limit', () => {
    expect(ASSISTANT_REQUEST_LIMIT).toBe(6);
  });
});

describe('tool activity correlation', () => {
  test('pairs each tool result with its call and parses the result', () => {
    const messages: PresetCocreatorMessage[] = [
      { id: 'u', role: 'user', content: 'improve it', created: 1 },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        created: 2,
        toolCalls: [
          call('patch_preset', {
            expectedRevision: 0,
            operations: [{ op: 'replace', path: '/temperature', value: 0.6 }],
            summary: 'Cooler sampling',
          }),
        ],
      },
      {
        id: 't',
        role: 'tool',
        content: '{"ok":true,"revision":1}',
        created: 3,
        toolCallId: 'call-1',
        toolName: 'patch_preset',
      },
      {
        id: 't2',
        role: 'tool',
        content: 'not json',
        created: 4,
        toolCallId: 'missing-call',
        toolName: 'read_preset',
      },
    ];

    const exchanges = correlateToolMessages(messages);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({
      name: 'patch_preset',
      result: { ok: true, revision: 1 },
    });
    expect(toolCallArguments(exchanges[0]!.call)).toMatchObject({ summary: 'Cooler sampling' });
    // A result whose call is gone still renders — with a null call, not a hole.
    expect(exchanges[1]).toMatchObject({ call: null, result: 'not json' });
  });
});
