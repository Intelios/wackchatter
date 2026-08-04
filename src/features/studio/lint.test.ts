import { expect, test } from 'bun:test';
import type { CardDataV2, CharacterDetail } from '@shared/types/card.ts';
import { measureCard } from './budget.ts';
import { lintCard } from './lint.ts';

const counter = {
  countText: (text: string) => text.split(/\s+/).filter(Boolean).length,
  countChat: () => 0,
};

const baseData: CardDataV2 = {
  name: 'Nova',
  description: 'A capable navigator.',
  personality: 'Patient.',
  scenario: 'A distant station.',
  first_mes: 'Hello, {{user}}.',
  mes_example: '<START>\n{{user}}: Hello\n{{char}}: Welcome.',
  creator_notes: 'Test card.',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: ['Good morning.'],
  tags: ['science fiction'],
  creator: 'Tester',
  character_version: '1.0',
  extensions: {},
  character_book: {
    extensions: {},
    entries: [
      {
        keys: ['station'],
        content: 'The station orbits a gas giant.',
        extensions: {},
        enabled: true,
        insertion_order: 1,
      },
    ],
  },
};

function detail(patch: Partial<CardDataV2> = {}, avatar = 'Nova.png'): CharacterDetail {
  const data = {
    ...baseData,
    ...patch,
    extensions: { ...baseData.extensions, ...patch.extensions },
  };
  return {
    avatar,
    folder: '',
    name: data.name,
    description: data.description,
    creator: data.creator,
    tags: data.tags,
    character_version: data.character_version,
    hasLorebook: Boolean(data.character_book),
    alternateGreetingCount: data.alternate_greetings.length,
    modified: 0,
    card: { data },
  };
}

function ids(input: CharacterDetail, books: readonly string[] = []) {
  return lintCard(input, measureCard(input.card.data, counter), books).map((finding) => finding.id);
}

test('lintCard accepts a complete portable card', () => {
  expect(ids(detail())).toEqual([]);
});

test('lintCard reports a blank name', () => {
  expect(ids(detail({ name: '' }))).toContain('name-blank');
});

test('lintCard reports a blank first message', () => {
  expect(ids(detail({ first_mes: ' ' }))).toContain('first-message-blank');
});

test('lintCard uses macro diagnostics for unknown macros', () => {
  const findings = lintCard(
    detail({ description: '{{nonsence}}' }),
    measureCard(detail({ description: '{{nonsence}}' }).card.data, counter),
  );
  expect(findings).toContainEqual({
    id: 'macro-description-nonsence',
    level: 'error',
    section: 'definition',
    message: 'Unknown macro {{nonsence}} in description.',
  });
});

test('lintCard reports a keyless non-constant embedded entry', () => {
  expect(
    ids(
      detail({
        character_book: {
          extensions: {},
          entries: [
            { keys: [], content: 'orphan', extensions: {}, enabled: true, insertion_order: 1 },
          ],
        },
      }),
    ),
  ).toContain('book-0-keys');
});

test('lintCard reports a blank description', () => {
  expect(ids(detail({ description: '' }))).toContain('description-blank');
});

test('lintCard reports examples without START', () => {
  expect(ids(detail({ mes_example: '{{char}}: Hi' }))).toContain('examples-no-start');
});

test('lintCard reports blank alternate greetings', () => {
  expect(ids(detail({ alternate_greetings: [''] }))).toContain('alternate-blank');
});

test('lintCard reports duplicated alternate greetings', () => {
  expect(ids(detail({ alternate_greetings: ['Hello', ' hello '] }))).toContain(
    'alternate-duplicate',
  );
});

test('lintCard reports an identity that differs from the PNG filename', () => {
  expect(ids(detail({ name: 'Other' }))).toContain('name-filename');
});

test('lintCard reports blank creator and version fields', () => {
  const findings = ids(detail({ creator: '', character_version: '' }));
  expect(findings).toContain('creator-blank');
  expect(findings).toContain('version-blank');
});

test('lintCard reports the conventional blank avatar filename', () => {
  expect(ids(detail({}, 'blank-avatar.png'))).toContain('avatar-placeholder');
});

test('lintCard reports missing linked lorebooks', () => {
  expect(ids(detail({ extensions: { world: 'Missing book' } }))).toContain('world-missing');
});

test('lintCard accepts a linked local lorebook', () => {
  expect(ids(detail({ extensions: { world: 'Station lore' } }), ['Station lore'])).not.toContain(
    'world-missing',
  );
});

test('lintCard reports absent discovery metadata and lorebook', () => {
  const findings = ids(detail({ tags: [], creator_notes: '', character_book: undefined }));
  expect(findings).toContain('tags-empty');
  expect(findings).toContain('creator-notes-empty');
  expect(findings).toContain('lorebook-empty');
});
