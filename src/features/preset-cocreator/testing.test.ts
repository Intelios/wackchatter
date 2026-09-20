import { describe, expect, test } from 'bun:test';
import { assemblePrompt } from '@shared/prompt/assemble.ts';
import { createDefaultPreset } from '@shared/prompt/defaults.ts';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { Connection } from '@shared/providers/types.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { Persona } from '@shared/types/chat.ts';
import type { Preset } from '@shared/types/preset.ts';
import type { RegexScript } from '@shared/types/regex.ts';
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from '@shared/types/regex.ts';
import type { WorldInfoEntry, WorldInfoSettings } from '@shared/types/worldinfo.ts';
import { createWorldInfoEntry, DEFAULT_WI_SETTINGS, WI_POSITION } from '@shared/types/worldinfo.ts';
import type { WorldInfoSource } from '@shared/worldinfo/activate.ts';
import { worldInfoForChat } from '../lore/worldInfoForChat.ts';
import {
  appendPresetTestUserMessage,
  buildPresetTestReport,
  createPresetTest,
  editPresetTestMessage,
  type PreparedPresetTestRequest,
  preparePresetTestRequest,
  reportConversationMessage,
  restartPresetTest,
  selectPresetTestSwipe,
  settlePresetTestGeneration,
  updateProposedTest,
} from './testing.ts';

/** One token per word, so the parity assertions read as word counts. */
const countTokens: TokenCounter = {
  countText: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
  countChat: (messages) =>
    messages.reduce((total, message) => total + countText0(message.content), 0),
};
const countText0 = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function makeCharacter(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: 'A forest guardian.',
    personality: 'Kind and watchful.',
    scenario: 'A glade in Eldoria.',
    first_mes: 'Welcome, {{user}}. The trees missed you.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['*She waves from the canopy.*', 'You again, {{user}}?'],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

const persona: Persona = {
  id: 'p1',
  name: 'Ari',
  description: 'A scholar with ink-stained fingers.',
  avatar: null,
};

const connection: Connection = {
  id: 'conn-1',
  name: 'Test connection',
  provider: 'custom',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
};

let nextLoreUid = 0;
function loreEntry(partial: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return { ...createWorldInfoEntry(nextLoreUid++), content: 'glade lore', ...partial };
}

function loreSource(entries: WorldInfoEntry[]): WorldInfoSource {
  const record: Record<string, WorldInfoEntry> = {};
  for (const entry of entries) record[String(entry.uid)] = entry;
  return { kind: 'global', name: 'Test book', book: { name: 'Test book', entries: record } };
}

function regexScript(overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id: 'rx-1',
    scriptName: 'test script',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: REGEX_SUBSTITUTE.NONE,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  };
}

function scenario(overrides: Partial<Parameters<typeof createPresetTest>[0]> = {}) {
  return {
    characterId: 'Seraphina.png',
    character: makeCharacter(),
    greetingIndex: 0,
    persona: null,
    worldInfoSources: [] as WorldInfoSource[],
    worldInfoSettings: { ...DEFAULT_WI_SETTINGS } as WorldInfoSettings,
    regexScripts: [] as RegexScript[],
    variables: { local: {}, global: { sharedTheme: 'dawn' } },
    ...overrides,
  };
}

/** Prepare a send the way usePresetTesting does, with the dispatch-time preset captured. */
function prepareSend(
  test: ReturnType<typeof createPresetTest>,
  preset: Preset,
  overrides: Partial<Parameters<typeof preparePresetTestRequest>[0]> = {},
): PreparedPresetTestRequest | null {
  return preparePresetTestRequest({
    test,
    kind: 'send',
    preset,
    connection,
    countTokens,
    ...overrides,
  });
}

