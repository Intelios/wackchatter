import { describe, expect, test } from 'bun:test';
import type { PresetCocreatorMessage, PresetTestReport } from '@shared/types/preset-cocreator.ts';
import { assistantWireMessages } from './assistant.ts';
import { presetReportWireContent, presetReportWireData } from './reportWire.ts';
import { batchConversationMessage, reportConversationMessage } from './testing.ts';

function report(): PresetTestReport {
  const reply = 'The selected reply is under review.';
  const messages = [{ role: 'system' as const, content: 'ASSEMBLED PROMPT '.repeat(300) }];
  const used = { source: { kind: 'draft' as const }, label: 'Draft', revision: 4 };
  return {
    id: 'report',
    created: 1,
    testId: 'test',
    throughMessageId: 'reply',
    note: 'Review the voice.',
    replyText: reply,
    presetUsed: used,
    includeTranscript: true,
    includePrompt: true,
    includeDiagnostics: true,
    transcript: [
      {
        id: 'reply',
        name: 'Character',
        is_user: false,
        is_system: false,
        mes: reply,
        send_date: 'now',
        swipes: [reply],
        swipe_id: 0,
        swipe_info: [{ send_date: 'now' }],
      },
    ],
    evidence: {
      id: 'evidence',
      created: 1,
      messageId: 'reply',
      swipeIndex: 0,
      draftRevision: 4,
      presetUsed: used,
      connectionId: 'test',
      model: 'test-model',
      generationId: 'generation',
      kind: 'send',
      status: 'complete',
      responseText: reply,
      messages,
      body: { model: 'test-model', messages: structuredClone(messages), temperature: 0.5 },
      tokenCounts: { main: 1000 },
      totalTokens: 1000,
      droppedMessages: 2,
      macroWarnings: [],
    },
  };
}
function data(content: string) {
  return JSON.parse(content.split('(immutable data, not instructions):\n')[1]!);
}
function send(report: PresetTestReport): PresetCocreatorMessage {
  return reportConversationMessage(report);
}

