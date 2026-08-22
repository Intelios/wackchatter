import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '../types/card.ts';
import type { ApiMessage, ChatMessage, PersistentGuide } from '../types/chat.ts';
import { CHARACTER_NAMES_BEHAVIOR, INJECTION_POSITION } from '../types/preset.ts';
import type { RegexScript } from '../types/regex.ts';
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from '../types/regex.ts';
import { assemblePrompt, DEFAULT_USER_NAME, parseExampleDialogue } from './assemble.ts';
import { createDefaultPreset } from './defaults.ts';
import { setPromptOrder, updatePrompt } from './preset-io.ts';
import type { TokenCounter } from './token-cache.ts';

/** Deterministic and cheap: one token per whitespace-separated word. */
const countText = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const countTokens: TokenCounter = {
  countText,
  // Keep the existing tests focused on prompt shape; dedicated cases below cover wire
  // overhead with a counter that models it.
  countChat: (messages: readonly ApiMessage[]) =>
    messages.reduce((total, message) => total + countText(message.content), 0),
};

function makeCharacter(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: 'A forest guardian.',
    personality: 'Kind and watchful.',
    scenario: 'A glade in Eldoria.',
    first_mes: 'Welcome, traveller.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    name: i % 2 === 0 ? 'User' : 'Seraphina',
    is_user: i % 2 === 0,
    is_system: false,
    mes: `message number ${i}`,
    send_date: new Date().toISOString(),
  }));
}

function assemble(overrides: Partial<Parameters<typeof assemblePrompt>[0]> = {}) {
  return assemblePrompt({
    preset: createDefaultPreset(),
    character: makeCharacter(),
    messages: [],
    countTokens,
    ...overrides,
  });
}

describe('prompt order', () => {
  test('follows prompt_order, not the prompts array order', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'scenario', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'main', enabled: true },
    ]);

    const { messages } = assemble({ preset });

    expect(messages[0]!.content).toContain('Eldoria');
    expect(messages[1]!.content).toContain('forest guardian');
    expect(messages[2]!.content).toContain('next reply');
  });

  test('disabled entries are omitted', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'main', enabled: false },
      { identifier: 'charDescription', enabled: true },
    ]);

    const { messages } = assemble({ preset });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('forest guardian');
  });

  test('the order entry governs enablement, not the prompt object', () => {
    // A prompt object flagged enabled:false must still be sent when its order entry is on.
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'main', { enabled: false });
    preset = setPromptOrder(preset, [{ identifier: 'main', enabled: true }]);

    expect(assemble({ preset }).messages).toHaveLength(1);
  });

  test('empty prompts are skipped', () => {
    // nsfw ships with empty content and must not produce a blank message.
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'nsfw', enabled: true },
      { identifier: 'main', enabled: true },
    ]);

    expect(assemble({ preset }).messages).toHaveLength(1);
  });

  test('injection_trigger limits a prompt to matching generation types', () => {
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'main', { injection_trigger: ['continue'] });
    preset = setPromptOrder(preset, [{ identifier: 'main', enabled: true }]);

    expect(assemble({ preset, generationType: 'normal' }).messages).toHaveLength(0);
    expect(assemble({ preset, generationType: 'continue' }).messages).toHaveLength(1);
  });
});

describe('rolling summary injection', () => {
  const summary = { text: 'The gate is open.', checkpointMessageId: 'm0' };
  const history = makeMessages(1);

  test('places the summary immediately before or after the effective main prompt', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ]),
      new_chat_prompt: '',
    };

    const before = assemble({
      preset,
      messages: history,
      summary,
      summarySettings: { position: 'beforeMain', template: 'MEMORY {{summary}}' },
    });
    const after = assemble({
      preset,
      messages: history,
      summary,
      summarySettings: { position: 'afterMain', template: 'MEMORY {{summary}}' },
    });

    expect(before.messages.map((message) => message.content)).toEqual([
      'MEMORY The gate is open.',
      expect.stringContaining('next reply'),
      'message number 0',
    ]);
    expect(after.messages.map((message) => message.content)).toEqual([
      expect.stringContaining('next reply'),
      'MEMORY The gate is open.',
      'message number 0',
    ]);
    expect(after.tokenCounts.summary).toBe(5);
  });

  test('falls back immediately before history when no main prompt is enabled', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };
    expect(
      assemble({ preset, messages: history, summary }).messages.map((message) => message.content),
    ).toEqual(['[Summary: The gate is open.]', 'message number 0']);
  });

  test('falls back immediately before history when the main prompt is blank', () => {
    let preset = updatePrompt(createDefaultPreset(), 'main', { content: '' });
    preset = {
      ...setPromptOrder(preset, [
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'main', enabled: true },
      ]),
      new_chat_prompt: '',
    };

    expect(
      assemble({
        preset,
        messages: history,
        summary,
        summarySettings: { position: 'beforeMain' },
      }).messages.map((message) => message.content),
    ).toEqual(['[Summary: The gate is open.]', 'message number 0']);
  });

  test('tracks an absolute main prompt with adjacent injection order', () => {
    let preset = updatePrompt(createDefaultPreset(), 'main', {
      content: 'ABS MAIN',
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 0,
      injection_order: 10,
    });
    preset = {
      ...setPromptOrder(preset, [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ]),
      new_chat_prompt: '',
    };

    const result = assemble({
      preset,
      messages: history,
      summary,
      summarySettings: { position: 'beforeMain' },
    });
    expect(result.messages.map((message) => message.content)).toEqual([
      'message number 0',
      '[Summary: The gate is open.]',
      'ABS MAIN',
    ]);
  });

  test('at-depth summary follows lore and precedes standing guides at a collision', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };
    const result = assemble({
      preset,
      messages: history,
      summary,
      summarySettings: { position: 'atDepth', depth: 0, role: 'system' },
      worldInfoDepth: [{ depth: 0, order: 100, role: 'system', content: 'LORE' }],
      guides: [{ id: 'g', name: 'Guide', text: 'GUIDE', enabled: true }],
      guidanceSettings: { guideDepth: 0, guideRole: 'system' },
    });
    const injection = result.messages.at(-1)!.content;

    expect(injection.indexOf('LORE')).toBeLessThan(injection.indexOf('[Summary:'));
    expect(injection.indexOf('[Summary:')).toBeLessThan(injection.indexOf('GUIDE'));
    expect(result.tokenCounts.summary).toBeDefined();
    expect(result.tokenCounts.worldInfoDepth).toBeGreaterThan(result.tokenCounts.summary!);
  });

  test('none preserves the stored value but injects and charges nothing', () => {
    const preset = setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]);
    const result = assemble({ preset, summary, summarySettings: { position: 'none' } });
    expect(result.messages).toHaveLength(1);
    expect(result.tokenCounts.summary).toBeUndefined();
  });

  test('fills the template once so macros inside edited summary text stay literal', () => {
    const preset = setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]);
    const result = assemble({
      preset,
      summary: { text: '{{setvar::danger::yes}} {{char}}' },
      summarySettings: { position: 'beforeMain', template: '{{summary}} / {{char}}' },
    });

    expect(result.messages[0]!.content).toBe('{{setvar::danger::yes}} {{char}} / Seraphina');
    expect(result.variableUpdates.local).toEqual({});
  });
});