describe('scenario snapshots', () => {
  test('a test freezes the scenario: later changes to the inputs do not leak in', () => {
    const input = scenario();
    const test = createPresetTest(input);

    input.character.name = 'Someone Else';
    input.variables.global.sharedTheme = 'dusk';
    input.worldInfoSources.push(loreSource([loreEntry({ constant: true })]));

    expect(test.scenario.character.name).toBe('Seraphina');
    expect(test.scenario.variables.global).toEqual({ sharedTheme: 'dawn' });
    expect(test.scenario.worldInfoSources).toHaveLength(0);
  });

  test('the chosen greeting opens the transcript, resolved only at assembly time', () => {
    const test = createPresetTest(scenario({ greetingIndex: 1 }));

    expect(test.messages).toHaveLength(1);
    expect(test.messages[0]!.mes).toBe('*She waves from the canopy.*');
    // The alternate stays the only swipe: choosing it is not swiping within all greetings.
    expect(test.messages[0]!.swipes).toEqual(['*She waves from the canopy.*']);

    const macroTest = createPresetTest(scenario({ greetingIndex: 2 }));
    // Macros survive in storage and resolve during packing, like a normal chat's greeting.
    expect(macroTest.messages[0]!.mes).toContain('{{user}}');
    const prepared = prepareSend(macroTest, createDefaultPreset());
    expect(
      prepared?.assembled.messages.some((message) => message.content.includes('{{user}}')),
    ).toBe(false);
  });

  test('restart keeps the same scenario snapshot and starts a fresh transcript', () => {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(test, 'hello', createDefaultPreset())!;
    const restarted = restartPresetTest(withUser);

    expect(restarted.scenario).toEqual(test.scenario);
    expect(restarted.id).not.toBe(test.id);
    expect(restarted.messages).toHaveLength(1);
    expect(restarted.evidence).toHaveLength(0);
  });
});

describe('send-time macro resolution and variable isolation', () => {
  test('outgoing text resolves once at send; setvar writes stay inside the test', () => {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(
      test,
      '{{setvar::mood::playful}}{{char}}, {{getglobalvar::sharedTheme}} mood?',
      createDefaultPreset(),
    )!;

    const sent = withUser.messages.at(-1)!;
    expect(sent.is_user).toBe(true);
    expect(sent.mes).toBe('Seraphina, dawn mood?');
    expect(withUser.localVariables).toEqual({ mood: 'playful' });
    // The scenario's frozen copy is the write target for locals, never the app's globals.
    expect(withUser.scenario.variables.global).toEqual({ sharedTheme: 'dawn' });
  });

  test('a global write lands in the test private copy, not the original map', () => {
    const frozen = { sharedTheme: 'dawn' };
    const test = createPresetTest(scenario({ variables: { local: {}, global: frozen } }));
    const withUser = appendPresetTestUserMessage(
      test,
      '{{setglobalvar::sharedTheme::storm}} noted',
      createDefaultPreset(),
    )!;

    expect(withUser.globalVariables.sharedTheme).toBe('storm');
    expect(frozen.sharedTheme).toBe('dawn');
  });

  test('a persona is recorded on the user message it was sent as', () => {
    const bare = createPresetTest(scenario());
    const anonymous = appendPresetTestUserMessage(bare, 'hi', createDefaultPreset())!;
    expect(anonymous.messages.at(-1)!.name).toBe('User');
    expect(anonymous.messages.at(-1)!.persona_id).toBeNull();

    const withPersona = createPresetTest(scenario({ persona }));
    const named = appendPresetTestUserMessage(withPersona, 'hi', createDefaultPreset())!;
    expect(named.messages.at(-1)!.name).toBe('Ari');
    expect(named.messages.at(-1)!.persona_id).toBe('p1');
  });

  test('editing a message never resolves macros again', () => {
    const test = createPresetTest(scenario());
    const edited = editPresetTestMessage(test, test.messages[0]!.id, 'Hello {{char}}!');

    expect(edited.messages[0]!.mes).toBe('Hello {{char}}!');
  });
});

