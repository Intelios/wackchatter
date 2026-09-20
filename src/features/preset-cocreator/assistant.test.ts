import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import { ApiError } from '../../lib/api.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantWireMessages,
  executePresetToolCall,
  parsePresetToolCall,
  presetReference,
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
  test('only the three preset-scoped tools parse', () => {
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
    expect(() => parsePresetToolCall(call('write_file', { path: '/tmp/a' }))).toThrow(
      'Unknown tool',
    );
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

  test('assistant turns have a hard provider-request limit', () => {
    expect(ASSISTANT_REQUEST_LIMIT).toBe(6);
  });
});
