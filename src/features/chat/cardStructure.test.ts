import { describe, expect, test } from 'bun:test';
import { type FieldSplit, findHeadingSections, splitCardText } from './cardStructure.ts';

function split(text: string, fallback = 'Description'): FieldSplit | null {
  return findHeadingSections(text, fallback);
}

function labels(text: string, fallback = 'Description'): string[] {
  return split(text, fallback)?.parts.map((part) => part.label) ?? [];
}

/**
 * The invariant the whole ladder rests on, asserted rather than intended: the parts tile the
 * field exactly. A wrong guess can therefore put a section boundary in a silly place, but it
 * can never lose a sentence — there is nowhere for a sentence to go.
 */
function expectExactPartition(text: string, found: FieldSplit | null): void {
  expect(found).not.toBeNull();
  if (!found) return;

  expect(found.parts.length).toBeGreaterThanOrEqual(2);
  expect(found.parts[0]?.start).toBe(0);
  expect(found.parts[found.parts.length - 1]?.end).toBe(text.length);
  for (let i = 1; i < found.parts.length; i++) {
    expect(found.parts[i]?.start).toBe(found.parts[i - 1]?.end ?? -1);
    expect(found.parts[i]?.end).toBeGreaterThan(found.parts[i]?.start ?? 0);
  }
  expect(found.parts.map((part) => text.slice(part.start, part.end)).join('')).toBe(text);
}

describe('the 2+ rule', () => {
  test('two headings of one style are a structure', () => {
    const text = '## Appearance\nRaven hair.\n\n## Backstory\nShe grew up on the coast.';

    expect(split(text)?.style).toBe('markdown');
    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
  });

  test('one heading is a false positive, not a shape', () => {
    expect(split('## Appearance\nRaven hair, and a great deal more of it.')).toBeNull();
  });

  /*
   * The case a naive implementation gets wrong: count the headings and you find two, so the
   * field "has structure". It does not — it has two unrelated accidents, and reading them as
   * an outline would cut a description in half at a line that was never a heading.
   */
  test('one heading of each of two styles is two accidents', () => {
    const text = '## Appearance\nRaven hair.\n\nBackstory:\nShe grew up on the coast.';

    expect(split(text)).toBeNull();
  });

  test('a field with no headings at all splits into nothing', () => {
    expect(split('Standing at 5\'7", her raven-black hair falls in twin tails.')).toBeNull();
    expect(split('')).toBeNull();
    expect(split('   \n\n  ')).toBeNull();
  });
});

describe('style precedence', () => {
  /*
   * Confidence, not popularity. `## Appearance` cannot be anything but a heading; a line
   * ending in a colon is one only by convention. A field carrying both is read the
   * unambiguous way.
   */
  test('markdown outranks colon when both would fire', () => {
    const text = [
      '## Appearance',
      'Raven hair.',
      '',
      '## Backstory',
      'The coast.',
      '',
      'Notes:',
      'She dislikes the lamp room.',
      '',
      'Habits:',
      'Never sleeps before three.',
    ].join('\n');

    const found = split(text);
    expect(found?.style).toBe('markdown');
    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expectExactPartition(text, found);
  });

  test('bracket outranks colon', () => {
    const text =
      '[Appearance]\nRaven hair.\n\n[Backstory]\nThe coast.\n\nNotes:\nNothing.\n\nMore:\nNothing.';

    expect(split(text)?.style).toBe('bracket');
  });
});

describe('markdown headings', () => {
  test('a hashtag is not a heading', () => {
    const text = '#slice-of-life\n#vampire\nShe is eighteen and tired of it.';

    expect(split(text)).toBeNull();
  });

  /*
   * A card that opens `# Mirei` and then runs `## Appearance`, `## Backstory` has a title and
   * two headings, not three sections. Taking the shallowest level that repeats reads the
   * title as what it is.
   */
  test('a lone title above repeated subheadings is not one of them', () => {
    const text =
      '# Mirei\nThe keeper of the light.\n\n## Appearance\nRaven hair.\n\n## Backstory\nThe coast.';

    expect(labels(text)).toEqual(['Description', 'Appearance', 'Backstory']);
    expectExactPartition(text, split(text));
  });

  test('deeper headings nest inside the level that repeats', () => {
    const text = [
      '# Appearance',
      'Tall.',
      '',
      '## Hair',
      'Raven.',
      '',
      '# Backstory',
      'The coast.',
      '',
      '## Childhood',
      'Cold.',
    ].join('\n');

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expect(split(text)?.parts[0]?.end).toBeGreaterThan(text.indexOf('Raven.'));
  });

  test('closing hashes and bold markers are stripped from the label', () => {
    const text = '## **Appearance** ##\nRaven hair.\n\n## Backstory ##\nThe coast.';

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
  });
});