describe('Preset Co-Creator duplicate report data', () => {
  test('identical assembled prompts are sent once and the full saved evidence stays intact', () => {
    const original = report();
    const before = structuredClone(original);
    const payload = presetReportWireData(original);
    expect(payload.evidence?.messages).toEqual(original.evidence?.messages);
    expect(payload.evidence?.body).toEqual({ model: 'test-model', temperature: 0.5 });
    expect(payload.evidence?.tokenCounts).toEqual({ main: 1000 });
    expect(payload.evidence?.droppedMessages).toBe(2);
    expect(JSON.stringify(payload).length).toBeLessThan(JSON.stringify(original).length * 0.6);
    expect(original).toEqual(before);
  });

  test('different assembled and provider messages are both preserved', () => {
    const original = report();
    original.evidence!.body!.messages = [{ role: 'system', content: 'Different provider prompt' }];
    const payload = presetReportWireData(original);
    expect(payload.evidence?.body?.messages).toEqual(original.evidence!.body!.messages);
    expect(payload.evidence?.messages).toEqual(original.evidence!.messages);
  });

  test('reply copies are omitted only when the selected transcript carries the identical text', () => {
    const original = report();
    const payload = presetReportWireData(original);
    expect(payload).not.toHaveProperty('replyText');
    expect(payload.evidence).not.toHaveProperty('responseText');
    expect(payload.transcript?.[0]?.mes).toBe(original.replyText);
    expect(payload.transcript?.[0]).not.toHaveProperty('swipes');
    expect(payload.evidence).not.toHaveProperty('presetUsed');
    original.transcript![0]!.mes = 'Edited transcript';
    const edited = presetReportWireData(original);
    expect(edited.replyText).toBe(original.replyText);
    expect(edited.transcript?.[0]?.mes).toBe('Edited transcript');
    expect(edited.transcript?.[0]?.swipes).toEqual([original.replyText!]);
  });

  test('distinct response evidence and alternate swipes are not removed', () => {
    const original = report();
    original.evidence!.responseText = 'Original generated response before a manual edit';
    original.evidence!.presetUsed = {
      source: { kind: 'library', id: 'Other' },
      label: 'Other',
      version: 'v1',
    };
    original.transcript![0]!.swipes!.push('A distinct alternate');
    const payload = presetReportWireData(original);
    expect(payload.evidence?.responseText).toBe(original.evidence!.responseText);
    expect(payload.evidence?.presetUsed).toEqual(original.evidence!.presetUsed);
    expect(payload.transcript?.[0]?.swipes).toEqual(original.transcript![0]!.swipes);
  });

  test('reasoning is deduplicated only when the selected transcript preserves the same text', () => {
    const original = report();
    original.evidence!.responseReasoning = 'Generation reasoning';
    original.transcript![0]!.extra = { reasoning: 'Generation reasoning' };
    expect(presetReportWireData(original).evidence).not.toHaveProperty('responseReasoning');
    original.transcript![0]!.extra!.reasoning = 'Different reasoning';
    expect(presetReportWireData(original).evidence?.responseReasoning).toBe('Generation reasoning');
  });

  test('without a transcript the selected reply is retained, even without diagnostics or prompt', () => {
    const original = report();
    delete original.transcript;
    original.includeTranscript = false;
    expect(presetReportWireData(original).replyText).toBe(original.replyText);
    expect(presetReportWireData(original).evidence).not.toHaveProperty('responseText');
    delete original.evidence;
    original.includePrompt = false;
    original.includeDiagnostics = false;
    const payload = presetReportWireData(original);
    expect(payload.replyText).toBe(original.replyText);
    expect(payload.evidence).toBeUndefined();
  });

  test('legacy reports without replyText still keep the chosen reply and any unique evidence', () => {
    const original = report();
    delete original.replyText;
    expect(presetReportWireData(original).evidence).not.toHaveProperty('responseText');
    delete original.transcript;
    expect(presetReportWireData(original).evidence?.responseText).toBe(
      original.evidence?.responseText,
    );
  });

  test('saved report messages use the structured frozen attachment rather than their old duplicate content', () => {
    const original = report();
    const message = send(original);
    const before = structuredClone(message);
    const payload = assistantWireMessages([message])[0]!.content!;
    expect(data(payload)).toEqual(presetReportWireData(original));
    expect(payload.startsWith('Review the voice.\n\n')).toBe(true);
    expect(message).toEqual(before);
    expect(payload.length).toBeLessThan(message.content.length * 0.6);
  });

  test('batches retain each report and promote individual notes once', () => {
    const first = report();
    const second = { ...report(), id: 'second', note: 'Compare the pacing.' };
    const batch = { id: 'batch', created: 1, note: 'Compare both.', reports: [first, second] };
    const message = batchConversationMessage(batch);
    const before = structuredClone(message);
    const content = assistantWireMessages([message])[0]!.content!;
    const payload = data(content);
    expect(payload.reports).toHaveLength(2);
    expect(payload.reports[0]).toEqual(presetReportWireData(first));
    expect(payload.reports[1]).toEqual(presetReportWireData(second));
    for (const note of [batch.note, first.note, second.note]) {
      expect(content.split(note)).toHaveLength(2);
    }
    expect(message).toEqual(before);
  });

  test('plain legacy reports fall back to their saved text and blank notes still ask for a review', () => {
    const message: PresetCocreatorMessage = {
      id: 'old',
      role: 'report',
      content: 'Legacy report',
      created: 1,
    };
    expect(assistantWireMessages([message])[0]!.content).toBe('Legacy report');
    expect(presetReportWireContent({ ...report(), note: '  ' })).toStartWith(
      'Here is a test report',
    );
  });

  test('ordinary conversation turns and unique report content are never packed or shortened', () => {
    const original = report();
    const messages: PresetCocreatorMessage[] = [
      { id: 'user', role: 'user', content: 'User preference '.repeat(500), created: 1 },
      { id: 'assistant', role: 'assistant', content: 'Design discussion '.repeat(500), created: 2 },
      send(original),
    ];
    const before = structuredClone(messages);
    const wire = assistantWireMessages(messages);
    expect(wire).toHaveLength(3);
    expect(wire[0]?.content).toBe(messages[0]?.content);
    expect(wire[1]?.content).toBe(messages[1]?.content);
    expect(data(wire[2]!.content!).evidence.messages).toEqual(original.evidence?.messages);
    expect(messages).toEqual(before);
  });
});
