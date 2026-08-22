import { describe, expect, test } from 'bun:test';
import { toCardPatch } from '@shared/cocreator/stash.ts';
import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import { renderSeedTurn, SEED_TURN_PREAMBLE, seedStash } from './seed.ts';

function card(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: 'A healer of the deep wood.',
    personality: 'Gentle, watchful.',
    scenario: 'The forest at dusk.',
    first_mes: 'You are safe here.',
    mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Rest.',
    creator_notes: 'My first card.',
    system_prompt: 'Write plainly.',
    post_history_instructions: 'Stay in voice.',
    alternate_greetings: ['The lanterns are lit.', 'You again.'],
    tags: ['fantasy', 'healer'],
    creator: 'Wren',
    character_version: '2.1',
    extensions: {},
    ...overrides,
  };
}

function detail(overrides: Partial<CardDataV2> = {}): CharacterDetail {
  const data = card(overrides);
  return {
    avatar: 'Seraphina.png',
    folder: '',
    name: data.name,
    description: data.description,
    creator: data.creator,
    tags: data.tags,
    character_version: data.character_version,
    hasLorebook: Boolean(data.character_book),
    modified: 0,
    card: { spec: 'chara_card_v2', data },
  };
}

describe('the seed turn', () => {
  test('renders readable labelled text for every non-empty field, never JSON', () => {
    const text = renderSeedTurn(detail());

    expect(text).toContain(SEED_TURN_PREAMBLE);
    expect(text).toContain('### The character — Seraphina');
    expect(text).toContain('Tags: fantasy, healer');
    expect(text).toContain('Description:\nA healer of the deep wood.');
    expect(text).toContain('System prompt:\nWrite plainly.');
    expect(text).toContain('Post-history instructions:\nStay in voice.');
    expect(text).toContain('Creator notes:\nMy first card.');
  });

  test('a blank field is omitted rather than shown as an empty heading', () => {
    const text = renderSeedTurn(detail({ scenario: '', personality: '   ' }));

    expect(text).not.toContain('Scenario:');
    expect(text).not.toContain('Personality:');
    expect(text).toContain('Description:');
  });

  test('alternate greetings are numbered and blanks are skipped', () => {
    const text = renderSeedTurn(detail({ alternate_greetings: ['One.', '  ', 'Two.'] }));

    expect(text).toContain('Alternate greetings:\n1. One.\n\n2. Two.');
    expect(text).not.toContain('3.');
  });

  test('the embedded book renders as keys → content lines', () => {
    const text = renderSeedTurn(
      detail({
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
          ],
        },
      }),
    );

    expect(text).toContain('Lorebook:\n- grove → Old and quiet.');
  });
});

describe('the seeded stash', () => {
  test('fills every non-empty slot from the card', () => {
    const stash = seedStash(detail(), 'seed-message');

    expect(stash.name?.text).toBe('Seraphina');
    expect(stash.description?.text).toBe('A healer of the deep wood.');
    expect(stash.system_prompt?.text).toBe('Write plainly.');
    expect(stash.alternate_greetings.map((entry) => entry.text)).toEqual([
      'The lanterns are lit.',
      'You again.',
    ]);
    expect(stash.tags.map((entry) => entry.text)).toEqual(['fantasy', 'healer']);
  });

  test('every entry is seeded from the seed message with source "seed"', () => {
    const stash = seedStash(detail(), 'seed-message');

    const entries = [stash.name, stash.description, ...stash.alternate_greetings, ...stash.tags];
    for (const entry of entries) {
      expect(entry).toBeDefined();
      expect(entry!.provenance).toMatchObject({
        messageId: 'seed-message',
        swipeIndex: 0,
        source: 'seed',
      });
      expect(entry!.provenance.at).toBeTruthy();
      expect(entry!.id).toBeTruthy();
    }
  });

  test('empty fields leave their slot absent, so Finish will not blank them', () => {
    const stash = seedStash(detail({ scenario: '', alternate_greetings: [], tags: [] }), 'm');

    expect(stash.scenario).toBeUndefined();
    expect(stash.alternate_greetings).toEqual([]);
    expect(stash.tags).toEqual([]);
    expect(toCardPatch(stash)).not.toHaveProperty('scenario');
  });

  test('the seeded stash projects to a complete card patch', () => {
    const stash = seedStash(detail(), 'm');
    const patch = toCardPatch(stash);

    expect(patch).toMatchObject({
      description: 'A healer of the deep wood.',
      personality: 'Gentle, watchful.',
      scenario: 'The forest at dusk.',
      first_mes: 'You are safe here.',
      mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Rest.',
      system_prompt: 'Write plainly.',
      post_history_instructions: 'Stay in voice.',
      creator_notes: 'My first card.',
      alternate_greetings: ['The lanterns are lit.', 'You again.'],
      tags: ['fantasy', 'healer'],
    });
  });
});