describe('xml headings', () => {
  test('a whole element on one line is a section', () => {
    const text =
      '<appearance>Pink hair, amber eyes.</appearance>\n<personality>Gentle.</personality>';

    expect(split(text)?.style).toBe('xml');
    expect(labels(text)).toEqual(['Appearance', 'Personality']);
  });

  test('an underscored tag reads as words on the chip', () => {
    const text =
      '<physical_appearance>\nPink hair.\n</physical_appearance>\n<back-story>\nForest.\n</back-story>';

    expect(labels(text)).toEqual(['Physical appearance', 'Back story']);
  });

  /*
   * `<START>` is the example-dialogue marker every second card carries, and nothing ever
   * closes it. Requiring the closing tag is the whole guard.
   */
  test('an unclosed tag is not a heading', () => {
    const text = [
      '<START>',
      '{{user}}: "Describe your traits?"',
      '{{char}}: *She smiles, and the light bends around her.*',
      '<START>',
      '{{user}}: Hello',
      '{{char}}: Mm.',
    ].join('\n');

    expect(split(text)).toBeNull();
  });

  test('a tag left open costs itself, not the tags that closed', () => {
    const text =
      '<appearance>\nPink hair.\n</appearance>\n<backstory>\nThe forest, and no way out of it.';

    // One survivor is not a structure.
    expect(split(text)).toBeNull();
  });

  test('a nested tag is not a sibling of the tag it sits in', () => {
    const text = [
      '<appearance>',
      'Pink hair.',
      '<hair>Long, and never tied.</hair>',
      '</appearance>',
      '<backstory>',
      'The forest.',
      '</backstory>',
    ].join('\n');

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expect(split(text)?.parts[0]?.end).toBeGreaterThan(text.indexOf('</hair>'));
  });
});

describe('bracket headings', () => {
  test('a bracketed word on its own line is a section', () => {
    const text = '[Appearance]\nRaven hair.\n\n[Backstory]\nThe coast.';

    expect(split(text)?.style).toBe('bracket');
    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
  });

  /*
   * PList and W++ are structure too, but they are rung 2's. Read as headings they would name
   * a section after an entire attribute list.
   */
  test('a PList line is not a heading', () => {
    const text = [
      '[Seraphina\'s body= "pink hair", "long hair", "amber eyes", "white teeth"]',
      '[Seraphina\'s Personality= "caring", "protective", "compassionate", "healing"]',
    ].join('\n');

    expect(split(text)).toBeNull();
  });

  test('a W++ line is not a heading', () => {
    const text = '[character("Mika"){hair("blonde")}]\n[character("Talia"){hair("black")}]';

    expect(split(text)).toBeNull();
  });
});

