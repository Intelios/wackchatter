import { describe, expect, test } from 'bun:test';
import type { ProviderToolCall } from '@shared/providers/types.ts';
import type { PresetCocreatorMessage } from '@shared/types/preset-cocreator.ts';
import { assistantResponseMessage, assistantWireMessages } from './assistant.ts';
import { presetToolOperationId } from './toolHistory.ts';

function call(id: string, name = 'patch_preset'): ProviderToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}
function assistant(
  calls: ProviderToolCall[],
  turnId: string | undefined = 'turn',
): PresetCocreatorMessage {
  return { id: 'assistant', role: 'assistant', content: '', created: 1, toolCalls: calls, turnId };
}
function result(id: string, content = '{"ok":true}'): PresetCocreatorMessage {
  return { id: `result:${id}`, role: 'tool', content, created: 2, toolCallId: id };
}
const user: PresetCocreatorMessage = { id: 'user', role: 'user', content: 'Continue', created: 3 };
const committed = {
  revision: 4,
  operationId: 'tool:turn:patch',
  turnId: 'turn',
  source: 'assistant' as const,
  diff: [{ path: '/temperature', kind: 'replace' as const, before: 1, after: 0.5 }],
};

describe('Preset Co-Creator interrupted history', () => {
  test('unanswered calls receive a result before the next user message', () => {
    const messages = [assistant([call('read', 'read_preset')]), user];
    const original = structuredClone(messages);
    const wire = assistantWireMessages(messages);
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(wire[1]).toMatchObject({ tool_call_id: 'read' });
    expect(JSON.parse(wire[1]!.content!)).toMatchObject({ ok: false, interrupted: true });
    expect(messages).toEqual(original);
  });

  test('partial parallel results are retained and only the unanswered call is repaired', () => {
    const signed = {
      ...call('one'),
      extra_content: { google: { thought_signature: 'signature' } },
    };
    const wire = assistantWireMessages([assistant([signed, call('two')]), result('one'), user]);
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(wire[0]).toMatchObject({ tool_calls: [signed, call('two')] });
    expect(wire[1]!.content).toBe('{"ok":true}');
    expect(wire[2]).toMatchObject({ tool_call_id: 'two' });
    expect(JSON.parse(wire[2]!.content!)).toMatchObject({ interrupted: true });
  });

  test('a committed operation recovers the actual revision and diff without executing it', () => {
    const wire = assistantWireMessages([assistant([call('patch')]), user], [committed]);
    expect(JSON.parse(wire[1]!.content!)).toEqual({
      ok: true,
      revision: 4,
      diff: committed.diff,
      recovered: true,
    });
    expect(presetToolOperationId('turn', 'patch')).toBe(committed.operationId);
  });

  test('a lost response recorded as a failure is corrected when the operation committed', () => {
    const failure = result('patch', '{"ok":false,"outcomeUnknown":true,"error":"Connection lost"}');
    const wire = assistantWireMessages([assistant([call('patch')]), failure, user], [committed]);
    expect(JSON.parse(wire[1]!.content!)).toMatchObject({ ok: true, revision: 4, recovered: true });
    expect(failure.content).toContain('Connection lost');
  });

  test('the same provider call id in a different turn cannot borrow a committed edit', () => {
    const wire = assistantWireMessages(
      [assistant([call('patch')], 'another-turn'), user],
      [committed],
    );
    expect(JSON.parse(wire[1]!.content!)).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  test('older messages recover only an unambiguous recorded operation', () => {
    const legacy = assistant([call('patch')], undefined);
    delete legacy.turnId;
    expect(
      JSON.parse(assistantWireMessages([legacy, user], [committed])[1]!.content!),
    ).toMatchObject({ ok: true, revision: 4 });
    const otherReceipt = {
      ...committed,
      operationId: 'tool:other:patch',
      turnId: 'other',
      revision: 5,
    };
    expect(
      JSON.parse(assistantWireMessages([legacy, user], [committed, otherReceipt])[1]!.content!),
    ).toMatchObject({ ok: false, outcomeUnknown: true });
    const repeated = { ...legacy, id: 'another-assistant' };
    const wire = assistantWireMessages([legacy, user, repeated], [committed]);
    expect(JSON.parse(wire[1]!.content!)).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  test('orphaned and duplicate results stay in saved history but are excluded from requests', () => {
    const messages = [
      result('orphan'),
      assistant([call('patch')]),
      result('patch'),
      result('patch'),
      user,
    ];
    expect(assistantWireMessages(messages).map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'user',
    ]);
    expect(messages).toHaveLength(5);
  });

  test('a result after an intervening user turn cannot answer the earlier call', () => {
    const wire = assistantWireMessages([assistant([call('patch')]), user, result('patch')]);
    expect(wire.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(JSON.parse(wire[1]!.content!)).toMatchObject({ ok: false });
  });

  test('malformed batches never replay executable calls or standalone empty assistants', () => {
    for (const calls of [[call('')], [call('duplicate'), call('duplicate')]]) {
      const message = assistant(calls);
      expect(assistantWireMessages([message, user])).toEqual([
        { role: 'user', content: 'Continue' },
      ]);
      expect(message.toolCalls).toEqual(calls);
      const saved = assistantResponseMessage({
        content: '',
        reasoning: '',
        toolCalls: calls,
        done: true,
        finishReason: 'tool_calls',
      });
      expect(saved.incomplete).toBe('error');
      expect(saved.incompleteToolCalls).toEqual(calls);
      expect(saved.toolCalls).toBeUndefined();
    }
  });

  test('complete exchanges and provider metadata are unchanged across repeated serialization', () => {
    const message = {
      ...assistant([call('patch')]),
      reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque' }],
      extraContent: { google: { thought_signature: 'message-signature' } },
    };
    const messages = [message, result('patch'), user];
    const original = structuredClone(messages);
    const wire = assistantWireMessages(messages);
    expect(wire).toEqual(assistantWireMessages(messages));
    expect(wire[0]).toMatchObject({
      reasoning_details: message.reasoningDetails,
      extra_content: message.extraContent,
    });
    expect(messages).toEqual(original);
  });

  test('older interrupted messages with toolCalls cannot reintroduce a partial exchange', () => {
    const message: PresetCocreatorMessage = {
      ...assistant([call('patch')]),
      incomplete: 'stopped',
      content: 'Partial explanation',
      reasoningDetails: [{ type: 'reasoning.encrypted', data: 'partial' }],
    };
    expect(assistantWireMessages([message, user])).toEqual([
      { role: 'assistant', content: 'Partial explanation' },
      { role: 'user', content: 'Continue' },
    ]);
    expect(message.toolCalls).toHaveLength(1);
  });
});