describe('Classic quiet controls', () => {
  test('preserves native turns and places literal controls after every preset prompt', () => {
    let preset = updatePrompt(createDefaultPreset(), 'jailbreak', { content: 'POST HISTORY' });
    preset = {
      ...setPromptOrder(preset, [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ]),
      new_chat_prompt: '',
    };
    const result = assemble({
      preset,
      messages: [
        { ...makeMessages(1)[0]!, id: 'u1', name: 'User', is_user: true, mes: 'Question' },
        { ...makeMessages(1)[0]!, id: 'a1', name: 'Sera', is_user: false, mes: 'Answer' },
      ],
      finalControls: [
        {
          identifier: 'summaryBase',
          role: 'system',
          content: 'Existing {{setvar::danger::yes}}',
        },
        { identifier: 'summaryRequest', role: 'system', content: 'SUMMARIZE NOW' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.messages.slice(-5)).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'system', content: 'POST HISTORY' },
      { role: 'system', content: 'Existing {{setvar::danger::yes}}' },
      { role: 'system', content: 'SUMMARIZE NOW' },
    ]);
    expect(result.tokenCounts.summaryBase).toBeDefined();
    expect(result.tokenCounts.summaryRequest).toBeDefined();
    expect(result.variableUpdates.local.danger).toBeUndefined();
  });

  test('forces native history into a quiet prompt even when its marker is disabled', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: false },
      ]),
      new_chat_prompt: '',
    };
    const result = assemble({
      preset,
      messages: [
        { ...makeMessages(1)[0]!, id: 'u1', name: 'User', is_user: true, mes: 'Keep my role' },
      ],
      requireChatHistory: true,
      finalControls: [{ identifier: 'quiet', role: 'system', content: 'CONTROL' }],
    });

    expect(result.messages.slice(-2)).toEqual([
      { role: 'user', content: 'Keep my role' },
      { role: 'system', content: 'CONTROL' },
    ]);
  });

  test('composes full Classic context before the final summary request', () => {
    let preset = updatePrompt(createDefaultPreset(), 'jailbreak', { content: 'POST' });
    preset = {
      ...setPromptOrder(preset, [
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'main', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ]),
      new_chat_prompt: '',
    };
    const messages = [
      { ...makeMessages(1)[0]!, id: 'u1', name: 'Ari', is_user: true, mes: 'Open the gate' },
      { ...makeMessages(1)[0]!, id: 'a1', name: 'Sera', is_user: false, mes: 'It opens' },
    ];
    const result = assemble({
      preset,
      persona: { id: 'p1', name: 'Ari', description: 'A scholar.', avatar: null },
      messages,
      worldInfoBefore: 'LORE BEFORE',
      worldInfoDepth: [{ depth: 0, order: 0, role: 'system', content: 'LORE DEPTH' }],
      authorNote: { text: 'AUTHOR NOTE', interval: 1, position: 'atDepth', depth: 0 },
      guides: [{ id: 'g1', name: 'Guide', text: 'STANDING GUIDE', enabled: true }],
      finalControls: [{ identifier: 'summaryRequest', role: 'system', content: 'SUMMARIZE' }],
    });
    const content = result.messages.map((message) => message.content).join('\n');

    for (const expected of [
      'LORE BEFORE',
      'forest guardian',
      'Kind and watchful',
      'Eldoria',
      'A scholar.',
      'Open the gate',
      'It opens',
      'LORE DEPTH',
      'AUTHOR NOTE',
      'STANDING GUIDE',
      'POST',
    ]) {
      expect(content).toContain(expected);
    }
    expect(result.messages.at(-1)).toEqual({ role: 'system', content: 'SUMMARIZE' });
  });

  test('uses the response override for both macros and overflow accounting', () => {
    let preset = updatePrompt(createDefaultPreset(), 'main', {
      content: 'reserve={{maxResponse}}',
    });
    preset = {
      ...setPromptOrder(preset, [{ identifier: 'main', enabled: true }]),
      openai_max_context: 19,
      openai_max_tokens: 2,
    };
    const result = assemble({ preset, reservedCompletionTokens: 19 });

    expect(result.messages[0]?.content).toBe('reserve=19');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reservedCompletionTokens).toBe(19);
  });
});

describe('macros', () => {
  test('substitutes {{char}} and {{user}} in prompt content', () => {
    const preset = setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]);
    const { messages } = assemble({ preset, userName: 'Jack' });

    expect(messages[0]!.content).toBe(
      "Write Seraphina's next reply in a fictional chat between Seraphina and Jack.",
    );
  });

  test('substitutes macros inside chat messages', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'chatHistory', enabled: true },
    ]);
    const messages: ChatMessage[] = [
      {
        id: 'a',
        name: 'User',
        is_user: true,
        is_system: false,
        mes: 'Hello {{char}}, I am {{user}}.',
        send_date: '',
      },
    ];

    const result = assemble({ preset, messages, userName: 'Jack' });
    expect(result.messages.at(-1)!.content).toBe('Hello Seraphina, I am Jack.');
  });

  test('personality and scenario go through their format strings', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'charPersonality', enabled: true },
        { identifier: 'scenario', enabled: true },
      ]),
      personality_format: "{{char}}'s personality: {{personality}}",
      scenario_format: 'Scene: {{scenario}}',
    };

    const { messages } = assemble({ preset });
    expect(messages[0]!.content).toBe("Seraphina's personality: Kind and watchful.");
    expect(messages[1]!.content).toBe('Scene: A glade in Eldoria.');
  });
});

describe('character card overrides', () => {
  test("a card's system_prompt replaces the main prompt", () => {
    const preset = setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]);
    const character = makeCharacter({ system_prompt: 'Roleplay as {{char}}. Be terse.' });

    expect(assemble({ preset, character }).messages[0]!.content).toBe(
      'Roleplay as Seraphina. Be terse.',
    );
  });

  test('forbid_overrides blocks the card override', () => {
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'main', { forbid_overrides: true });
    preset = setPromptOrder(preset, [{ identifier: 'main', enabled: true }]);

    const character = makeCharacter({ system_prompt: 'Should be ignored.' });
    expect(assemble({ preset, character }).messages[0]!.content).toContain('next reply');
  });

  test('post_history_instructions replaces the jailbreak prompt', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'jailbreak', enabled: true },
    ]);
    const character = makeCharacter({ post_history_instructions: 'Stay in character.' });

    expect(assemble({ preset, character }).messages[0]!.content).toBe('Stay in character.');
  });

  test('{{original}} exposes the resolved preset prompt once inside a card override', () => {
    let preset = updatePrompt(createDefaultPreset(), 'main', {
      content: '{{setvar::phase::original}}Preset {{char}}',
    });
    preset = setPromptOrder(preset, [{ identifier: 'main', enabled: true }]);
    const character = makeCharacter({
      system_prompt: '{{getvar::phase}} / {{original}} / {{original}}',
    });

    const result = assemble({ preset, character });
    expect(result.messages[0]!.content).toBe('original / Preset Seraphina / ');
    expect(result.variableUpdates.local).toEqual({ phase: 'original' });
  });
});

describe('scenario overrides', () => {
  const scenarioPreset = () =>
    updatePrompt(
      setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'scenario', enabled: true },
      ]),
      'main',
      { content: 'Macro: {{scenario}}' },
    );

  test('missing inherits the character scenario', () => {
    expect(
      assemble({ preset: scenarioPreset() }).messages.map((message) => message.content),
    ).toEqual(['Macro: A glade in Eldoria.', 'A glade in Eldoria.']);
  });

  test('a value overrides both the marker and every macro occurrence', () => {
    expect(
      assemble({ preset: scenarioPreset(), scenarioOverride: 'A moonlit harbour.' }).messages.map(
        (message) => message.content,
      ),
    ).toEqual(['Macro: A moonlit harbour.', 'A moonlit harbour.']);
  });

  test('an explicit empty override deliberately clears both paths', () => {
    expect(
      assemble({ preset: scenarioPreset(), scenarioOverride: '' }).messages.map(
        (message) => message.content,
      ),
    ).toEqual(['Macro: ']);
  });
});

