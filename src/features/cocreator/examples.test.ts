import { describe, expect, test } from 'bun:test';
import type { TokenCounter } from '@shared/prompt/token-cache.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import { DEFAULT_EXAMPLE_FIELDS, type ExampleFields } from '@shared/types/cocreator.ts';
import { EXAMPLE_PREAMBLE, exampleCardsView, renderExample, renderExamples } from './examples.ts';

/** One token per word, the technique assemble.test.ts uses. */
const words: TokenCounter = {
  countText: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
  countChat: (messages) =>
    messages.reduce((total, message) => total + words.countText(message.content), 0),
};

function card(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: 'A healer of the deep wood.',
    personality: 'Gentle, watchful.',
    scenario: 'The forest at dusk.',
    first_mes: 'You are safe here.',
    mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Rest.',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['The lanterns are lit.', 'You again.'],
    tags: ['fantasy', 'healer'],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

function fields(overrides: Partial<ExampleFields> = {}): ExampleFields {
  return { ...DEFAULT_EXAMPLE_FIELDS, ...overrides };
}

function render(data: CardDataV2, toggles = fields()): string {
  return renderExample(data, 'Seraphina.png', 1, toggles, words).text;
}

describe('example loading readiness', () => {
  const selection = { cards: ['Seraphina.png', 'Elowen.png'], fields: fields() };
  const cards = {
    'Seraphina.png': card(),
    'Elowen.png': card({ name: 'Elowen' }),
  };
  const view = (overrides: Partial<Parameters<typeof exampleCardsView>[0]> = {}) =>
    exampleCardsView({
      selection,
      cards: {},
      countTokens: words,
      loading: false,
      settledKey: '',
      ...overrides,
    });

  test('selected cards are pending before the fetching effect starts', () => {
    expect(view()).toMatchObject({ loading: true, text: '', missing: [] });
  });

  test('cached examples never make a newly attached card ready before its GET settles', () => {
    const partial = view({ cards: { 'Seraphina.png': cards['Seraphina.png'] } });
    expect(partial.loading).toBe(true);
    expect(partial.examples.map((example) => example.name)).toEqual(['Seraphina']);
    expect(partial.missing).toEqual([]);
  });

  test('a pending fetch remains blocked even when other cards have finished loading', () => {
    expect(view({ cards, loading: true }).loading).toBe(true);
  });

  test('completed fetches expose every attached card in selection order', () => {
    const complete = view({ cards, settledKey: selection.cards.join('\0') });
    expect(complete.loading).toBe(false);
    expect(complete.missing).toEqual([]);
    expect(complete.examples.map((example) => example.name)).toEqual(['Seraphina', 'Elowen']);
    expect(complete.text).toBe(
      renderExamples(
        selection.cards.map((avatar) => ({ avatar, card: cards[avatar as keyof typeof cards] })),
        selection.fields,
        words,
      ).text,
    );
  });

  test('an older selection settling cannot unblock a newly attached card', () => {
    expect(
      view({
        cards: { 'Seraphina.png': cards['Seraphina.png'] },
        settledKey: 'Seraphina.png',
      }).loading,
    ).toBe(true);
  });

  test('a settled missing card is reported rather than leaving generation blocked forever', () => {
    expect(view({ settledKey: selection.cards.join('\0') })).toMatchObject({
      loading: false,
      missing: selection.cards,
      text: '',
    });
  });

  test('a session with no selected examples is ready without a fetch', () => {
    expect(view({ selection: { cards: [], fields: fields() } })).toMatchObject({
      loading: false,
      text: '',
      missing: [],
    });
  });
});

describe('rendering one example', () => {
  test('the curated set produces readable labelled text, not JSON', () => {
    const text = render(card());

    expect(text).toContain('### Example card 1 — Seraphina');
    expect(text).toContain('Tags: fantasy, healer');
    expect(text).toContain('Description:\nA healer of the deep wood.');
    expect(text).toContain('First message:\nYou are safe here.');
    expect(text).not.toContain('{');
  });

  test('a blank field is omitted rather than shown as an empty heading', () => {
    const text = render(card({ scenario: '', personality: '   ' }));

    expect(text).not.toContain('Scenario:');
    expect(text).not.toContain('Personality:');
    expect(text).toContain('Description:');
  });

  test('the opt-in extras are off by default', () => {
    const text = render(card());

    expect(text).not.toContain('Alternate greetings:');
    expect(text).not.toContain('Example dialogue:');
  });

  test('each opt-in toggle adds exactly its own block', () => {
    const greetings = render(card(), fields({ alternate_greetings: true }));
    expect(greetings).toContain('Alternate greetings:\n1. The lanterns are lit.');
    expect(greetings).toContain('2. You again.');
    expect(greetings).not.toContain('Example dialogue:');

    const dialogue = render(card(), fields({ mes_example: true }));
    expect(dialogue).toContain('Example dialogue:\n<START>');
    expect(dialogue).not.toContain('Alternate greetings:');
  });

  test('the embedded book renders every enabled entry in array order', () => {
    const text = render(
      card({
        character_book: {
          extensions: {},
          entries: [
            {
              keys: ['grove'],
              content: 'Old and quiet.',
              extensions: {},
              enabled: true,
              insertion_order: 0,
            },
            {
              keys: ['lantern', 'lamp'],
              content: 'Never goes out.',
              extensions: {},
              enabled: true,
              insertion_order: 1,
            },
            {
              keys: ['off'],
              content: 'Hidden.',
              extensions: {},
              enabled: false,
              insertion_order: 2,
            },
          ],
        },
      }),
      fields({ character_book: true }),
    );

    const lorebook = text.slice(text.indexOf('Lorebook:'));
    expect(lorebook).toContain('- grove → Old and quiet.');
    expect(lorebook).toContain('- lantern, lamp → Never goes out.');
    expect(lorebook).not.toContain('Hidden.');
    expect(lorebook.indexOf('grove')).toBeLessThan(lorebook.indexOf('lantern'));
  });

  test('a card with only a name still renders a usable block', () => {
    const text = render(
      card({
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        alternate_greetings: [],
        tags: [],
      }),
    );

    expect(text.trim()).toBe('### Example card 1 — Seraphina');
  });

  test('a nameless card still gets a heading', () => {
    expect(render(card({ name: '' }))).toContain('### Example card 1 — Unnamed');
  });
});

describe('rendering the block', () => {
  test('nothing attached renders nothing at all', () => {
    expect(renderExamples([], fields(), words)).toEqual({ text: '', examples: [], tokens: 0 });
  });

  test('the block frames the examples and numbers them in attachment order', () => {
    const rendered = renderExamples(
      [
        { avatar: 'Seraphina.png', card: card() },
        { avatar: 'Elowen.png', card: card({ name: 'Elowen' }) },
      ],
      fields(),
      words,
    );

    expect(rendered.text.startsWith(EXAMPLE_PREAMBLE)).toBe(true);
    expect(rendered.examples.map((example) => example.name)).toEqual(['Seraphina', 'Elowen']);
    expect(rendered.text).toContain('### Example card 1 — Seraphina');
    expect(rendered.text).toContain('### Example card 2 — Elowen');
  });

  test('per-example tokens plus the preamble account for the total', () => {
    const rendered = renderExamples(
      [
        { avatar: 'Seraphina.png', card: card() },
        { avatar: 'Elowen.png', card: card({ name: 'Elowen' }) },
      ],
      fields(),
      words,
    );
    const summed = rendered.examples.reduce((total, example) => total + example.tokens, 0);

    expect(rendered.tokens).toBe(summed + words.countText(EXAMPLE_PREAMBLE));
  });

  test('turning every field off still identifies each card, so the analysis stays verifiable', () => {
    const off = Object.fromEntries(
      Object.keys(DEFAULT_EXAMPLE_FIELDS).map((key) => [key, false]),
    ) as ExampleFields;
    const rendered = renderExamples([{ avatar: 'Seraphina.png', card: card() }], off, words);

    expect(rendered.text).toContain('Seraphina');
  });
});