describe('assembly parity', () => {
  test('the test request is the request normal chat generation would build', () => {
    const source = loreSource([
      loreEntry({ constant: true, content: 'ALWAYS ON', position: WI_POSITION.before }),
      loreEntry({ key: ['canopy'], content: 'CANOPY LORE' }),
    ]);
    const scripts = [
      regexScript({
        findRegex: '/whispers/g',
        replaceString: 'SHOUTS',
        placement: [REGEX_PLACEMENT.USER_INPUT],
      }),
    ];
    const test = createPresetTest(scenario({ worldInfoSources: [source], regexScripts: scripts }));
    const withUser = appendPresetTestUserMessage(
      test,
      'the canopy whispers',
      createDefaultPreset(),
    )!;
    const preset = createDefaultPreset();

    const prepared = prepareSend(withUser, preset);
    expect(prepared?.assembled.ok).toBe(true);
    if (!prepared?.assembled.ok) return;

    // The same two calls useChat makes, with the same inputs: worldInfoForChat then
    // assemblePrompt. Anything the test path does differently shows up here as a diff.
    const lore = worldInfoForChat({
      sources: withUser.scenario.worldInfoSources,
      messages: prepared.messages,
      settings: withUser.scenario.worldInfoSettings,
      preset,
      chatId: withUser.id,
      countTokens,
    });
    const direct = assemblePrompt({
      preset,
      character: withUser.scenario.character,
      persona: null,
      messages: prepared.messages,
      worldInfoBefore: lore?.before,
      worldInfoAfter: lore?.after,
      worldInfoDepth: lore?.depth,
      memoryMode: 'off',
      localVariables: withUser.localVariables,
      globalVariables: withUser.globalVariables,
      countTokens,
      seed: withUser.id,
      regexScripts: withUser.scenario.regexScripts,
    });
    expect(prepared.assembled.messages).toEqual(direct.messages);

    const prompt = JSON.stringify(prepared.assembled.messages);
    expect(prompt).toContain('ALWAYS ON');
    expect(prompt).toContain('CANOPY LORE');
    expect(prompt).toContain('the canopy');
    // Prompt-only regex ran during packing: the model sees the rewritten word.
    expect(prompt).toContain('SHOUTS');
    expect(prompt).not.toContain('whispers');
  });

  test('the placeholder excludes itself from its own prompt', () => {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(test, 'hello', createDefaultPreset())!;
    const prepared = prepareSend(withUser, createDefaultPreset());

    expect(prepared?.target.mes).toBe('');
    expect(prepared?.assembled.messages.every((message) => message.content.trim() !== '')).toBe(
      true,
    );
  });

  test('generation captures the preset at dispatch; later edits cannot reach it', () => {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(test, 'hello', createDefaultPreset())!;
    const preset = createDefaultPreset();
    const revision = { revision: 7, preset } as const;
    const prepared = prepareSend(withUser, revision.preset)!;

    // The caller keeps editing after dispatch — the prepared snapshot must not move.
    preset.temperature = 0.01;
    preset.prompts = [];

    expect(prepared.body).not.toBeNull();
    expect((prepared.body as Record<string, unknown>).temperature).not.toBe(0.01);
  });
});