describe('macro state and diagnostics during assembly', () => {
  test('mutations sequence across prompts without changing the input maps', () => {
    let preset = updatePrompt(createDefaultPreset(), 'main', {
      content: '{{setvar::step::1}}first',
    });
    preset = updatePrompt(preset, 'jailbreak', {
      content: '{{incvar::step}}/{{setglobalvar::seen::yes}}{{getglobalvar::seen}}',
    });
    preset = setPromptOrder(preset, [
      { identifier: 'main', enabled: true },
      { identifier: 'jailbreak', enabled: true },
    ]);
    const local = { untouched: 'yes' };
    const global = { old: 2 };

    const result = assemble({ preset, localVariables: local, globalVariables: global });

    expect(result.messages.map((message) => message.content)).toEqual(['first', '2/yes']);
    expect(result.variableUpdates).toMatchObject({
      local: { untouched: 'yes', step: 2 },
      global: { old: 2, seen: 'yes' },
      localChanged: true,
      globalChanged: true,
    });
    expect(local).toEqual({ untouched: 'yes' });
    expect(global).toEqual({ old: 2 });
  });

  test('unresolved warnings carry their source and deduplicate repeats', () => {
    const preset = updatePrompt(
      setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]),
      'main',
      // `<SECTION>` is here to prove it is NOT reported: pseudo-XML markers are ordinary
      // prompt text, and treating them as macros made the warning count meaningless.
      { content: '{{missing}} {{MISSING}} <SECTION>' },
    );

    expect(assemble({ preset }).macroWarnings).toEqual([
      { macro: '{{missing}}', source: 'prompt:main' },
    ]);
  });
});

describe('token budget', () => {
  test('history packs newest-first and drops the oldest when the budget runs out', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      // Each message is 3 tokens; the new-chat marker costs 4.
      openai_max_context: 20,
      openai_max_tokens: 0,
      new_chat_prompt: '',
    };

    const result = assemble({ preset, messages: makeMessages(20) });
    const history = result.messages;

    // Only what fits survives, and it is the most recent slice, in order.
    expect(history.length).toBeLessThan(20);
    expect(history.at(-1)!.content).toBe('message number 19');
    expect(result.droppedMessages).toBeGreaterThan(0);

    const contents = history.map((m) => m.content);
    expect(contents).toEqual(
      [...contents].sort((a, b) => {
        const na = Number(a.split(' ').pop());
        const nb = Number(b.split(' ').pop());
        return na - nb;
      }),
    );
  });

  test('budget is max_context minus max_tokens', () => {
    const base = { ...createDefaultPreset(), new_chat_prompt: '' };

    const roomy = assemble({
      preset: {
        ...setPromptOrder(base, [{ identifier: 'chatHistory', enabled: true }]),
        openai_max_context: 100,
        openai_max_tokens: 0,
      },
      messages: makeMessages(20),
    });
    const tight = assemble({
      preset: {
        ...setPromptOrder(base, [{ identifier: 'chatHistory', enabled: true }]),
        openai_max_context: 100,
        openai_max_tokens: 80,
      },
      messages: makeMessages(20),
    });

    expect(tight.messages.length).toBeLessThan(roomy.messages.length);
  });

  test('reports per-prompt token counts', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
    ]);

    const { tokenCounts } = assemble({ preset });
    // "Write Seraphina's next reply in a fictional chat between Seraphina and User."
    expect(tokenCounts.main).toBe(12);
    // "A forest guardian."
    expect(tokenCounts.charDescription).toBe(3);
  });
});

describe('hidden messages', () => {
  test('is_system messages are excluded from the prompt', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'chatHistory', enabled: true },
    ]);
    const messages: ChatMessage[] = [
      { id: 'a', name: 'User', is_user: true, is_system: false, mes: 'visible one', send_date: '' },
      { id: 'b', name: 'Sera', is_user: false, is_system: true, mes: 'hidden one', send_date: '' },
      { id: 'c', name: 'User', is_user: true, is_system: false, mes: 'visible two', send_date: '' },
    ];

    const contents = assemble({ preset, messages }).messages.map((m) => m.content);
    expect(contents).toContain('visible one');
    expect(contents).toContain('visible two');
    expect(contents).not.toContain('hidden one');
  });
});

describe('depth injection', () => {
  test('an absolute prompt splices into the history at its depth', () => {
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'nsfw', {
      content: 'INJECTED',
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 1,
    });
    preset = setPromptOrder(preset, [
      { identifier: 'nsfw', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ]);
    preset = { ...preset, new_chat_prompt: '' };

    const { messages } = assemble({ preset, messages: makeMessages(4) });
    const contents = messages.map((m) => m.content);
    const injected = contents.indexOf('INJECTED');

    // depth 1 = immediately before the last message.
    expect(injected).toBe(contents.length - 2);
  });

  test('depth 0 places content after the final message', () => {
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'nsfw', {
      content: 'LAST',
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 0,
    });
    preset = setPromptOrder(preset, [
      { identifier: 'nsfw', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ]);
    preset = { ...preset, new_chat_prompt: '' };

    const { messages } = assemble({ preset, messages: makeMessages(3) });
    expect(messages.at(-1)!.content).toBe('LAST');
  });

  test('higher injection_order sits closer to the end at the same depth', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };

    const { messages } = assemble({
      preset,
      messages: makeMessages(2),
      worldInfoDepth: [
        { depth: 0, order: 10, role: 'system', content: 'LOW' },
        { depth: 0, order: 90, role: 'system', content: 'HIGH' },
      ],
    });

    const contents = messages.map((m) => m.content);
    expect(contents.indexOf('LOW')).toBeLessThan(contents.indexOf('HIGH'));
  });

  test('at one order, roles read assistant, user, system toward the end', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };

    const { messages } = assemble({
      preset,
      messages: makeMessages(1),
      worldInfoDepth: [
        { depth: 0, order: 100, role: 'system', content: 'SYSTEM' },
        { depth: 0, order: 100, role: 'assistant', content: 'ASSISTANT' },
        { depth: 0, order: 100, role: 'user', content: 'USER' },
      ],
    });

    const contents = messages.map((m) => m.content);
    expect(contents.indexOf('ASSISTANT')).toBeLessThan(contents.indexOf('USER'));
    expect(contents.indexOf('USER')).toBeLessThan(contents.indexOf('SYSTEM'));
  });

  test('mixed depths are measured against the original history, not prior insertions', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };

    const { messages } = assemble({
      preset,
      messages: makeMessages(3),
      worldInfoDepth: [
        { depth: 1, order: 0, role: 'system', content: 'D1' },
        { depth: 0, order: 0, role: 'system', content: 'D0' },
      ],
    });

    expect(messages.map((message) => message.content)).toEqual([
      'message number 0',
      'message number 1',
      'D1',
      'message number 2',
      'D0',
    ]);
  });

  test('same depth, order, and role injections share one wire message in source order', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };
    const { messages } = assemble({
      preset,
      worldInfoDepth: [
        { depth: 0, order: 10, role: 'system', content: 'first' },
        { depth: 0, order: 10, role: 'system', content: 'second' },
      ],
    });

    expect(messages).toEqual([{ role: 'system', content: 'first\nsecond' }]);
  });
});

