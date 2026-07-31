import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage } from '../types/chat.ts';
import { CHARACTER_NAMES_BEHAVIOR, INJECTION_POSITION } from '../types/preset.ts';
import { assemblePrompt, parseExampleDialogue } from './assemble.ts';
import { createDefaultPreset } from './defaults.ts';
import { setPromptOrder, updatePrompt } from './preset-io.ts';

/** Deterministic and cheap: one token per whitespace-separated word. */
const countTokens = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);

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

  test('injection_order breaks ties at the same depth, descending', () => {
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
    expect(contents.indexOf('HIGH')).toBeLessThan(contents.indexOf('LOW'));
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
