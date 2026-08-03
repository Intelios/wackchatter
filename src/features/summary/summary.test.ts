import { describe, expect, test } from 'bun:test';
import type { AssembleResult } from '@shared/prompt/assemble.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import {
  packClassicSummaryChunk,
  resolveSummaryPrompt,
  summaryBacklog,
  summaryBaseControl,
  summaryMessages,
} from './summary.ts';

function message(id: string, mes: string, hidden = false): ChatMessage {
  return {
    id,
    name: id.startsWith('u') ? 'User' : 'Sera',
    is_user: id.startsWith('u'),
    is_system: hidden,
    mes,
    send_date: '',
  };
}

function assembly(
  messages: ChatMessage[],
  droppedMessages = 0,
): Extract<AssembleResult, { ok: true }> {
  return {
    ok: true,
    messages: messages.map((entry) => ({
      role: entry.is_user ? 'user' : 'assistant',
      content: entry.mes,
    })),
    tokenCounts: {},
    totalTokens: messages.length,
    droppedMessages,
    macroWarnings: [],
    variableUpdates: { local: {}, global: {}, localChanged: false, globalChanged: false },
  };
}

describe('summary transcript', () => {
  test('keeps native chronological turns and excludes hidden or blank messages', () => {
    const eligible = summaryMessages([
      message('a1', 'Hello there'),
      message('u1', 'secret', true),
      message('a2', '   '),
      message('u2', '  The gate opened  '),
    ]);

    expect(eligible.map(({ id, name, is_user, mes }) => ({ id, name, is_user, mes }))).toEqual([
      { id: 'a1', name: 'Sera', is_user: false, mes: 'Hello there' },
      { id: 'u2', name: 'User', is_user: true, mes: 'The gate opened' },
    ]);
  });

  test('starts after a known checkpoint and restarts when that id is missing', () => {
    const entries = summaryMessages([message('u1', 'one'), message('a1', 'two')]);
    expect(summaryBacklog(entries, { text: 'old', checkpointMessageId: 'u1' })).toEqual([
      entries[1]!,
    ]);
    expect(summaryBacklog(entries, { text: 'old', checkpointMessageId: 'deleted' })).toEqual(
      entries,
    );
  });

  test('builds a literal rolling base and replaces every words placeholder', () => {
    expect(summaryBaseControl('{{setvar::danger::yes}} The gate is open.')).toBe(
      'Existing rolling summary:\n{{setvar::danger::yes}} The gate is open.',
    );
    expect(summaryBaseControl('   ')).toBe('');
    expect(resolveSummaryPrompt('{{words}} then {{words}}', 225)).toBe('225 then 225');
  });
});

describe('Classic summary chunk packing', () => {
  test('keeps the oldest contiguous native turns and reuses the accepted assembly', () => {
    const entries = [message('u1', 'one'), message('a1', 'two'), message('u2', 'three')];
    const accepted = assembly(entries.slice(0, 2));
    const chunk = packClassicSummaryChunk(entries, (candidate) => {
      if (candidate.length === 2) return accepted;
      return assembly(candidate, candidate.length > 2 ? 1 : 0);
    });

    expect(chunk?.messages.map((entry) => entry.id)).toEqual(['u1', 'a1']);
    expect(chunk?.assembled).toBe(accepted);
    expect(chunk?.assembled.messages.map((entry) => entry.role)).toEqual(['user', 'assistant']);
  });

  test('returns null instead of skipping a first turn the complete prompt drops', () => {
    const entries = [message('u1', 'too large'), message('a1', 'later')];
    expect(packClassicSummaryChunk(entries, (candidate) => assembly(candidate, 1))).toBeNull();
  });

  test('covers hundreds of turns through sequential oldest-first chunks without gaps', () => {
    let remaining = Array.from({ length: 250 }, (_, index) =>
      message(index % 2 === 0 ? `u${index}` : `a${index}`, `turn ${index}`),
    );
    const processed: string[] = [];
    const chunkSizes: number[] = [];

    while (remaining.length > 0) {
      const chunk = packClassicSummaryChunk(remaining, (candidate) =>
        assembly(candidate, candidate.length > 37 ? 1 : 0),
      );
      if (!chunk) throw new Error('Expected another Classic chunk');
      chunkSizes.push(chunk.messages.length);
      processed.push(...chunk.messages.map((entry) => entry.id));
      remaining = remaining.slice(chunk.messages.length);
    }

    expect(chunkSizes).toEqual([37, 37, 37, 37, 37, 37, 28]);
    expect(processed).toEqual(
      Array.from({ length: 250 }, (_, index) => (index % 2 === 0 ? `u${index}` : `a${index}`)),
    );
  });
});
