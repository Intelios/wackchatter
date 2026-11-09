import { describe, expect, test } from 'bun:test';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import { getPromptOrder, setPromptOrder, updatePrompt } from '@shared/prompt/preset-io.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type {
  PresetCocreatorDocument,
  PresetCocreatorMessage,
  PresetDraftRevision,
  PresetTest,
  PresetTestEvidence,
} from '@shared/types/preset-cocreator.ts';
import {
  compareLens,
  groupSessions,
  litPrompts,
  litRevisions,
  railRows,
  rerunPair,
  sessionSpend,
  spendCost,
  splitShared,
  staleRevision,
  wasSentBack,
} from './presetcc.ts';

function revision(
  n: number,
  preset: Preset,
  turnId: string | null,
  source: PresetDraftRevision['source'] = 'assistant',
): PresetDraftRevision {
  return {
    revision: n,
    created: n,
    source,
    summary: `r${n}`,
    turnId,
    operationId: `op${n}`,
    preset,
    diff: [],
  };
}

function evidence(over: Partial<PresetTestEvidence>): PresetTestEvidence {
  return {
    id: crypto.randomUUID(),
    created: 0,
    messageId: 'reply',
    swipeIndex: 0,
    draftRevision: 1,
    connectionId: 'c1',
    model: 'm1',
    generationId: 'g',
    kind: 'send',
    status: 'complete',
    responseText: '',
    messages: [],
    body: null,
    tokenCounts: {},
    totalTokens: 0,
    droppedMessages: 0,
    macroWarnings: [],
    ...over,
  };
}

function reply(swipes: string[], at: number, evidenceIds: string[]): ChatMessage {
  return {
    id: 'reply',
    name: 'Mika',
    is_user: false,
    is_system: false,
    mes: swipes[at]!,
    send_date: '',
    swipes,
    swipe_id: at,
    swipe_info: evidenceIds.map((id) => ({
      send_date: '',
      extra: { preset_test_evidence_id: id },
    })),
    extra: { preset_test_evidence_id: evidenceIds[at] },
  };
}

function testWith(messages: ChatMessage[], items: PresetTestEvidence[]): PresetTest {
  return {
    id: 't1',
    title: 'Mika',
    created: 0,
    modified: 0,
    scenario: {} as PresetTest['scenario'],
    presetSource: { kind: 'draft' },
    testingSettings: { model: null, maxTokens: 1, temperature: 1, reasoningEffort: 'auto' },
    composerDraft: '',
    localVariables: {},
    globalVariables: {},
    messages,
    evidence: items,
  };
}

const user: ChatMessage = {
  id: 'u',
  name: 'You',
  is_user: true,
  is_system: false,
  mes: 'Hi',
  send_date: '',
  swipes: ['Hi'],
  swipe_id: 0,
  swipe_info: [{ send_date: '' }],
};

describe('the rail', () => {
  test('lists the live order, switched-off rows included', () => {
    const preset = createDefaultPreset();
    const rows = railRows(preset);
    expect(rows.map((row) => row.identifier)).toEqual(
      getPromptOrder(preset).map((e) => e.identifier),
    );
    expect(rows.find((row) => row.identifier === 'chatHistory')?.marker).toBe(true);
  });

  test('lights what the last turn changed, both of its edits', () => {
    const base = createDefaultPreset();
    const one = updatePrompt(base, 'main', { content: 'one' });
    const two = updatePrompt(one, 'jailbreak', { content: 'two' });
    const history = [
      revision(1, base, null, 'initial'),
      revision(2, one, 'turn'),
      revision(3, two, 'turn'),
    ];
    expect(litRevisions(history, 3).map((r) => r.revision)).toEqual([2, 3]);
    expect([...litPrompts(history, 3)].sort()).toEqual(['jailbreak', 'main']);
    expect([...litPrompts(history, 2)]).toEqual(['main']);
    expect(litPrompts(history, 1).size).toBe(0);
  });

  test('a manual edit lights only itself', () => {
    const base = createDefaultPreset();
    const off = setPromptOrder(
      base,
      getPromptOrder(base).map((e) => (e.identifier === 'main' ? { ...e, enabled: false } : e)),
    );
    const history = [revision(1, base, null, 'initial'), revision(2, off, null, 'manual')];
    expect([...litPrompts(history, 2)]).toEqual(['main']);
  });

  test('the lens marks changed rows and what only the other has', () => {
    const base = createDefaultPreset();
    const here = updatePrompt(base, 'main', { content: 'changed' });
    const there = {
      ...base,
      prompts: [
        ...(base.prompts ?? []),
        { identifier: 'extra', name: 'Extra', content: 'x', role: 'system' },
      ],
    } as Preset;
    const lens = compareLens(here, there);
    expect(lens.marks.get('main')).toBe('changed');
    expect(lens.marks.get('jailbreak')).toBe('same');
    expect(lens.onlyThere.map((row) => row.identifier)).toEqual(['extra']);
  });
});

