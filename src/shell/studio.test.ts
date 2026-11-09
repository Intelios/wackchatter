import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { WorldInfoEntry } from '@shared/types/worldinfo.ts';
import { bookEntries, toWorldInfoBook } from '@shared/worldinfo/convert.ts';
import {
  cardChanges,
  cardCost,
  diffSnippet,
  entryPatch,
  entryWhen,
  joinExamples,
  macroKnown,
  macroParts,
  moveItem,
  parseExamples,
  studioProblems,
} from './studio.ts';

const counter = {
  countText: (text: string) => text.split(/\s+/).filter(Boolean).length,
  countChat: () => 0,
};

const data = (patch: Partial<CardDataV2> = {}): CardDataV2 => ({
  name: 'Mika',
  description: 'A student and influencer.',
  personality: '',
  scenario: '',
  first_mes: 'Hi {{user}}, I am {{char}}.',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: ['Second.', 'Third.'],
  tags: ['OC'],
  creator: 'Intelios',
  character_version: 'main',
  extensions: {},
  ...patch,
});

const entries = (book: CardDataV2['character_book']): WorldInfoEntry[] =>
  book ? bookEntries(toWorldInfoBook(book)) : [];

const BOOK: CardDataV2['character_book'] = {
  extensions: {},
  entries: [
    {
      keys: ['Talia', 'Sister'],
      content: 'Her twin.',
      extensions: {},
      enabled: true,
      insertion_order: 1,
    },
    {
      keys: [],
      content: 'Always here.',
      constant: true,
      extensions: {},
      enabled: true,
      insertion_order: 2,
    },
  ],
};

describe('macros', () => {
  test('the engine decides what is known', () => {
    expect(macroKnown('{{char}}')).toBe(true);
    expect(macroKnown('{{user}}')).toBe(true);
    expect(macroKnown('{{chra}}')).toBe(false);
  });

  test('text splits into runs and macros', () => {
    expect(macroParts('Hi {{user}} and {{chra}}!')).toEqual([
      { text: 'Hi ' },
      { text: '{{user}}', macro: true },
      { text: ' and ' },
      { text: '{{chra}}', macro: false },
      { text: '!' },
    ]);
  });
});

describe('problems', () => {
  test('a sound card has none, whatever it leaves empty', () => {
    expect(studioProblems(data({ creator: '', tags: [], creator_notes: '' }), [])).toEqual([]);
  });

  test('only what breaks the card', () => {
    const problems = studioProblems(
      data({ name: ' ', first_mes: '', alternate_greetings: ['Hello {{chra}}'] }),
      entries({
        extensions: {},
        entries: [{ keys: [], content: 'x', extensions: {}, enabled: true, insertion_order: 1 }],
      }),
    );
    expect(problems.map((p) => [p.section, p.where])).toEqual([
      ['identity', 'Name'],
      ['greetings', 'First message'],
      ['greetings', 'Greeting 2'],
      ['lorebook', 'Entry 0'],
    ]);
  });

  test('a switched-off entry without keys is not a problem', () => {
    const list = entries({
      extensions: {},
      entries: [{ keys: [], content: 'x', extensions: {}, enabled: false, insertion_order: 1 }],
    });
    expect(studioProblems(data(), list)).toEqual([]);
  });
});

describe('cost', () => {
  test('always sent, the opening and lore when it fires, apart', () => {
    const cost = cardCost(data({ character_book: BOOK }), entries(BOOK), counter);
    expect(cost.alwaysTotal).toBe(4 + 2);
    expect(cost.always.map((row) => row.label)).toEqual(['Description', 'Always-on lore']);
    expect(cost.firstMessage).toBe(5);
    expect(cost.lore.map((row) => [row.label, row.tokens])).toEqual([['Talia', 2]]);
    expect(cost.bySection.definition).toBe(4);
    expect(cost.bySection.lorebook).toBe(2);
  });
});

