import { describe, expect, test } from 'bun:test';
import { toCardPatch } from '@shared/cocreator/stash.ts';
import type { CardDataV2, TavernCard } from '@shared/types/card.ts';
import { seedCarryOver } from './finish.ts';

function card(overrides: Partial<CardDataV2> = {}): TavernCard {
  return {
    spec: 'chara_card_v2',
    data: {
      name: 'Seraphina',
      description: 'A healer of the deep wood.',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: 'Wren',
      character_version: '2.1',
      extensions: { world: 'Seraphina Lore', talkativeness: 0.4, fav: true },
      nickname: 'Sera',
      source: ['wackchatter'],
      group_only_greetings: ['Welcome, travelers.'],
      ...overrides,
    },
  };
}

describe('the seed carry-over', () => {
  test('carries the book, extensions and identity fields the stash cannot hold', () => {
    const carry = seedCarryOver(card());

    expect(carry).toEqual({
      extensions: { world: 'Seraphina Lore', talkativeness: 0.4, fav: false },
      creator: 'Wren',
      character_version: '2.1',
      nickname: 'Sera',
      source: ['wackchatter'],
      group_only_greetings: ['Welcome, travelers.'],
    });
  });

  test('a favourite is reset, not inherited — a variant starts unfaved', () => {
    expect(seedCarryOver(card()).extensions?.fav).toBe(false);
  });

  test('the carry-over is disjoint from every key a stash patch can emit', () => {
    const carry = seedCarryOver(card({ character_book: { extensions: {}, entries: [] } }));

    expect(Object.keys(carry)).toEqual([
      'character_book',
      'extensions',
      'creator',
      'character_version',
      'nickname',
      'source',
      'group_only_greetings',
    ]);
    expect(Object.keys(carry)).not.toContain('description');
    expect(Object.keys(toCardPatch({ alternate_greetings: [], tags: [] }))).toEqual([]);
  });

  test('empty identity fields are omitted, so they cannot blank the fresh card', () => {
    const carry = seedCarryOver(card({ creator: '  ', character_version: '' }));

    expect(carry).not.toHaveProperty('creator');
    expect(carry).not.toHaveProperty('character_version');
  });

  test('empty extensions are omitted entirely', () => {
    expect(seedCarryOver(card({ extensions: {} }))).not.toHaveProperty('extensions');
  });
});