describe('colon headings', () => {
  test('a label alone on its line is a section', () => {
    const text = 'Appearance:\nRaven hair.\n\nBackstory:\nThe coast.\n\nSkills:\nShe can sail.';

    expect(split(text)?.style).toBe('colon');
    expect(labels(text)).toEqual(['Appearance', 'Backstory', 'Skills']);
  });

  /*
   * The block cards open with. Every line of it ends in a colon *and keeps going*, which is
   * the difference — and it is the difference that keeps a card's metadata out of the chip
   * row without needing to know what "Occupation" means.
   */
  test('a metadata block is not a stack of headings', () => {
    const text = [
      'Name: Mirei Hayashi',
      'Age: 18',
      'Gender: Female',
      'Occupation: High School Senior, Part-time Model',
      '',
      'Appearance:',
      'Standing at 5\'7", her raven-black hair falls in twin tails.',
      '',
      'Backstory:',
      'The coast, and a long way from it.',
    ].join('\n');

    expect(labels(text)).toEqual(['Description', 'Appearance', 'Backstory']);
    expectExactPartition(text, split(text));
    expect(split(text)?.parts[0]?.end).toBeGreaterThan(text.indexOf('Part-time Model'));
  });

  test('example dialogue is not a stack of headings either', () => {
    const text =
      '{{user}}: Hello\n{{char}}: Mm.\n{{user}}: Are you well?\n{{char}}: I am always well.';

    expect(split(text)).toBeNull();
  });

  test('a sentence that ends on a colon is not a heading', () => {
    const text =
      'She had one rule:\nNever the water after dark.\n\nHe gave one warning:\nDo not follow her down.';

    expect(split(text)).toBeNull();
  });

  test('a lowercase opener is prose, whatever it ends with', () => {
    const text = 'and then she said:\nnothing at all.\n\nbut he asked again:\nstill nothing.';

    expect(split(text)).toBeNull();
  });

  test('a heading with nothing under it is a line that ended oddly', () => {
    const text = 'Appearance:\nRaven hair.\n\nBackstory:\nThe coast.\n\nNotes:';

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expectExactPartition(text, split(text));
  });

  test('bolded headings are the same headings', () => {
    const text = '**Appearance:**\nRaven hair.\n\n**Backstory:**\nThe coast.';

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
  });

  test('an ampersand and a second word still read as one topic', () => {
    const text = 'Likes & Secret Interests:\nSea glass.\n\nSpeech Patterns:\nClipped.';

    expect(labels(text)).toEqual(['Likes & Secret Interests', 'Speech Patterns']);
  });

  /*
   * Cards are consistent about blank-separating their headings even when they are consistent
   * about nothing else, so where that discipline exists it is worth holding every candidate
   * to — it is the one signal that tells a heading from a colon inside a paragraph.
   */
  test('where headings are blank-separated, a colon inside a paragraph is not one', () => {
    const text = [
      'Appearance:',
      '',
      'Raven hair.',
      'Mirei made one promise:',
      'Never to leave the island.',
      '',
      'Backstory:',
      '',
      'The coast.',
    ].join('\n');

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expectExactPartition(text, split(text));
  });

  /* The compact format has no blank lines to be consistent about, so it is read as it is. */
  test('the compact format still reads', () => {
    const text = 'Appearance:\nRaven hair.\nPersonality:\nCold.\nSkills:\nShe can sail.';

    expect(labels(text)).toEqual(['Appearance', 'Personality', 'Skills']);
    expectExactPartition(text, split(text));
  });

  /*
   * The known limit, written down rather than papered over. A sentence naming its subject
   * clears every guard — no lowercase opener, few enough words, nothing after the colon —
   * and where the card offers no blank-line discipline to fall back on, it reads as a
   * heading. The cost is a chip with an odd name; the text underneath is untouched, which is
   * the direction this is allowed to fail in.
   */
  test('a subject-first sentence can still slip through, and costs only a chip', () => {
    const text =
      'Mirei made one promise:\nNever to leave.\nNiamh broke another:\nShe left at once.';

    expect(labels(text)).toEqual(['Mirei made one promise', 'Niamh broke another']);
    expectExactPartition(text, split(text));
  });
});

describe('the text above the first heading', () => {
  test('takes the field name, since that is what it would have been called', () => {
    const text = 'She keeps the light.\n\n## Appearance\nRaven hair.\n\n## Backstory\nThe coast.';

    expect(labels(text, 'Personality')).toEqual(['Personality', 'Appearance', 'Backstory']);
  });

  test('a field that opens on a heading gets no spare chip', () => {
    const text = '## Appearance\nRaven hair.\n\n## Backstory\nThe coast.';

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
  });

  test('blank space above the first heading is absorbed rather than given a chip', () => {
    const text = '\n\n  \n## Appearance\nRaven hair.\n\n## Backstory\nThe coast.';

    expect(labels(text)).toEqual(['Appearance', 'Backstory']);
    expectExactPartition(text, split(text));
  });
});

describe('line endings', () => {
  /* A card saved on Windows is the same card. */
  test('CRLF splits exactly as LF does, and the ranges still slice clean', () => {
    const unix = 'Appearance:\nRaven hair.\n\nBackstory:\nThe coast.\n\nSkills:\nShe can sail.';
    const windows = unix.replace(/\n/g, '\r\n');

    expect(labels(windows)).toEqual(labels(unix));
    expectExactPartition(windows, split(windows));
    expect(split(windows)?.parts[0]?.label).toBe('Appearance');
  });

  test('a lone CR does not leave itself in the label', () => {
    const text = '## Appearance\r\nRaven hair.\r\n\r\n## Backstory\r\nThe coast.';

    for (const label of labels(text)) expect(label).not.toContain('\r');
  });
});

describe('the seam', () => {
  test('splitCardText is the heading pass until groups land', () => {
    const text = '## Appearance\nRaven hair.\n\n## Backstory\nThe coast.';

    expect(splitCardText(text, 'Description')).toEqual(findHeadingSections(text, 'Description'));
    expect(splitCardText('One undivided paragraph, as most cards are.', 'Description')).toBeNull();
  });
});