describe('guided generations', () => {
  const historyOnly = () => ({
    ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
    new_chat_prompt: '',
  });

  const guide = (overrides: Partial<PersistentGuide> = {}): PersistentGuide => ({
    id: 'g1',
    name: 'Tone',
    text: 'Be rude.',
    enabled: true,
    ...overrides,
  });

  test('guidance is the last thing the model reads', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(3),
      guidance: 'have her change the subject',
    });

    expect(messages.at(-1)).toEqual({
      role: 'system',
      content:
        '[Take the following into special consideration for your next message: have her change the subject]',
    });
  });

  test('the role and depth come from settings', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(3),
      guidance: 'louder',
      guidanceSettings: { template: '{{input}}', depth: 1, role: 'user' },
    });

    expect(messages.at(-2)).toEqual({ role: 'user', content: 'louder' });
  });

  test('macros in the template expand, macros the user typed do not', () => {
    // One pass is the engine's contract, and {{input}} rides the same `extra` hook
    // {{original}} does — so a {{setvar}} typed into a steering box cannot mutate state.
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(1),
      guidance: 'annoy {{char}}',
      guidanceSettings: { template: '[{{char}} note: {{input}}]' },
    });

    expect(messages.at(-1)!.content).toBe('[Seraphina note: annoy {{char}}]');
  });

  test('blank guidance injects nothing at all', () => {
    const plain = assemble({ preset: historyOnly(), messages: makeMessages(2) });
    const blank = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guidance: '   \n ',
    });

    expect(blank.messages).toEqual(plain.messages);
    expect(blank.tokenCounts.guidance).toBeUndefined();
  });

  test('a template that resolves to nothing injects nothing', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guidance: 'ignored',
      guidanceSettings: { template: '   ' },
    });

    expect(messages).toHaveLength(2);
  });

  test('guides sit just before the last message, guidance after it', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guides: [guide({ text: 'STANDING' })],
      guidance: 'ONESHOT',
      guidanceSettings: { template: '{{input}}' },
    });

    expect(messages.map((m) => m.content)).toEqual([
      'message number 0',
      'STANDING',
      'message number 1',
      'ONESHOT',
    ]);
  });

  test('guides reach an ordinary generation, with no guidance in sight', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guides: [guide({ text: 'STANDING' })],
    });

    expect(messages.map((m) => m.content)).toContain('STANDING');
  });

  test('a disabled guide contributes nothing', () => {
    const { messages, tokenCounts } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guides: [guide({ enabled: false, text: 'SILENT' })],
    });

    expect(messages.map((m) => m.content)).not.toContain('SILENT');
    expect(tokenCounts.guides).toBeUndefined();
  });

  test('an empty guide contributes nothing, so a half-written one is not a blank line', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      guides: [guide({ id: 'a', text: '  ' }), guide({ id: 'b', text: 'REAL' })],
    });

    expect(messages.map((m) => m.content)).toEqual([
      'message number 0',
      'REAL',
      'message number 1',
    ]);
  });

  test('several guides share one wire message, in list order', () => {
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(1),
      guides: [
        guide({ id: 'a', text: 'FIRST' }),
        guide({ id: 'b', text: 'SECOND' }),
        guide({ id: 'c', text: 'THIRD' }),
      ],
      guidanceSettings: { guideDepth: 0 },
    });

    expect(messages.at(-1)).toEqual({ role: 'system', content: 'FIRST\nSECOND\nTHIRD' });
  });

  test('sharing a depth with guidance, guides come first', () => {
    // They collide in one wire message, so this pins the order inside it: the standing
    // instructions set the frame, the one-shot steer lands last.
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(1),
      guides: [guide({ text: 'STANDING' })],
      guidance: 'ONESHOT',
      guidanceSettings: { template: '{{input}}', depth: 0, guideDepth: 0 },
    });

    expect(messages.at(-1)!.content).toBe('STANDING\nONESHOT');
  });

  test('both are charged their own tokens and named when the context overflows', () => {
    const result = assemble({
      preset: { ...historyOnly(), openai_max_context: 4, openai_max_tokens: 1 },
      messages: makeMessages(1),
      guides: [guide({ text: 'one two three' })],
      guidance: 'four five six',
      guidanceSettings: { template: '{{input}}' },
    });

    expect(result.tokenCounts.guides).toBe(3);
    expect(result.tokenCounts.guidance).toBe(3);
    // Not folded into worldInfoDepth: that key is already the sum over every grouped
    // injection, and doubling down on the over-count would make both numbers meaningless.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an overflow.');
    expect(result.error.identifiers).toContain('guides');
    expect(result.error.identifiers).toContain('guidance');
  });

  test('a broken macro is attributed to the guide that contains it', () => {
    const { macroWarnings } = assemble({
      preset: historyOnly(),
      messages: makeMessages(1),
      guides: [guide({ id: 'tone', text: 'Be {{nonsense}}.' })],
    });

    expect(macroWarnings).toContainEqual({ macro: '{{nonsense}}', source: 'guide:tone' });
  });
});

describe('complete-message token accounting', () => {
  const wireCounter: TokenCounter = {
    countText,
    countChat: (messages) =>
      3 +
      messages.reduce(
        (total, message) =>
          total +
          3 +
          countText(message.role) +
          countText(message.content) +
          (message.name ? countText(message.name) + 1 : 0),
        0,
      ),
  };

  test('counts role, name, framing, and reply priming instead of content alone', () => {
    const preset = updatePrompt(
      setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]),
      'main',
      { content: 'hello' },
    );
    const result = assemble({ preset, countTokens: wireCounter });

    expect(result.ok).toBe(true);
    expect(result.totalTokens).toBe(8); // role + content + 3 framing + 3 reply priming
    expect(result.tokenCounts.main).toBe(5);
    expect(result.tokenCounts.replyPriming).toBe(3);
  });

  test('returns structured overflow when mandatory prompts cannot fit', () => {
    const preset = {
      ...updatePrompt(
        setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]),
        'main',
        { content: 'one two three four five' },
      ),
      openai_max_context: 10,
      openai_max_tokens: 3,
    };
    const result = assemble({ preset, countTokens: wireCounter });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an overflow.');
    expect(result.error).toMatchObject({
      code: 'context_overflow',
      maxContext: 10,
      reservedCompletionTokens: 3,
      identifiers: ['main'],
    });
  });
});

describe('names_behavior', () => {
  const preset = setPromptOrder(createDefaultPreset(), [
    { identifier: 'chatHistory', enabled: true },
  ]);
  const messages: ChatMessage[] = [
    { id: 'a', name: 'Jack', is_user: true, is_system: false, mes: 'hello there', send_date: '' },
  ];

  test('DEFAULT sends bare content', () => {
    const result = assemble({
      preset: { ...preset, names_behavior: CHARACTER_NAMES_BEHAVIOR.DEFAULT, new_chat_prompt: '' },
      messages,
    });
    expect(result.messages[0]!.content).toBe('hello there');
    expect(result.messages[0]!.name).toBeUndefined();
  });

  test('CONTENT prefixes the name into the text', () => {
    const result = assemble({
      preset: { ...preset, names_behavior: CHARACTER_NAMES_BEHAVIOR.CONTENT, new_chat_prompt: '' },
      messages,
    });
    expect(result.messages[0]!.content).toBe('Jack: hello there');
  });

  test('COMPLETION sets the native name field, sanitised', () => {
    const result = assemble({
      preset: {
        ...preset,
        names_behavior: CHARACTER_NAMES_BEHAVIOR.COMPLETION,
        new_chat_prompt: '',
      },
      messages: [{ ...messages[0]!, name: 'Jack Smith-Jones!' }],
    });
    expect(result.messages[0]!.content).toBe('hello there');
    expect(result.messages[0]!.name).toBe('Jack_Smith_Jones_');
  });
});

