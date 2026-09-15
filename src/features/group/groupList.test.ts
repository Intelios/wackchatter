import { describe, expect, test } from 'bun:test';
import type { CharacterSummary } from '@shared/types/card.ts';
import type { ChatSummary } from '@shared/types/chat.ts';
import type { GroupTemplate } from '@shared/types/group.ts';
import { filterAndSortGroups, filterAndSortScenes } from './groupList.ts';

const characters: CharacterSummary[] = [
  {
    avatar: 'mika.png',
    name: 'Mika',
    description: '',
    creator: 'Intelios',
    tags: ['hero'],
    folder: '',
    character_version: '1',
    hasLorebook: false,
    modified: 100,
  },
  {
    avatar: 'mirei.png',
    name: 'Mirei',
    description: '',
    creator: 'Intelios',
    tags: ['sidekick'],
    folder: '',
    character_version: '1',
    hasLorebook: false,
    modified: 200,
  },
  {
    avatar: 'niamh.png',
    name: 'Niamh',
    description: '',
    creator: 'Intelios',
    tags: ['musician'],
    folder: '',
    character_version: '1',
    hasLorebook: false,
    modified: 300,
  },
];

const groups: GroupTemplate[] = [
  {
    id: 'g1',
    name: 'Trio Adventure',
    scenario: 'Journey to the lost temple',
    concurrency: 1,
    replyLimit: 4,
    members: [
      { id: 'm1', characterId: 'mika.png', name: 'Mika', publicProfile: '', muted: false },
      { id: 'm2', characterId: 'mirei.png', name: 'Mirei', publicProfile: '', muted: false },
      { id: 'm3', characterId: 'niamh.png', name: 'Niamh', publicProfile: '', muted: false },
    ],
    generation: { connectionId: 'c1', model: 'm1', presetId: 'p1' },
    director: { connectionId: 'c1', model: 'm1', maxTokens: 512, contextTokens: 4096 },
    lorebookIds: [],
    created: 1000,
    modified: 3000,
    revision: 1,
  },
  {
    id: 'g2',
    name: 'Duo Cozy',
    scenario: 'Coffee shop afternoon',
    concurrency: 1,
    replyLimit: 2,
    members: [
      { id: 'm1', characterId: 'mika.png', name: 'Mika', publicProfile: '', muted: false },
      { id: 'm2', characterId: 'mirei.png', name: 'Mirei', publicProfile: '', muted: false },
    ],
    generation: { connectionId: 'c1', model: 'm1', presetId: 'p1' },
    director: { connectionId: 'c1', model: 'm1', maxTokens: 512, contextTokens: 4096 },
    lorebookIds: [],
    created: 2000,
    modified: 5000,
    revision: 1,
  },
  {
    id: 'g3',
    name: 'Solo Musician Cast',
    scenario: 'Rehearsal studio rehearsal',
    concurrency: 1,
    replyLimit: 2,
    members: [
      { id: 'm3', characterId: 'niamh.png', name: 'Niamh', publicProfile: '', muted: false },
    ],
    generation: { connectionId: 'c1', model: 'm1', presetId: 'p1' },
    director: { connectionId: 'c1', model: 'm1', maxTokens: 512, contextTokens: 4096 },
    lorebookIds: [],
    created: 500,
    modified: 1000,
    revision: 1,
  },
];

const scenes: ChatSummary[] = [
  {
    id: 's1',
    characterId: null,
    kind: 'group',
    title: 'Temple Expedition Turn 1',
    created: 1000,
    modified: 4000,
    messageCount: 15,
    lastMessage: 'The ancient gate slowly creaked open under the torchlight.',
    groupMembers: ['mika.png', 'mirei.png', 'niamh.png'],
  },
  {
    id: 's2',
    characterId: null,
    kind: 'group',
    title: 'Latte Art Contest',
    created: 2000,
    modified: 6000,
    messageCount: 5,
    lastMessage: 'Mirei smiled and held up the cup with foam art.',
    groupMembers: ['mika.png', 'mirei.png'],
  },
  {
    id: 's3',
    characterId: null,
    kind: 'group',
    title: 'Acoustic Solo',
    created: 500,
    modified: 2000,
    messageCount: 50,
    lastMessage: 'The guitar strings vibrated warmly across the room.',
    groupMembers: ['niamh.png'],
  },
];

describe('filterAndSortGroups', () => {
  test('returns all groups when query is empty', () => {
    const result = filterAndSortGroups(groups, '', 'recent');
    expect(result).toHaveLength(3);
  });

  test('filters by group name case-insensitively', () => {
    const result = filterAndSortGroups(groups, 'adventure', 'recent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('g1');
  });

  test('filters by group scenario text', () => {
    const result = filterAndSortGroups(groups, 'coffee shop', 'recent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('g2');
  });

  test('filters by member name in cast', () => {
    const result = filterAndSortGroups(groups, 'niamh', 'recent');
    expect(result).toHaveLength(2);
    expect(result.map((g) => g.id)).toContain('g1');
    expect(result.map((g) => g.id)).toContain('g3');
  });

  test('sorts by recent (modified desc)', () => {
    const result = filterAndSortGroups(groups, '', 'recent');
    expect(result.map((g) => g.id)).toEqual(['g2', 'g1', 'g3']);
  });

  test('sorts by name ascending', () => {
    const result = filterAndSortGroups(groups, '', 'name');
    expect(result.map((g) => g.name)).toEqual(['Duo Cozy', 'Solo Musician Cast', 'Trio Adventure']);
  });

  test('sorts by member count descending', () => {
    const result = filterAndSortGroups(groups, '', 'members');
    expect(result.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });
});

describe('filterAndSortScenes', () => {
  test('returns all scenes when query is empty', () => {
    const result = filterAndSortScenes(scenes, characters, '', 'recent');
    expect(result).toHaveLength(3);
  });

  test('filters by scene title', () => {
    const result = filterAndSortScenes(scenes, characters, 'latte', 'recent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('s2');
  });

  test('filters by last message preview snippet', () => {
    const result = filterAndSortScenes(scenes, characters, 'ancient gate', 'recent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('s1');
  });

  test('filters by character name in group members', () => {
    const result = filterAndSortScenes(scenes, characters, 'niamh', 'recent');
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  test('sorts by recent descending', () => {
    const result = filterAndSortScenes(scenes, characters, '', 'recent');
    expect(result.map((s) => s.id)).toEqual(['s2', 's1', 's3']);
  });

  test('sorts by title ascending', () => {
    const result = filterAndSortScenes(scenes, characters, '', 'name');
    expect(result.map((s) => s.title)).toEqual([
      'Acoustic Solo',
      'Latte Art Contest',
      'Temple Expedition Turn 1',
    ]);
  });

  test('sorts by member count descending', () => {
    const result = filterAndSortScenes(scenes, characters, '', 'members');
    expect(result.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });
});