describe('swipes, regenerate and failure recovery', () => {
  function settledTest() {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(test, 'hello', createDefaultPreset())!;
    const prepared = prepareSend(withUser, createDefaultPreset())!;
    return { withUser, prepared };
  }

  test('regenerate replaces the response and drops its alternates, keeping evidence', () => {
    const { withUser, prepared } = settledTest();
    const settled = settlePresetTestGeneration({
      test: withUser,
      prepared,
      evidence: [],
      text: 'first reply',
      reasoning: '',
    });

    const regenerate = preparePresetTestRequest({
      test: settled,
      kind: 'regenerate',
      preset: createDefaultPreset(),
      connection,
      countTokens,
    })!;
    const reply = regenerate.messages.at(-1)!;
    expect(regenerate.replacedResponse).toBe('first reply');
    // resetSwipes: the old reply is gone as an alternate, exactly like the chat reducer.
    expect(reply.swipes).toEqual(['']);
    expect(reply.swipe_id).toBe(0);
  });

  test('an overswipe appends and keeps every alternate cached', () => {
    const { withUser, prepared } = settledTest();
    const settled = settlePresetTestGeneration({
      test: withUser,
      prepared,
      evidence: [],
      text: 'main reply',
      reasoning: '',
      alternates: [
        {
          text: 'alternate one',
          info: { send_date: 't' },
          evidence: {
            id: 'ev-alt',
            created: 1,
            messageId: prepared.target.id,
            swipeIndex: 1,
            draftRevision: 0,
            connectionId: 'conn-1',
            model: 'test-model',
            generationId: 'gen-1',
            kind: 'send',
            status: 'complete',
            responseText: 'alternate one',
            messages: [],
            body: null,
            tokenCounts: {},
            totalTokens: 0,
            droppedMessages: 0,
            macroWarnings: [],
          },
        },
      ],
    });

    const reply = settled.messages.at(-1)!;
    expect(reply.swipes).toEqual(['main reply', 'alternate one']);
    expect(reply.swipe_id).toBe(0);
    // Each swipe carries its own evidence identity, so the inspector can open either.
    expect(reply.swipe_info?.[1]?.extra?.preset_test_evidence_id).toBe('ev-alt');

    const swiping = preparePresetTestRequest({
      test: settled,
      kind: 'swipe',
      preset: createDefaultPreset(),
      connection,
      countTokens,
    })!;
    expect(swiping.messages.at(-1)!.swipes).toEqual(['main reply', 'alternate one', '']);
    expect(swiping.messages.at(-1)!.swipe_id).toBe(2);

    // Swiping within the cached array moves the selection without generating.
    const selected = selectPresetTestSwipe(settled, reply.id, 1);
    expect(selected.messages.at(-1)!.swipe_id).toBe(1);
    expect(selected.messages.at(-1)!.mes).toBe('alternate one');
  });

  test('a failed generation undoes exactly what starting it did', () => {
    const { withUser, prepared } = settledTest();
    const before = withUser.messages.length;
    const settled = settlePresetTestGeneration({
      test: withUser,
      prepared,
      evidence: [],
      text: '',
      reasoning: '',
    });

    expect(settled.messages).toHaveLength(before);
    expect(settled.messages.at(-1)!.is_user).toBe(true);
  });

  test('a partial reply survives an aborted generation, labeled with its evidence', () => {
    const { withUser, prepared } = settledTest();
    const settled = settlePresetTestGeneration({
      test: withUser,
      prepared,
      evidence: [
        {
          id: 'ev-1',
          created: 1,
          messageId: prepared.target.id,
          swipeIndex: 0,
          draftRevision: 4,
          connectionId: 'conn-1',
          model: 'test-model',
          generationId: 'gen-1',
          kind: 'send',
          status: 'aborted',
          responseText: 'partial',
          messages: [],
          body: null,
          tokenCounts: {},
          totalTokens: 0,
          droppedMessages: 0,
          macroWarnings: [],
        },
      ],
      text: 'partial',
      reasoning: 'half a thought',
    });

    const reply = settled.messages.at(-1)!;
    expect(reply.mes).toBe('partial');
    expect(reply.extra?.preset_test_evidence_id).toBe('ev-1');
    expect(reply.extra?.preset_revision).toBe(4);
    expect(reply.extra?.model).toBe('test-model');
    expect(settled.evidence[0]!.responseText).toBe('partial');
  });
});