describe('the bench', () => {
  test('a test on the draft is out of date when its reply ran on an older revision', () => {
    const e = evidence({ draftRevision: 3 });
    const t = testWith([user, reply(['a'], 0, [e.id])], [e]);
    expect(staleRevision(t, 5)).toBe(3);
    expect(staleRevision(t, 3)).toBeNull();
    expect(staleRevision({ ...t, presetSource: { kind: 'revision', revision: 1 } }, 5)).toBeNull();
  });

  test('a greeting alone is never out of date', () => {
    const greeting = { ...reply(['Hello'], 0, []), extra: {} };
    expect(staleRevision(testWith([greeting], []), 9)).toBeNull();
  });

  test('a rerun on a newer revision reads as before and after', () => {
    const old = evidence({ draftRevision: 5, swipeIndex: 0 });
    const fresh = evidence({ draftRevision: 6, swipeIndex: 1, kind: 'swipe' });
    const message = reply(['Same.\n\nOld ending.', 'Same.\n\nNew ending.'], 1, [old.id, fresh.id]);
    const pair = rerunPair(testWith([user, message], [old, fresh]));
    expect(pair).toEqual({
      messageId: 'reply',
      shared: 'Same.',
      before: { text: 'Old ending.', revision: 5 },
      after: { text: 'New ending.', revision: 6 },
    });
  });

  test('an ordinary swipe on the same revision is not a rerun', () => {
    const old = evidence({ draftRevision: 6, swipeIndex: 0 });
    const fresh = evidence({ draftRevision: 6, swipeIndex: 1, kind: 'swipe' });
    const message = reply(['a', 'b'], 1, [old.id, fresh.id]);
    expect(rerunPair(testWith([user, message], [old, fresh]))).toBeNull();
    // Back on the first swipe, the pair is gone.
    expect(
      rerunPair(testWith([user, reply(['a', 'b'], 0, [old.id, fresh.id])], [old, fresh])),
    ).toBeNull();
  });

  test('splitting keeps at least one paragraph on each side', () => {
    expect(splitShared('Same', 'Same')).toEqual({ shared: '', before: 'Same', after: 'Same' });
    expect(splitShared('A\n\nB', 'A\n\nC\n\nD')).toEqual({
      shared: 'A',
      before: 'B',
      after: 'C\n\nD',
    });
  });

  test('a reply counts as sent back only as it read when sent', () => {
    const message = reply(['first', 'second'], 0, ['x', 'y']);
    const sent: PresetCocreatorMessage = {
      id: 'm',
      role: 'report',
      content: '',
      created: 0,
      report: {
        id: 'r',
        created: 0,
        testId: 't1',
        throughMessageId: 'reply',
        note: '',
        replyText: 'first',
        includeTranscript: false,
        includePrompt: true,
        includeDiagnostics: true,
      },
    };
    expect(wasSentBack([sent], 't1', message)).toBe(true);
    expect(wasSentBack([sent], 't1', { ...message, mes: 'second', swipe_id: 1 })).toBe(false);
    expect(wasSentBack([sent], 't2', message)).toBe(false);
  });
});

describe('what it cost', () => {
  test('includes completed, failed and stopped compaction usage without treating estimates as billed counts', () => {
    const document = {
      messages: [],
      tests: [],
      compaction: {
        automatic: true,
        history: [
          {
            id: 'complete',
            status: 'complete',
            model: { connectionId: 'c', modelId: 'm' },
            beforeTokens: 9000,
            afterTokens: 3000,
            inputTokens: 7000,
            outputTokens: 200,
          },
          {
            id: 'stopped',
            status: 'aborted',
            model: { connectionId: 'c', modelId: 'm' },
            beforeTokens: 8000,
            inputTokens: 6000,
            outputTokens: 20,
          },
          {
            id: 'failed',
            status: 'failed',
            model: { connectionId: 'c', modelId: 'm' },
            beforeTokens: 8000,
          },
        ],
      },
    } as unknown as PresetCocreatorDocument;
    expect(sessionSpend(document)).toEqual([
      { connectionId: 'c', model: 'm', inputTokens: 13000, outputTokens: 220 },
    ]);
  });
  test('sums the Co-Creator and the bench per model, and prices what it can', () => {
    const document = {
      messages: [
        {
          id: 'a',
          role: 'assistant',
          content: '',
          created: 0,
          usage: { connectionId: 'c1', model: 'big', inputTokens: 1000, outputTokens: 100 },
        },
        {
          id: 'b',
          role: 'assistant',
          content: '',
          created: 0,
          usage: { connectionId: 'c1', model: 'big', inputTokens: 500, outputTokens: 50 },
        },
      ],
      tests: [
        testWith(
          [],
          [
            evidence({
              connectionId: 'c2',
              model: 'small',
              promptTokens: 2000,
              completionTokens: 200,
            }),
            evidence({}),
          ],
        ),
      ],
    } as unknown as PresetCocreatorDocument;
    const spend = sessionSpend(document);
    expect(spend).toEqual([
      { connectionId: 'c1', model: 'big', inputTokens: 1500, outputTokens: 150 },
      { connectionId: 'c2', model: 'small', inputTokens: 2000, outputTokens: 200 },
    ]);
    const cost = spendCost(spend, (entry) =>
      entry.model === 'big' ? { prompt: 0.00001, completion: 0.00002 } : null,
    );
    expect(cost?.usd).toBeCloseTo(0.018);
    expect(cost?.complete).toBe(false);
    expect(spendCost(spend, () => null)).toBeNull();
  });
});

describe('sessions', () => {
  test('group by the preset they work on, newest group first', () => {
    const base = { title: '', created: 0, draftRevision: 1, testCount: 0, lastMessage: '' };
    const groups = groupSessions(
      [
        { ...base, id: 'a', modified: 1, sourcePresetId: 'A.json', targetPresetId: 'A.json' },
        { ...base, id: 'b', modified: 3, sourcePresetId: null, targetPresetId: null },
        { ...base, id: 'c', modified: 2, sourcePresetId: 'A.json', targetPresetId: 'A.json' },
      ],
      [{ id: 'A.json', name: 'Alpha' } as never],
    );
    expect(groups.map((g) => [g.name, g.sessions.map((s) => s.id)])).toEqual([
      ['The built-in default', ['b']],
      ['Alpha', ['c', 'a']],
    ]);
  });
});
