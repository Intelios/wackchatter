import { describe, expect, test } from 'bun:test';
import type { CharacterSummary } from '@shared/types/card.ts';
import { buildCharacterTree, matchesQuery, type TreeRow } from './characterTree.ts';

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