describe('shared reports', () => {
  function sharedTest() {
    const test = createPresetTest(scenario());
    const withUser = appendPresetTestUserMessage(test, 'hello', createDefaultPreset())!;
    const prepared = prepareSend(withUser, createDefaultPreset())!;
    const evidence = {
      id: 'ev-1',
      created: 1,
      messageId: prepared.target.id,
      swipeIndex: 0,
      draftRevision: 4,
      connectionId: 'conn-1',
      model: 'test-model',
      generationId: 'gen-1',
      kind: 'send' as const,
      status: 'complete' as const,
      responseText: 'the reply under review',
      messages: [{ role: 'system' as const, content: 'SECRET ASSEMBLED PROMPT' }],
      body: { model: 'test-model', temperature: 1 },
      tokenCounts: { main: 10 },
      totalTokens: 12,
      droppedMessages: 0,
      macroWarnings: [],
    };
    const settled = settlePresetTestGeneration({
      test: withUser,
      prepared,
      evidence: [evidence],
      text: 'the reply under review',
      reasoning: '',
    });
    return { settled, prepared };
  }

  test('a report is an immutable attachment: later edits do not rewrite it', () => {
    const { settled } = sharedTest();
    const report = buildPresetTestReport({
      test: settled,
      throughMessageId: settled.messages.at(-1)!.id,
      note: 'feels flat',
      includeTranscript: true,
      includePrompt: true,
      includeDiagnostics: true,
    })!;
    const snapshot = structuredClone(report);

    // Swipes, edits, later turns — none of it reaches what was already shared.
    const edited = editPresetTestMessage(
      settled,
      settled.messages.at(-1)!.id,
      'completely rewritten later',
    );
    const next = appendPresetTestUserMessage(edited, 'another turn', createDefaultPreset())!;

    expect(report).toEqual(snapshot);
    expect(report.transcript?.at(-1)?.mes).toBe('the reply under review');
    expect(next.messages.at(-1)!.mes).toBe('another turn');
  });

  test('omitted sections leave the report without them', () => {
    const { settled } = sharedTest();
    const report = buildPresetTestReport({
      test: settled,
      throughMessageId: settled.messages.at(-1)!.id,
      note: '',
      includeTranscript: false,
      includePrompt: false,
      includeDiagnostics: false,
    })!;

    expect(report.transcript).toBeUndefined();
    // With neither prompt nor diagnostics wanted, no evidence rides along at all.
    expect(report.evidence).toBeUndefined();

    // Keep diagnostics, drop the prompt: the evidence travels, stripped of the request.
    const withoutPrompt = buildPresetTestReport({
      test: settled,
      throughMessageId: settled.messages.at(-1)!.id,
      note: '',
      includeTranscript: false,
      includePrompt: false,
      includeDiagnostics: true,
    })!;
    expect(withoutPrompt.evidence?.messages).toEqual([]);
    expect(withoutPrompt.evidence?.body).toBeNull();
    expect(withoutPrompt.evidence?.tokenCounts).toEqual({ main: 10 });
    expect(withoutPrompt.evidence?.droppedMessages).toBe(0);

    const minimal = reportConversationMessage(report);
    expect(minimal.role).toBe('report');
    expect(minimal.report?.id).toBe(report.id);
  });

  test('the transcript is cut at the chosen response, not the whole test', () => {
    const { settled } = sharedTest();
    const withNext = appendPresetTestUserMessage(settled, 'later turn', createDefaultPreset())!;
    const replyId = settled.messages.at(-1)!.id;

    const report = buildPresetTestReport({
      test: withNext,
      throughMessageId: replyId,
      note: '',
      includeTranscript: true,
      includePrompt: false,
      includeDiagnostics: false,
    })!;

    expect(report.transcript!.at(-1)!.id).toBe(replyId);
    expect(report.transcript!.some((message) => message.mes === 'later turn')).toBe(false);
  });

  test('a message that is not in the test cannot anchor a report', () => {
    const { settled } = sharedTest();
    expect(() =>
      buildPresetTestReport({
        test: settled,
        throughMessageId: 'missing',
        note: '',
        includeTranscript: true,
        includePrompt: false,
        includeDiagnostics: false,
      }),
    ).toThrow();
  });
});

describe('proposed tests', () => {
  test('status changes touch only the matching proposal', () => {
    const proposals = [
      {
        id: 'a',
        message: 'one',
        restart: false,
        rationale: '',
        created: 1,
        status: 'pending' as const,
      },
      {
        id: 'b',
        message: 'two',
        restart: true,
        rationale: '',
        created: 2,
        status: 'pending' as const,
      },
    ];

    const updated = updateProposedTest(proposals, 'a', 'run');
    expect(updated[0]!.status).toBe('run');
    expect(updated[1]!.status).toBe('pending');
  });
});