describe('continue', () => {
  /** A short exchange ending on a partial assistant reply. */
  const partial: ChatMessage[] = [
    {
      id: 'u1',
      name: 'User',
      is_user: true,
      is_system: false,
      mes: 'Describe the glade.',
      send_date: 'a',
    },
    {
      id: 'a1',
      name: 'Seraphina',
      is_user: false,
      is_system: false,
      mes: 'The lantern guttered',
      send_date: 'b',
    },
  ];

  test('a normal generation is unaffected', () => {
    const result = assemble({ messages: partial, generationType: 'normal' });
    const last = result.messages[result.messages.length - 1]!;
    expect(last.content).not.toContain('Continue your last message');
  });

  test('by default the nudge is appended as the final instruction', () => {
    const result = assemble({ messages: partial, generationType: 'continue' });
    const last = result.messages[result.messages.length - 1]!;

    expect(last.role).toBe('system');
    expect(last.content).toBe(
      '[Continue your last message without repeating its original content.]',
    );
  });

  test('the nudge honours a preset override and its macros', () => {
    const preset = createDefaultPreset();
    preset.continue_nudge_prompt = 'Keep writing as {{char}}.';

    const result = assemble({ preset, messages: partial, generationType: 'continue' });
    expect(result.messages[result.messages.length - 1]!.content).toBe('Keep writing as Seraphina.');
  });

  test('prefill puts the partial reply last so the model carries straight on', () => {
    const preset = createDefaultPreset();
    preset.continue_prefill = true;

    const result = assemble({ preset, messages: partial, generationType: 'continue' });
    const last = result.messages[result.messages.length - 1]!;

    expect(last.role).toBe('assistant');
    // The default postfix is a single space — the join between old text and new.
    expect(last.content).toBe('The lantern guttered ');
    // And it is no longer sitting in the middle of the array.
    expect(result.messages.filter((m) => m.content.startsWith('The lantern guttered')).length).toBe(
      1,
    );
  });

  test('prefill moves the partial past prompts that were ordered after the history', () => {
    // jailbreak sits after chatHistory in the default order, so without the move the
    // prefill would not be the final message and the model would answer it instead.
    const preset = updatePrompt(createDefaultPreset(), 'jailbreak', {
      content: 'Stay in character.',
    });
    preset.continue_prefill = true;

    const result = assemble({ preset, messages: partial, generationType: 'continue' });
    const roles = result.messages.map((m) => m.role);

    expect(roles[roles.length - 1]).toBe('assistant');
    expect(result.messages[result.messages.length - 2]!.content).toBe('Stay in character.');
  });

  test('a custom postfix is used instead of the space', () => {
    const preset = createDefaultPreset();
    preset.continue_prefill = true;
    preset.continue_postfix = '\n\n';

    const result = assemble({ preset, messages: partial, generationType: 'continue' });
    expect(result.messages[result.messages.length - 1]!.content).toBe('The lantern guttered\n\n');
  });

  test('continuing with no assistant reply yet leaves the prompt alone', () => {
    const onlyUser = [partial[0]!];
    const nudged = assemble({ messages: onlyUser, generationType: 'continue' });
    const plain = assemble({ messages: onlyUser, generationType: 'normal' });
    expect(nudged.messages.length).toBe(plain.messages.length);
  });

  test('a continuation nudge remains mandatory when its transcript turn is pruned', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      openai_max_context: 4,
      openai_max_tokens: 0,
      new_chat_prompt: '',
    };

    const result = assemble({ preset, messages: partial, generationType: 'continue' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('context_overflow');
  });
});

describe('send_if_empty', () => {
  const historyPreset = () => ({
    ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
    new_chat_prompt: '',
    send_if_empty: 'Please continue as {{char}}.',
  });
  const assistant: ChatMessage = {
    id: 'a',
    name: 'Seraphina',
    is_user: false,
    is_system: false,
    mes: 'Waiting.',
    send_date: '',
  };
  const user: ChatMessage = {
    ...assistant,
    id: 'u',
    name: 'User',
    is_user: true,
    mes: 'Hello.',
  };

  test('adds a substituted user message after an assistant ending', () => {
    const result = assemble({ preset: historyPreset(), messages: [assistant] });
    expect(result.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Please continue as Seraphina.',
    });
    expect(result.tokenCounts.emptyUserMessageReplacement).toBeDefined();
  });

  test('does nothing after a user ending or for a blank setting', () => {
    expect(assemble({ preset: historyPreset(), messages: [user] }).messages.at(-1)?.role).toBe(
      'user',
    );
    expect(
      assemble({ preset: { ...historyPreset(), send_if_empty: '  ' }, messages: [assistant] })
        .messages,
    ).toHaveLength(1);
  });

  test('omits the replacement when the remaining budget cannot afford it', () => {
    const preset = {
      ...historyPreset(),
      send_if_empty: 'two tokens',
      openai_max_context: 1,
      openai_max_tokens: 0,
    };
    const result = assemble({ preset, messages: [{ ...assistant, mes: 'one' }] });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([{ role: 'assistant', content: 'one' }]);
  });

  test('checks the tail after depth injections', () => {
    const result = assemble({
      preset: historyPreset(),
      messages: [assistant],
      worldInfoDepth: [{ depth: 0, order: 1, role: 'system', content: 'tail injection' }],
    });
    expect(result.messages.at(-1)?.content).toBe('tail injection');
    expect(result.tokenCounts.emptyUserMessageReplacement).toBeUndefined();
  });

  test('is inserted before continue reshaping', () => {
    const result = assemble({
      preset: historyPreset(),
      messages: [user, assistant],
      generationType: 'continue',
    });
    const replacement = result.messages.findIndex(
      (message) => message.content === 'Please continue as Seraphina.',
    );
    const nudge = result.messages.findIndex((message) => message.content.includes('Continue your'));
    expect(replacement).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(replacement);
  });
});

describe('example dialogue', () => {
  test('parses <START> blocks into alternating example messages', () => {
    const blocks = parseExampleDialogue(
      '<START>\n{{user}}: Hi there\n{{char}}: Hello back\n<START>\n{{user}}: Again',
      { char: 'Sera', user: 'Jack' },
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveLength(2);
    expect(blocks[0]![0]!.name).toBe('example_user');
    expect(blocks[0]![0]!.content).toBe('Hi there');
    expect(blocks[0]![1]!.name).toBe('example_assistant');
    expect(blocks[0]![1]!.content).toBe('Hello back');
  });

  test('macros are substituted inside examples', () => {
    const blocks = parseExampleDialogue('<START>\n{{user}}: I am {{user}}', {
      char: 'Sera',
      user: 'Jack',
    });
    expect(blocks[0]![0]!.content).toBe('I am Jack');
  });

  test('legacy speaker prefixes are recognised', () => {
    const blocks = parseExampleDialogue('<START>\n<USER>: Hello <BOT>\n<CHAR>: Hello <USER>', {
      char: 'Sera',
      user: 'Jack',
    });
    expect(blocks[0]).toEqual([
      { role: 'system', name: 'example_user', content: 'Hello Sera' },
      { role: 'system', name: 'example_assistant', content: 'Hello Jack' },
    ]);
  });

  test('blocks are admitted whole or not at all', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'dialogueExamples', enabled: true }]),
      openai_max_context: 12,
      openai_max_tokens: 0,
      new_example_chat_prompt: 'EX',
    };

    const character = makeCharacter({
      mes_example:
        '<START>\n{{user}}: aaa bbb ccc\n{{char}}: ddd eee fff\n' +
        '<START>\n{{user}}: ggg hhh iii\n{{char}}: jjj kkk lll',
    });

    const { messages } = assemble({ preset, character });
    const contents = messages.map((m) => m.content);

    // The first block fits (1 + 3 + 3 = 7); the second would exceed 12.
    expect(contents).toContain('aaa bbb ccc');
    expect(contents).not.toContain('ggg hhh iii');
  });
});