describe('changes since opening', () => {
  const opened = { data: data({ character_book: BOOK }), folder: '', entries: entries(BOOK) };

  test('nothing changed, nothing listed', () => {
    expect(cardChanges(opened, opened)).toEqual([]);
  });

  test('one item per thing that can be put back', () => {
    const edited = entries(BOOK).map((e) =>
      e.uid === 0 ? { ...e, content: 'Her twin sister.' } : e,
    );
    const added = { ...(edited[0] as WorldInfoEntry), uid: 9, comment: 'Emily' };
    const changes = cardChanges(opened, {
      data: data({
        name: 'Mika A',
        description: 'A student.',
        tags: ['OC', 'NSFW'],
        alternate_greetings: ['Third.', 'Second.'],
      }),
      folder: 'Drafts',
      entries: [...edited, added],
    });
    expect(changes.map((c) => c.id)).toEqual([
      'name',
      'folder',
      'description',
      'alternate_greetings',
      'tags',
      'entry:0',
      'entry:9',
    ]);
    expect(changes.find((c) => c.id === 'alternate_greetings')?.before).toBe('Reordered');
    expect(changes.find((c) => c.id === 'entry:9')?.target).toEqual({
      kind: 'added-entry',
      uid: 9,
    });
  });

  test('a moved entry has not changed', () => {
    const moved = entries(BOOK).map((e) => ({ ...e, displayIndex: e.displayIndex + 5 }));
    expect(cardChanges(opened, { ...opened, entries: moved })).toEqual([]);
  });

  test('put back restores everything but the bookkeeping', () => {
    const entry = entries(BOOK)[0] as WorldInfoEntry;
    const patch = entryPatch(entry);
    expect('uid' in patch).toBe(false);
    expect('displayIndex' in patch).toBe(false);
    expect(patch.content).toBe('Her twin.');
  });

  test('the snippet shows what differs', () => {
    expect(diffSnippet('She smiles warmly.', 'She smiles coldly.')).toEqual({
      lead: 'She smiles ',
      gone: 'warm',
      added: 'cold',
      tail: 'ly.',
    });
    expect(
      diffSnippet('The cat sat on the old mat today.', 'The cat sat on the new mat today.'),
    ).toEqual({
      lead: '… cat sat on the ',
      gone: 'old',
      added: 'new',
      tail: ' mat today.',
    });
    const inserted = diffSnippet('Name: Mika\nAge', 'Name: Mika {{user}}\nAge');
    expect([inserted.gone, inserted.added]).toEqual(['', ' {{user}}']);
  });
});

describe('examples', () => {
  const text =
    '<START>\n{{user}}: Hi\n{{char}}: *waves* "Hello."\nStill talking.\n<START>\n{{user}}: Bye';

  test('read as conversations and written back the same', () => {
    const blocks = parseExamples(text);
    expect(blocks).toEqual([
      [
        { who: 'user', text: 'Hi' },
        { who: 'char', text: '*waves* "Hello."\nStill talking.' },
      ],
      [{ who: 'user', text: 'Bye' }],
    ]);
    expect(joinExamples(blocks ?? [])).toBe(text);
  });

  test('anything else stays raw', () => {
    expect(parseExamples('Mika: hi')).toBeNull();
    expect(parseExamples('<START>\nNarration first\n{{char}}: hi')).toBeNull();
    expect(parseExamples('   ')).toEqual([]);
  });
});

test('moveItem', () => {
  expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
});

test('when an entry fires, in words', () => {
  const [keyed, constant] = entries(BOOK) as [WorldInfoEntry, WorldInfoEntry];
  expect(entryWhen(keyed, 2)).toBe(
    'Fires when ‘Talia’ or ‘Sister’ comes up in the last 2 messages.',
  );
  expect(entryWhen(constant, 2)).toBe('Always on: sent with every reply.');
  expect(entryWhen({ ...keyed, key: [] }, 2)).toBe('It has no keys, so it never fires.');
});
