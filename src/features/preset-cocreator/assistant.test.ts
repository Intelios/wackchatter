import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import {
  ASSISTANT_REQUEST_LIMIT,
  assistantWireMessages,
  parsePresetToolCall,
  presetReference,
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

  test('assistant turns have a hard provider-request limit', () => {
    expect(ASSISTANT_REQUEST_LIMIT).toBe(6);
  });
});
