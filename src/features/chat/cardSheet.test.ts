import { describe, expect, test } from 'bun:test';
import type { CardDataV2, CharacterBook } from '@shared/types/card.ts';
import {
  type CardSheet,
  defaultSectionId,
  formatBookSection,
  normalizeSectionLabel,
  readCardSheet,
  resolveSectionId,
} from './cardSheet.ts';

function card(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Mirei',
    description: 'Standing at 5′7″, her raven-black hair falls in twin tails.',
    personality: 'Magnetically charismatic, fiercely private.',
    scenario: 'The supply boat is three weeks late.',
    first_mes: 'She does not turn from the lamp.',
    mes_example: '<START>\n{{user}}: Hello\n{{char}}: Mm.',
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

function book(entries: Partial<CharacterBook['entries'][number]>[]): CharacterBook {
  return {
    extensions: {},
    entries: entries.map((entry, index) => ({
      keys: [],
      content: '',
      extensions: {},
      enabled: true,
      insertion_order: index,
      ...entry,
    })),
  };
}

describe('reading a card as a sheet', () => {
  test('a full card reads at the field rung, in card order', () => {
    const sheet = readCardSheet(
      card({ character_book: book([{ keys: ['lamp'], content: 'Brass.' }]) }),
    );

    expect(sheet.rung).toBe('fields');
    expect(sheet.sections.map((section) => section.label)).toEqual([
      'Description',
      'Personality',
      'Scenario',
      'Examples',
      'Lorebook',
    ]);
  });

  /*
   * The promise the whole feature rests on. Whatever the ladder does, every word the card
   * carries has to be somewhere a reader can reach — a section they never open is fine, a
   * section that does not exist is not.
   */
  test('every non-empty field lands in some section', () => {
    const sheet = readCardSheet(
      card({ character_book: book([{ keys: ['scar'], content: 'White seam.' }]) }),
    );
    const all = sheet.sections.map((section) => section.text).join('\n');

    for (const fragment of [
      'raven-black hair',
      'fiercely private',
      'supply boat',
      '{{char}}: Mm.',
      'White seam.',
    ]) {
      expect(all).toContain(fragment);
    }
  });

  test('an empty field gets no section rather than an empty one', () => {
    const sheet = readCardSheet(card({ personality: '', scenario: '   \n ' }));

    expect(sheet.sections.map((section) => section.label)).toEqual(['Description', 'Examples']);
  });

  /*
   * One chip is not an index — it reads as a broken tab bar. A card with nothing but a
   * description drops the row and just shows the text, which is all it ever had.
   */
  test('a card with only a description falls to the raw floor', () => {
    const sheet = readCardSheet(card({ personality: '', scenario: '', mes_example: '' }));

    expect(sheet.rung).toBe('raw');
    expect(sheet.sections).toHaveLength(1);
    expect(sheet.sections[0]?.text).toContain('raven-black hair');
  });

  test('an empty card yields one empty section instead of crashing', () => {
    const sheet = readCardSheet(
      card({ description: '', personality: '', scenario: '', mes_example: '' }),
    );

    expect(sheet.rung).toBe('raw');
    expect(sheet.sections).toHaveLength(1);
    expect(sheet.sections[0]?.text).toBe('');
  });

  test('section ids are derived from the field, not from position', () => {
    const first = readCardSheet(card());
    const shifted = readCardSheet(
      card({ description: `A new opening line.\n\n${card().description}` }),
    );

    expect(first.sections[0]?.id).toBe('field:description');
    expect(shifted.sections[0]?.id).toBe('field:description');
  });

  test('macros resolve, so a description reads as prose rather than as braces', () => {
    const sheet = readCardSheet(card({ description: '{{char}} watches {{user}}.' }), (text) =>
      text.replaceAll('{{char}}', 'Mirei').replaceAll('{{user}}', 'Jack'),
    );

    expect(sheet.sections[0]?.text).toBe('Mirei watches Jack.');
  });
});

describe('a field that carries its own structure', () => {
  const structured = [
    'Appearance:',
    'Standing at 5\'7", her raven-black hair falls in twin tails.',
    '',
    'Backstory:',
    'She grew up within sight of the light.',
  ].join('\n');

  test('the description splits into its headings and the sheet says so', () => {
    const sheet = readCardSheet(card({ description: structured }));

    expect(sheet.rung).toBe('headings');
    expect(sheet.sections.map((section) => section.label)).toEqual([
      'Appearance',
      'Backstory',
      'Personality',
      'Scenario',
      'Examples',
    ]);
  });

  /*
   * The first invariant, and the reason a wrong guess is survivable: a split refines one
   * field. Whatever `cardStructure.ts` decides about the description, the personality,
   * scenario, examples and lorebook are still their own chips — so the worst a parse can do
   * is give you a chip you ignore, never take away a section you needed.
   */
  test('a split refines a field; it never replaces the card', () => {
    const sheet = readCardSheet(
      card({
        description: structured,
        character_book: book([{ keys: ['lamp'], content: 'Brass, and freshly polished.' }]),
      }),
    );
    const all = sheet.sections.map((section) => section.text).join('\n');

    for (const fragment of ['twin tails', 'fiercely private', 'supply boat', '{{char}}: Mm.']) {
      expect(all).toContain(fragment);
    }
    expect(sheet.sections.some((section) => section.label === 'Lorebook')).toBe(true);
  });

  /*
   * The second invariant. Every character of the description lands in exactly one section,
   * heading lines included — nothing is summarised, reordered, or quietly dropped on the way
   * to a chip.
   */
  test('the sections of a field partition that field exactly', () => {
    const sheet = readCardSheet(card({ description: structured }));
    const fromDescription = sheet.sections.filter(
      (section) => section.source.kind === 'split' && section.source.field === 'description',
    );

    expect(fromDescription.map((section) => section.text).join('')).toBe(structured);
  });

  test('sections carry the style that found them, for anything that needs to explain itself', () => {
    const sheet = readCardSheet(
      card({ description: '## Appearance\nRaven.\n\n## Backstory\nCoast.' }),
    );

    expect(sheet.sections[0]?.source).toEqual({
      kind: 'split',
      field: 'description',
      style: 'markdown',
    });
  });

  test('ids come from the heading, so the open section survives an edit above it', () => {
    const first = readCardSheet(card({ description: structured }));
    const shifted = readCardSheet(card({ description: `A new opening line.\n\n${structured}` }));

    expect(first.sections[0]?.id).toBe('description:appearance');
    expect(shifted.sections.map((section) => section.id)).toContain('description:appearance');
  });

  /*
   * Both are transcripts of a sort, and every heuristic in `cardStructure.ts` false-positives
   * on one: forty chips named after whatever the speaker said first.
   */
  test('example dialogue and the lorebook are never split', () => {
    const sheet = readCardSheet(
      card({
        mes_example: '## Appearance\nMm.\n\n## Backstory\nMm.',
        character_book: book([
          { keys: ['lamp'], content: '## Appearance\nBrass.\n\n## Age\nOld.' },
        ]),
      }),
    );

    expect(sheet.sections.map((section) => section.label)).toContain('Examples');
    expect(sheet.sections.map((section) => section.label)).toContain('Lorebook');
    expect(sheet.rung).toBe('fields');
  });

  test('a heading found in the personality is labelled from the personality', () => {
    const sheet = readCardSheet(
      card({ description: '', personality: 'Warmth:\nReal, but rationed.\n\nTemper:\nSlow.' }),
    );

    expect(sheet.sections.map((section) => section.label)).toEqual([
      'Warmth',
      'Temper',
      'Scenario',
      'Examples',
    ]);
  });

  test('two headings of the same name still get their own chip', () => {
    const sheet = readCardSheet(
      card({
        description: '## Appearance\nHuman: raven hair.\n\n## Appearance\nWolf: grey, and larger.',
      }),
    );
    const ids = sheet.sections.map((section) => section.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('description:appearance');
    expect(ids).toContain('description:appearance-2');
  });

  test('appearance opens by default even when the card puts it second', () => {
    const sheet = readCardSheet(
      card({ description: 'Backstory:\nThe coast.\n\nAppearance:\nRaven hair.' }),
    );

    expect(defaultSectionId(sheet)).toBe('description:appearance');
  });
});

describe('choosing which section opens', () => {
  function sheetOf(...labels: string[]): CardSheet {
    return {
      rung: 'headings',
      sections: labels.map((label) => ({
        id: `description:${normalizeSectionLabel(label)}`,
        label,
        text: '',
        source: { kind: 'split', field: 'description', style: 'colon' },
      })),
    };
  }

  test('appearance wins even when it is not first', () => {
    expect(defaultSectionId(sheetOf('Backstory', 'Appearance', 'Skills'))).toBe(
      'description:appearance',
    );
  });

  test('the usual other names for appearance count too', () => {
    for (const label of ['Looks', 'Physical Description', 'Body']) {
      expect(defaultSectionId(sheetOf('Backstory', label))).toBe(
        `description:${normalizeSectionLabel(label)}`,
      );
    }
  });

  test('with no appearance section the first one opens', () => {
    expect(defaultSectionId(sheetOf('Backstory', 'Skills'))).toBe('description:backstory');
  });

  test('at the field rung that means the description', () => {
    expect(defaultSectionId(readCardSheet(card()))).toBe('field:description');
  });

  /*
   * The section memory outlives the card it was recorded against — edit the card so a
   * heading disappears and the remembered id names nothing. Falling back beats opening on
   * a blank.
   */
  test('a remembered id the card no longer has falls back to the default', () => {
    const sheet = readCardSheet(card());

    expect(resolveSectionId(sheet, 'description:appearance')).toBe('field:description');
    expect(resolveSectionId(sheet, 'field:scenario')).toBe('field:scenario');
    expect(resolveSectionId(sheet, null)).toBe('field:description');
  });
});

describe('flattening a lorebook for reading', () => {
  test('keys are included, since an entry may never say its own keyword', () => {
    const text = formatBookSection(
      book([{ keys: ['scar', 'seam'], content: 'She will not discuss it.' }]),
    );

    expect(text).toContain('scar, seam');
    expect(text).toContain('She will not discuss it.');
  });

  test('a comment titles the entry alongside its keys', () => {
    const text = formatBookSection(
      book([{ comment: 'The dive', keys: ['scar'], content: 'Deep water.' }]),
    );

    expect(text).toContain('The dive — scar');
  });

  /* This is a reading surface, not a prompt preview: a disabled entry is still something
     the card says, and hiding it would make the sheet disagree with the editor. */
  test('disabled entries are still readable', () => {
    const text = formatBookSection(book([{ keys: ['lamp'], content: 'Fresnel.', enabled: false }]));

    expect(text).toContain('Fresnel.');
  });

  test('a missing or empty book is empty text, not a section', () => {
    expect(formatBookSection(undefined)).toBe('');
    expect(formatBookSection(book([]))).toBe('');
    expect(readCardSheet(card()).sections.some((section) => section.label === 'Lorebook')).toBe(
      false,
    );
  });
});

describe('normalising a label', () => {
  test('case, spaces and punctuation all fold to one form', () => {
    expect(normalizeSectionLabel('Physical Description')).toBe('physical-description');
    expect(normalizeSectionLabel('  APPEARANCE:  ')).toBe('appearance');
    expect(normalizeSectionLabel('Speech_Patterns')).toBe('speech-patterns');
  });

  test('a label with nothing alphanumeric in it normalises to empty', () => {
    expect(normalizeSectionLabel('—')).toBe('');
  });
});
