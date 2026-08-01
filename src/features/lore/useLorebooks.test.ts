import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { WorldInfoBook } from '@shared/types/worldinfo.ts';
import { composeLorebookSources } from './useLorebooks.ts';

const emptyBook = (name: string): WorldInfoBook => ({ name, entries: {} });

function character(): CardDataV2 {
  return {
    name: 'Sera',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: { world: 'linked' },
    character_book: {
      name: 'embedded',
      extensions: {},
      entries: [
        {
          keys: ['key'],
          content: 'embedded lore',
          extensions: {},
          enabled: true,
          insertion_order: 1,
        },
      ],
    },
  };
}

describe('persona lorebook source composition', () => {
  test('places persona lore ahead of embedded, linked, and global sources', () => {
    const sources = composeLorebookSources({
      character: character(),
      linkedName: 'linked',
      loaded: {
        persona: emptyBook('persona'),
        linked: emptyBook('linked'),
        global: emptyBook('global'),
      },
      globalIds: ['global'],
      personaId: 'persona',
    });

    expect(sources.map((source) => source.kind)).toEqual([
      'persona',
      'embedded',
      'linked',
      'global',
    ]);
  });

  test('deduplicates one standalone book referenced by several source types', () => {
    const sources = composeLorebookSources({
      character: character(),
      linkedName: 'shared',
      loaded: { shared: emptyBook('shared') },
      globalIds: ['shared', 'shared'],
      personaId: 'shared',
    });

    expect(sources.filter((source) => source.name === 'shared')).toEqual([
      { kind: 'persona', name: 'shared', book: emptyBook('shared') },
    ]);
  });

  test('a missing persona reference contributes nothing and does not fail composition', () => {
    expect(
      composeLorebookSources({
        character: null,
        linkedName: null,
        loaded: {},
        globalIds: [],
        personaId: 'missing',
      }),
    ).toEqual([]);
  });
});
