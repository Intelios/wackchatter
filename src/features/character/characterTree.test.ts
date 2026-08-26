import { describe, expect, test } from 'bun:test';
import type { CharacterSummary } from '@shared/types/card.ts';
import {
  buildCharacterTree,
  matchesQuery,
  parseTagQuery,
  type TreeRow,
  visibleTagsOf,
} from './characterTree.ts';

function character(name: string, folder = '', extra: Partial<CharacterSummary> = {}) {
  return {
    avatar: `${name}.png`,
    folder,
    name,
    description: '',
    creator: '',
    tags: [],
    character_version: '',
    hasLorebook: false,
    modified: 0,
    ...extra,
  } satisfies CharacterSummary;
}

/** Rows as "depth:label" so a whole layout is one readable assertion. */
function shape(rows: TreeRow[]): string[] {
  return rows.map((row) =>
    row.kind === 'folder'
      ? `${row.depth}:[${row.name}] ${row.count}`
      : `${row.depth}:${row.character.name}`,
  );
}

function build(input: Partial<Parameters<typeof buildCharacterTree>[0]>) {
  return buildCharacterTree({
    characters: [],
    folders: [],
    collapsed: [],
    query: '',
    sort: 'name',
    ratings: {},
    ...input,
  });
}

describe('buildCharacterTree', () => {
  test('puts folders before cards at each level, both alphabetical', () => {
    const rows = build({
      characters: [character('Zoe'), character('Adam'), character('Elf', 'Fantasy')],
      folders: ['Fantasy', 'Archive'],
    });

    expect(shape(rows)).toEqual(['0:[Archive] 0', '0:[Fantasy] 1', '1:Elf', '0:Adam', '0:Zoe']);
  });

  test('nests to any depth', () => {
    const rows = build({
      characters: [character('Deep', 'Fantasy/Elves/Woodland')],
      folders: ['Fantasy', 'Fantasy/Elves', 'Fantasy/Elves/Woodland'],
    });

    expect(shape(rows)).toEqual(['0:[Fantasy] 1', '1:[Elves] 1', '2:[Woodland] 1', '3:Deep']);
  });

  test('folder counts include every descendant', () => {
    const rows = build({
      characters: [character('A', 'Fantasy'), character('B', 'Fantasy/Elves')],
      folders: ['Fantasy', 'Fantasy/Elves'],
    });

    expect(shape(rows)).toEqual(['0:[Fantasy] 2', '1:[Elves] 1', '2:B', '1:A']);
  });

  test('an empty folder still gets a row, because the directory is the record', () => {
    expect(shape(build({ folders: ['Empty'] }))).toEqual(['0:[Empty] 0']);
  });

  test('a collapsed folder keeps its row and its count but hides its subtree', () => {
    const rows = build({
      characters: [character('A', 'Fantasy'), character('B', 'Fantasy/Elves'), character('Top')],
      folders: ['Fantasy', 'Fantasy/Elves'],
      collapsed: ['Fantasy'],
    });

    expect(shape(rows)).toEqual(['0:[Fantasy] 2', '0:Top']);
  });

  test('collapsing an inner folder leaves its parent open', () => {
    const rows = build({
      characters: [character('A', 'Fantasy'), character('B', 'Fantasy/Elves')],
      folders: ['Fantasy', 'Fantasy/Elves'],
      collapsed: ['Fantasy/Elves'],
    });

    expect(shape(rows)).toEqual(['0:[Fantasy] 2', '1:[Elves] 1', '1:A']);
  });

  /*
   * The case this guards: a folder made in a file browser while the app is open. The card list
   * may refresh before the folder list does, and without filling ancestors in from the cards
   * themselves that card has no parent row and vanishes from the panel entirely.
   */
  test('a card in a folder the server has not listed yet still appears', () => {
    const rows = build({ characters: [character('Elf', 'Fantasy/Elves')], folders: [] });

    expect(shape(rows)).toEqual(['0:[Fantasy] 1', '1:[Elves] 1', '2:Elf']);
  });

  describe('search', () => {
    test('flattens the tree to matches only, with no folder rows', () => {
      const rows = build({
        characters: [
          character('Elf', 'Fantasy/Elves'),
          character('Dwarf', 'Fantasy'),
          character('Zoe'),
        ],
        folders: ['Fantasy', 'Fantasy/Elves'],
        query: 'f',
      });

      // Every match at depth 0, sorted by name, folders gone.
      expect(shape(rows)).toEqual(['0:Dwarf', '0:Elf']);
    });

    test('a match keeps its folder, so the row can still say where it lives', () => {
      const rows = build({ characters: [character('Elf', 'Fantasy/Elves')], query: 'elf' });
      expect(rows[0]?.kind === 'character' && rows[0].character.folder).toBe('Fantasy/Elves');
    });

    test('whitespace is not a search', () => {
      const rows = build({ characters: [character('Elf', 'Fantasy')], query: '   ' });
      expect(shape(rows)).toEqual(['0:[Fantasy] 1', '1:Elf']);
    });
  });

  describe('rating sort', () => {
    test('sorts cards by rating descending within their folder, ties by name', () => {
      const rows = build({
        characters: [
          character('Zoe', '', { avatar: 'Zoe.png' }),
          character('Adam', '', { avatar: 'Adam.png' }),
          character('Elf', 'Fantasy', { avatar: 'Elf.png' }),
        ],
        folders: ['Fantasy'],
        sort: 'rating',
        ratings: { 'Adam.png': 5, 'Zoe.png': 3 },
      });

      // The folder still leads; inside it, Elf is unrated and sinks below the top level.
      expect(shape(rows)).toEqual(['0:[Fantasy] 1', '1:Elf', '0:Adam', '0:Zoe']);
    });

    test('unrated cards come last, alphabetical among themselves', () => {
      const rows = build({
        characters: [character('Zed'), character('Ann'), character('Bob')],
        sort: 'rating',
        ratings: { 'Bob.png': 1 },
      });

      expect(shape(rows)).toEqual(['0:Bob', '0:Ann', '0:Zed']);
    });

    test('a rating tie breaks alphabetically', () => {
      const rows = build({
        characters: [character('Zed'), character('Ann')],
        sort: 'rating',
        ratings: { 'Zed.png': 4, 'Ann.png': 4 },
      });

      expect(shape(rows)).toEqual(['0:Ann', '0:Zed']);
    });

    test('applies to flattened search results too', () => {
      const rows = build({
        characters: [
          character('Elf', 'Fantasy/Elves'),
          character('Dwarf', 'Fantasy'),
          character('Zoe'),
        ],
        folders: ['Fantasy', 'Fantasy/Elves'],
        query: 'f',
        sort: 'rating',
        ratings: { 'Elf.png': 2 },
      });

      expect(shape(rows)).toEqual(['0:Elf', '0:Dwarf']);
    });
  });
});