describe('squash_system_messages', () => {
  test('merges consecutive unnamed system messages', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'scenario', enabled: true },
      ]),
      squash_system_messages: true,
    };

    const { messages } = assemble({ preset });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('next reply');
    expect(messages[0]!.content).toContain('forest guardian');
    expect(messages[0]!.content).toContain('Eldoria');
  });

  test('leaves them separate when disabled', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
    ]);

    expect(assemble({ preset }).messages).toHaveLength(2);
  });

  test('a named message breaks the squash run', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'charDescription', enabled: true },
      ]),
      squash_system_messages: true,
      new_example_chat_prompt: '',
    };
    const character = makeCharacter({ mes_example: '<START>\n{{user}}: sample text' });

    const { messages } = assemble({ preset, character });
    // The named example message must not be absorbed into its neighbours.
    expect(messages.some((m) => m.name === 'example_user')).toBe(true);
  });
});

describe('world info placement', () => {
  test('before and after land at their marker positions', () => {
    const preset = setPromptOrder(createDefaultPreset(), [
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'worldInfoAfter', enabled: true },
    ]);

    const { messages } = assemble({
      preset,
      worldInfoBefore: 'LORE BEFORE',
      worldInfoAfter: 'LORE AFTER',
    });

    expect(messages[0]!.content).toBe('LORE BEFORE');
    expect(messages[1]!.content).toContain('forest guardian');
    expect(messages[2]!.content).toBe('LORE AFTER');
  });

  test('wi_format wraps the lore text', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'worldInfoBefore', enabled: true }]),
      wi_format: '[Lore]\n{0}\n[/Lore]',
    };

    expect(assemble({ preset, worldInfoBefore: 'ELDORIA' }).messages[0]!.content).toBe(
      '[Lore]\nELDORIA\n[/Lore]',
    );
  });
});

describe('world info at depth', () => {
  const historyOnly = () => ({
    ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
    new_chat_prompt: '',
  });

  test('is charged against the budget and reported in tokenCounts', () => {
    // History used to pack against a budget that had never seen the lore sharing space
    // with it, so the two together could overrun the context.
    const preset = historyOnly();
    const lore = { depth: 0, order: 10, role: 'system' as const, content: 'four words of lore' };

    const without = assemble({ preset, messages: makeMessages(6) });
    const withLore = assemble({ preset, messages: makeMessages(6), worldInfoDepth: [lore] });

    expect(withLore.tokenCounts.worldInfoDepth).toBe(4);
    expect(without.tokenCounts.worldInfoDepth).toBeUndefined();
    expect(withLore.tokenCounts.chatHistory!).toBeLessThanOrEqual(without.tokenCounts.chatHistory!);
  });

  test('the charge actually displaces history when the budget is tight', () => {
    // Five three-token messages need 15; the budget is 18, so they all fit until five
    // tokens of lore are charged against it.
    const preset = { ...historyOnly(), openai_max_context: 18, openai_max_tokens: 0 };
    const messages = makeMessages(5);

    const without = assemble({ preset, messages });
    const withLore = assemble({
      preset,
      messages,
      worldInfoDepth: [{ depth: 0, order: 0, role: 'system', content: 'one two three four five' }],
    });

    expect(withLore.droppedMessages).toBeGreaterThan(without.droppedMessages);
  });

  test('macros in depth content are substituted', () => {
    // The activation engine deliberately leaves content raw, so this is the only place
    // it can happen — and it happens exactly once.
    const { messages } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      worldInfoDepth: [{ depth: 0, order: 0, role: 'system', content: '{{char}} lives here' }],
    });

    expect(messages.at(-1)!.content).toBe('Seraphina lives here');
  });

  test('blank depth content is dropped rather than sent as an empty message', () => {
    const { messages, tokenCounts } = assemble({
      preset: historyOnly(),
      messages: makeMessages(2),
      worldInfoDepth: [{ depth: 0, order: 0, role: 'system', content: '   ' }],
    });

    expect(tokenCounts.worldInfoDepth).toBeUndefined();
    expect(messages.some((m) => !m.content.trim())).toBe(false);
  });

  test('depth injections survive a disabled chatHistory marker', () => {
    // A live bug before this: the budget was charged during the prompt walk but the
    // splice only ran inside the history branch, so a preset with chatHistory off paid
    // for content it never sent.
    let preset = createDefaultPreset();
    preset = updatePrompt(preset, 'nsfw', {
      content: 'ABSOLUTE',
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 0,
    });
    preset = setPromptOrder(preset, [
      { identifier: 'nsfw', enabled: true },
      { identifier: 'chatHistory', enabled: false },
    ]);

    const { messages } = assemble({
      preset,
      messages: makeMessages(4),
      worldInfoDepth: [{ depth: 0, order: 0, role: 'system', content: 'DEPTH LORE' }],
    });

    const contents = messages.map((m) => m.content);
    expect(contents).toContain('ABSOLUTE');
    expect(contents).toContain('DEPTH LORE');
    // And the history really is absent, so this is not just the normal path.
    expect(contents.some((c) => c.startsWith('message number'))).toBe(false);
  });
});