describe('matchesQuery', () => {
  test('matches name, creator and tags, case-insensitively', () => {
    const elf = character('Elf', '', { creator: 'Tolkien', tags: ['fantasy', 'Woodland'] });

    expect(matchesQuery(elf, 'ELF')).toBe(true);
    expect(matchesQuery(elf, 'tolk')).toBe(true);
    expect(matchesQuery(elf, 'woodland')).toBe(true);
    expect(matchesQuery(elf, 'dwarf')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(matchesQuery(character('Elf'), '')).toBe(true);
    expect(matchesQuery(character('Elf'), '  ')).toBe(true);
  });
});

describe('parseTagQuery', () => {
  test('extracts leading-# tokens and keeps the rest as text', () => {
    expect(parseTagQuery('#vampire seraphina by night')).toEqual({
      text: 'seraphina by night',
      tags: ['vampire'],
    });
  });

  test('a query without # tokens parses to itself as text', () => {
    expect(parseTagQuery('  elf  woodland ')).toEqual({ text: 'elf woodland', tags: [] });
  });

  test('keeps several # tokens in typed order', () => {
    expect(parseTagQuery('#elf #dwarf moria')).toEqual({ text: 'moria', tags: ['elf', 'dwarf'] });
  });

  test('a bare # and a mid-word # are ordinary text, not tag filters', () => {
    expect(parseTagQuery('#')).toEqual({ text: '#', tags: [] });
    expect(parseTagQuery('C# dev')).toEqual({ text: 'C# dev', tags: [] });
  });

  test('a blank query parses to nothing', () => {
    expect(parseTagQuery('   ')).toEqual({ text: '', tags: [] });
  });
});

describe('matchesQuery: #tag filter', () => {
  const dracula = character('Dracula', '', { creator: 'Stoker', tags: ['Vampire', 'Noble'] });

  test('matches a tag case-insensitively, as a substring', () => {
    expect(matchesQuery(dracula, '#VAMPIRE')).toBe(true);
    expect(matchesQuery(dracula, '#vamp')).toBe(true);
    expect(matchesQuery(dracula, '#werewolf')).toBe(false);
  });

  test('scopes the # token to tags — a card only named for it does not match', () => {
    expect(matchesQuery(character('Vampire Hunter'), '#vampire')).toBe(false);
  });

  test('ANDs with the remaining text', () => {
    expect(matchesQuery(dracula, '#vampire stoker')).toBe(true);
    expect(matchesQuery(dracula, '#vampire elrond')).toBe(false);
  });

  test('a multi-word tag is reachable without quoting', () => {
    const slowBurn = character('Wren', '', { tags: ['Slow burn'] });
    // "#slow burn" is the tag token `slow` plus the text `burn`, and the text pass searches
    // tags too — together they find the card the tag belongs to.
    expect(matchesQuery(slowBurn, '#slow burn')).toBe(true);
    expect(matchesQuery(slowBurn, '#fast burn')).toBe(false);
  });

  test('several # tokens all have to match', () => {
    expect(matchesQuery(dracula, '#vampire #noble')).toBe(true);
    expect(matchesQuery(dracula, '#vampire #peasant')).toBe(false);
  });

  test('a # that is not a tag filter stays literal text', () => {
    expect(matchesQuery(character('Turing'), '#')).toBe(false);
    expect(matchesQuery(character('Turing', '', { creator: 'C# fan' }), 'C#')).toBe(true);
  });
});

describe('visibleTagsOf', () => {
  test('hides matching tags case-insensitively and leaves the others', () => {
    expect(visibleTagsOf(['OC', 'fantasy', 'oc', 'slow burn'], ['oc'])).toEqual([
      'fantasy',
      'slow burn',
    ]);
  });

  test('returns no tags when every tag is hidden', () => {
    expect(visibleTagsOf(['OC', 'Spoiler'], ['oc', 'spoiler'])).toEqual([]);
  });

  test('preserves the order of visible tags', () => {
    expect(visibleTagsOf(['first', 'second', 'third'], ['second'])).toEqual(['first', 'third']);
  });
});