describe('persona position', () => {
  const personaOrder = () =>
    setPromptOrder(createDefaultPreset(), [
      { identifier: 'personaDescription', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ]);

  const persona = { id: 'p1', name: 'Ari', description: 'A wandering scholar.', avatar: null };

  test('inPrompt puts the description at the marker', () => {
    const { messages } = assemble({ preset: personaOrder(), persona });
    expect(messages[0]!.content).toBe('A wandering scholar.');
  });

  test('an absent position defaults to inPrompt', () => {
    const { messages } = assemble({ preset: personaOrder(), persona: { ...persona } });
    expect(messages[0]!.content).toBe('A wandering scholar.');
  });

  test('atDepth suppresses the marker and injects into the history instead', () => {
    const preset = { ...personaOrder(), new_chat_prompt: '' };
    const { messages, tokenCounts } = assemble({
      preset,
      messages: makeMessages(4),
      persona: { ...persona, position: 'atDepth', depth: 0 },
    });

    const contents = messages.map((m) => m.content);
    expect(contents[0]).not.toBe('A wandering scholar.');
    expect(contents.at(-1)).toBe('A wandering scholar.');
    expect(tokenCounts.worldInfoDepth).toBe(3);
  });

  test('atDepth honours the role', () => {
    const preset = { ...personaOrder(), new_chat_prompt: '' };
    const { messages } = assemble({
      preset,
      messages: makeMessages(2),
      persona: { ...persona, position: 'atDepth', depth: 0, role: 'user' },
    });

    expect(messages.at(-1)).toEqual({ role: 'user', content: 'A wandering scholar.' });
  });

  test("'none' sends the description nowhere", () => {
    const preset = { ...personaOrder(), new_chat_prompt: '' };
    const { messages } = assemble({
      preset,
      messages: makeMessages(2),
      persona: { ...persona, position: 'none' },
    });

    expect(messages.map((m) => m.content)).not.toContain('A wandering scholar.');
  });

  test('{{persona}} keeps resolving at every position', () => {
    // Otherwise a preset referencing the macro would break the moment somebody changed
    // a dropdown — which is also ST's behaviour.
    for (const position of [
      'inPrompt',
      'topAuthorNote',
      'bottomAuthorNote',
      'atDepth',
      'none',
    ] as const) {
      const preset = setPromptOrder({ ...createDefaultPreset(), new_chat_prompt: '' }, [
        { identifier: 'main', enabled: true },
      ]);
      const withMacro = updatePrompt(preset, 'main', { content: 'You talk to {{persona}}' });

      const { messages } = assemble({
        preset: withMacro,
        persona: { ...persona, position },
      });
      expect(messages[0]!.content).toBe('You talk to A wandering scholar.');
    }
  });

  test('the persona name is what {{user}} expands to', () => {
    const preset = updatePrompt(
      setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]),
      'main',
      { content: 'Talking to {{user}}' },
    );

    expect(assemble({ preset, persona }).messages[0]!.content).toBe('Talking to Ari');
  });

  test('with no persona, {{user}} matches the default message label', () => {
    // These used to disagree: the transcript said "You" while {{user}} said "User", and
    // with names_behavior CONTENT the label lands in the prompt text.
    const preset = updatePrompt(
      setPromptOrder(createDefaultPreset(), [{ identifier: 'main', enabled: true }]),
      'main',
      { content: '{{user}}' },
    );

    expect(assemble({ preset }).messages[0]!.content).toBe(DEFAULT_USER_NAME);
  });
});

describe('Author’s Note', () => {
  const userTurn = (id: string): ChatMessage => ({
    id,
    name: 'User',
    is_user: true,
    is_system: false,
    mes: `turn ${id}`,
    send_date: '',
  });
  const ordered = () => ({
    ...setPromptOrder(createDefaultPreset(), [
      { identifier: 'main', enabled: true },
      { identifier: 'scenario', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ]),
    new_chat_prompt: '',
  });

  test('interval <= 0 disables and positive intervals follow user-turn count', () => {
    const base = { text: 'NOTE', position: 'beforeScenario' as const };
    expect(
      assemble({
        preset: ordered(),
        messages: [userTurn('1')],
        authorNote: { ...base, interval: 0 },
      }).messages.some((message) => message.content === 'NOTE'),
    ).toBe(false);
    expect(
      assemble({
        preset: ordered(),
        messages: [userTurn('1')],
        authorNote: { ...base, interval: 2 },
      }).messages.some((message) => message.content === 'NOTE'),
    ).toBe(false);
    expect(
      assemble({
        preset: ordered(),
        messages: [userTurn('1'), userTurn('2')],
        authorNote: { ...base, interval: 2 },
      }).messages.some((message) => message.content === 'NOTE'),
    ).toBe(true);
  });

  test('before and after positions anchor around scenario', () => {
    for (const [position, expected] of [
      ['beforeScenario', ['NOTE', 'A glade in Eldoria.']],
      ['afterScenario', ['A glade in Eldoria.', 'NOTE']],
    ] as const) {
      const result = assemble({
        preset: setPromptOrder(ordered(), [
          { identifier: 'scenario', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ]),
        messages: [userTurn('1')],
        authorNote: { text: 'NOTE', position },
      });
      expect(result.messages.slice(0, 2).map((message) => message.content)).toEqual([...expected]);
    }
  });

  test('a missing scenario marker falls back immediately before history', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ]),
      new_chat_prompt: '',
    };
    const result = assemble({
      preset,
      messages: [userTurn('1')],
      authorNote: { text: 'NOTE', position: 'afterScenario' },
    });
    expect(result.messages.map((message) => message.content)).toEqual([
      "Write Seraphina's next reply in a fictional chat between Seraphina and User.",
      'NOTE',
      'turn 1',
    ]);
  });

  test('at-depth honours depth and role', () => {
    const preset = {
      ...setPromptOrder(createDefaultPreset(), [{ identifier: 'chatHistory', enabled: true }]),
      new_chat_prompt: '',
    };
    const result = assemble({
      preset,
      messages: [userTurn('1'), { ...userTurn('2'), is_user: false, name: 'Seraphina' }],
      authorNote: { text: 'NOTE', position: 'atDepth', depth: 1, role: 'assistant' },
    });
    expect(result.messages).toEqual([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'NOTE' },
      { role: 'assistant', content: 'turn 2' },
    ]);
  });

  test('top/bottom persona positions compose around the note with one newline', () => {
    const persona = {
      id: 'p',
      name: 'Ari',
      description: 'PERSONA',
      avatar: null,
    };
    for (const [position, content] of [
      ['topAuthorNote', 'PERSONA\nNOTE'],
      ['bottomAuthorNote', 'NOTE\nPERSONA'],
    ] as const) {
      const result = assemble({
        preset: ordered(),
        messages: [userTurn('1')],
        persona: { ...persona, position },
        authorNote: { text: 'NOTE', position: 'beforeScenario', role: 'user' },
      });
      expect(result.messages.find((message) => message.content === content)).toEqual({
        role: 'user',
        content,
      });
    }
  });

  test('relative note follows an absolute scenario marker at the same depth', () => {
    let preset = updatePrompt(ordered(), 'scenario', {
      injection_position: INJECTION_POSITION.ABSOLUTE,
      injection_depth: 0,
      injection_order: 20,
    });
    preset = setPromptOrder(preset, [
      { identifier: 'scenario', enabled: true },
      { identifier: 'chatHistory', enabled: true },
    ]);
    const result = assemble({
      preset,
      messages: [userTurn('1')],
      authorNote: { text: 'NOTE', position: 'beforeScenario' },
    });
    expect(result.messages.slice(-2).map((message) => message.content)).toEqual([
      'NOTE',
      'A glade in Eldoria.',
    ]);
  });
});

describe('regex scripts', () => {
  function regexScript(overrides: Partial<RegexScript> = {}): RegexScript {
    return {
      id: 'test',
      scriptName: 'test',
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

  const history = (result: ReturnType<typeof assemble>) =>
    result.messages.filter((message) => message.role !== 'system').map((m) => m.content);

  test('a prompt-only script rewrites history on the way to the model', () => {
    const result = assemble({
      messages: makeMessages(2),
      regexScripts: [regexScript({ findRegex: '/message/g', replaceString: 'note' })],
    });
    expect(history(result)).toEqual(['note number 0', 'note number 1']);
  });

  test('a display-only script leaves the prompt untouched', () => {
    const result = assemble({
      messages: makeMessages(2),
      regexScripts: [
        regexScript({
          findRegex: '/message/g',
          replaceString: 'note',
          markdownOnly: true,
          promptOnly: false,
        }),
      ],
    });
    expect(history(result)).toEqual(['message number 0', 'message number 1']);
  });

  test('the token counts move with the text, not just the strings', () => {
    // The three-caller-drift guard: if the preview assembled without scripts, the Prompt
    // Manager's numbers would disagree with what was actually sent.
    const messages = makeMessages(2);
    const plain = assemble({ messages });
    const shortened = assemble({
      messages,
      regexScripts: [regexScript({ findRegex: '/ number \\d+/g', replaceString: '' })],
    });
    expect(shortened.tokenCounts.chatHistory).toBeLessThan(plain.tokenCounts.chatHistory ?? 0);
  });

  test('a script that empties a message drops it from packing', () => {
    const result = assemble({
      messages: makeMessages(3),
      regexScripts: [
        regexScript({
          findRegex: '/^message number 1$/',
          replaceString: '',
          placement: [REGEX_PLACEMENT.AI_OUTPUT],
        }),
      ],
    });
    expect(history(result)).toEqual(['message number 0', 'message number 2']);
  });

  test('placement separates who is being rewritten', () => {
    const result = assemble({
      messages: makeMessages(2),
      regexScripts: [
        regexScript({
          findRegex: '/message/',
          replaceString: 'note',
          placement: [REGEX_PLACEMENT.USER_INPUT],
        }),
      ],
    });
    expect(history(result)).toEqual(['note number 0', 'message number 1']);
  });

  test('depth counts from the end, ignoring the blank generation placeholder', () => {
    const messages = [...makeMessages(3), { ...makeMessages(1)[0]!, id: 'pending', mes: '' }];
    const result = assemble({
      messages,
      regexScripts: [regexScript({ findRegex: '/message/', replaceString: 'newest', maxDepth: 0 })],
    });
    // Depth 0 is `m2`, not the empty placeholder that generation just appended.
    expect(history(result)).toEqual(['message number 0', 'message number 1', 'newest number 2']);
  });

  test('a continue shifts every depth by one, so only minDepth -1 reaches the tail', () => {
    // The message being extended sits past the end at -1. `minDepth: 0` therefore excludes
    // it, and `-1` is the only way to write a script that reaches the text being continued.
    const messages = makeMessages(2);
    const rewrite = { findRegex: '/message/', replaceString: 'hit' };

    const fromZero = [regexScript({ ...rewrite, minDepth: 0 })];
    expect(history(assemble({ messages, regexScripts: fromZero }))).toEqual([
      'hit number 0',
      'hit number 1',
    ]);
    expect(
      history(assemble({ messages, regexScripts: fromZero, generationType: 'continue' })),
    ).toEqual(['hit number 0', 'message number 1']);

    const fromMinusOne = [regexScript({ ...rewrite, minDepth: -1 })];
    expect(
      history(assemble({ messages, regexScripts: fromMinusOne, generationType: 'continue' })),
    ).toEqual(['hit number 0', 'hit number 1']);
  });

  test('regex runs on macro-substituted text, unlike SillyTavern', () => {
    // ST regexes the raw message because ST never expands macros in chat history at all.
    // We do, so a pattern has to match what the model will read — not what was typed.
    const result = assemble({
      messages: [{ ...makeMessages(1)[0]!, mes: 'hello {{char}}' }],
      regexScripts: [regexScript({ findRegex: '/Seraphina/', replaceString: 'friend' })],
    });
    expect(history(result)).toEqual(['hello friend']);
  });

  test('macros in a replacement expand against the assembly environment', () => {
    const result = assemble({
      messages: [{ ...makeMessages(1)[0]!, mes: 'hello' }],
      regexScripts: [regexScript({ findRegex: '/^/', replaceString: '[{{char}}] ' })],
    });
    expect(history(result)).toEqual(['[Seraphina] hello']);
  });

  test('a hidden message is neither sent nor counted for depth', () => {
    const messages = makeMessages(3);
    messages[1]!.is_system = true;
    const result = assemble({
      messages,
      regexScripts: [regexScript({ findRegex: '/message/', replaceString: 'newest', maxDepth: 0 })],
    });
    expect(history(result)).toEqual(['message number 0', 'newest number 2']);
  });

  test('an empty script list is the identity', () => {
    expect(history(assemble({ messages: makeMessages(2), regexScripts: [] }))).toEqual(
      history(assemble({ messages: makeMessages(2) })),
    );
  });
});

describe('the story-memory slot', () => {
  const summary = { text: 'The gate is open.', checkpointMessageId: 'm0' };
  const memoryText = '## The Cellar\nHe found the sealed jars.';

  test('classic mode injects the rolling summary and nothing else', () => {
    const result = assemble({ summary, memoryText, memoryMode: 'classic' });
    const contents = result.messages.map((message) => message.content).join('\n');
    expect(contents).toContain('The gate is open.');
    expect(contents).not.toContain('The Cellar');
    expect(result.tokenCounts.memories).toBeUndefined();
  });

  test('classic is the default, so an assembly that never heard of memories is unchanged', () => {
    expect(assemble({ summary }).messages).toEqual(
      assemble({ summary, memoryMode: 'classic' }).messages,
    );
  });

  test('memories mode injects the memories and suppresses the summary', () => {
    // Both live in metadata at once. Sending both would narrate the same events twice.
    const result = assemble({ summary, memoryText, memoryMode: 'memories' });
    const contents = result.messages.map((message) => message.content).join('\n');
    expect(contents).toContain('The Cellar');
    expect(contents).not.toContain('The gate is open.');
    expect(result.tokenCounts.summary).toBeUndefined();
    expect(result.tokenCounts.memories).toBeGreaterThan(0);
  });

  test('off mode injects neither', () => {
    const result = assemble({ summary, memoryText, memoryMode: 'off' });
    const contents = result.messages.map((message) => message.content).join('\n');
    expect(contents).not.toContain('The gate is open.');
    expect(contents).not.toContain('The Cellar');
  });

  test('the memory template wraps the text through its own macro', () => {
    const result = assemble({
      memoryText,
      memoryMode: 'memories',
      memorySettings: { template: 'RECALL: {{memories}}', position: 'afterMain' },
    });
    expect(result.messages.map((m) => m.content).join('\n')).toContain('RECALL: ## The Cellar');
  });

  test('memories honour their own position, independently of the summary settings', () => {
    const before = assemble({
      memoryText,
      memoryMode: 'memories',
      memorySettings: { position: 'beforeMain' },
      summarySettings: { position: 'atDepth' },
    });
    const indexOf = (result: typeof before, needle: string) =>
      result.messages.findIndex((message) => message.content.includes(needle));
    expect(indexOf(before, 'The Cellar')).toBeLessThan(indexOf(before, 'next reply'));
  });

  test('memories can be injected at depth', () => {
    const result = assemble({
      messages: makeMessages(4),
      memoryText,
      memoryMode: 'memories',
      memorySettings: { position: 'atDepth', depth: 0, role: 'system' },
    });
    expect(result.messages.at(-1)?.content).toContain('The Cellar');
    expect(result.tokenCounts.memories).toBeGreaterThan(0);
    expect(result.tokenCounts.summary).toBeUndefined();
  });

  test('memories mode with nothing recalled injects nothing', () => {
    const result = assemble({ summary, memoryText: '', memoryMode: 'memories' });
    const contents = result.messages.map((message) => message.content).join('\n');
    expect(contents).not.toContain('The gate is open.');
    expect(result.tokenCounts.memories).toBeUndefined();
  });

  test('position none suppresses memories the same way it suppresses the summary', () => {
    const result = assemble({
      memoryText,
      memoryMode: 'memories',
      memorySettings: { position: 'none' },
    });
    expect(result.messages.map((m) => m.content).join('\n')).not.toContain('The Cellar');
  });
});
