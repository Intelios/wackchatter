import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '@shared/types/card.ts';
import {
  cardFolds,
  cardUpdates,
  clampCrop,
  coverOverflow,
  cropAfterDrag,
  greetingPreview,
  readableCardText,
  readableNotes,
  storedCrop,
} from './sheet.ts';

function card(fields: Partial<CardDataV2>): CardDataV2 {
  return {
    name: 'Mika',
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
    extensions: {},
    ...fields,
  } as CardDataV2;
}

describe('cardFolds', () => {
  test('lists filled fields in card order and leaves empty ones out', () => {
    const folds = cardFolds(
      card({ scenario: 'A sleepover.', description: 'Your best friend.', mes_example: '   ' }),
    );
    expect(folds.map((fold) => fold.id)).toEqual(['description', 'scenario']);
  });

  test('one alternate greeting stays a plain fold', () => {
    const [one] = cardFolds(card({ alternate_greetings: ['Hi!', ' '] }));
    expect(one).toEqual({
      kind: 'text',
      id: 'alternate_greetings',
      label: 'Alternate greeting',
      text: 'Hi!',
    });
  });

  test('several alternate greetings become one section of rows', () => {
    const folds = cardFolds(
      card({
        first_mes: 'Hello.',
        alternate_greetings: ['One.', ' ', 'Two.'],
        mes_example: '<START>',
      }),
    );
    expect(folds.map((fold) => fold.id)).toEqual([
      'first_mes',
      'alternate_greetings',
      'mes_example',
    ]);
    expect(folds[1]).toEqual({
      kind: 'greetings',
      id: 'alternate_greetings',
      label: 'Alternate greetings · 2',
      greetings: ['One.', 'Two.'],
    });
  });

  test('all-blank alternate greetings add no section', () => {
    expect(cardFolds(card({ first_mes: 'Hello.', alternate_greetings: [' ', '\n'] }))).toEqual([
      { kind: 'text', id: 'first_mes', label: 'First message', text: 'Hello.' },
    ]);
  });
});

describe('greetingPreview', () => {
  test('reads the first two paragraphs as single lines', () => {
    expect(
      greetingPreview('  First line.\nStill the first.\n\nSecond   paragraph.\n\nThird.'),
    ).toEqual({ lead: 'First line. Still the first.', trail: 'Second paragraph.' });
  });

  test('a single paragraph has no second line', () => {
    expect(greetingPreview('Only this.')).toEqual({ lead: 'Only this.', trail: '' });
  });

  test('blank blocks and CRLF leave nothing to preview', () => {
    expect(greetingPreview('\r\n  \r\n\r\n')).toEqual({ lead: '', trail: '' });
    expect(greetingPreview('\n\n  First.\r\n\r\nSecond.\n\n')).toEqual({
      lead: 'First.',
      trail: 'Second.',
    });
  });
});

describe('cardUpdates', () => {
  test('lists the changelog in stored order, labels trimmed, names resolved', () => {
    expect(
      cardUpdates(
        card({
          updates: [
            { label: ' v1.2 · 2026-09-18 ', text: 'Rebalanced the lorebook.' },
            { text: '{{char}} says hello to {{user}}.' },
          ],
        }),
        { char: 'Mika', user: 'Jack' },
      ),
    ).toEqual([
      { label: 'v1.2 · 2026-09-18', text: 'Rebalanced the lorebook.' },
      { label: '', text: 'Mika says hello to Jack.' },
    ]);
  });

  test('entries that say nothing are left out; no updates is no timeline', () => {
    const names = { char: 'Mika', user: 'Jack' };
    expect(cardUpdates(card({ updates: [{ label: 'v1.1', text: '  ' }] }), names)).toEqual([]);
    expect(cardUpdates(card({}), names)).toEqual([]);
  });

  test('markup-styled update text reads as its words, like notes', () => {
    const [one] = cardUpdates(card({ updates: [{ text: '<div>Added<br>a greeting.</div>' }] }), {
      char: 'Mika',
      user: 'Jack',
    });
    expect(one?.text).toBe('Added\na greeting.');
  });
});

describe('readableCardText', () => {
  test('names the character and you, in either spelling, and keeps other macros', () => {
    expect(
      readableCardText('{{char}} waves at {{User}}. <USER> waves back. {{random:a,b}}', {
        char: 'Mika',
        user: 'Jack',
      }),
    ).toBe('Mika waves at Jack. Jack waves back. {{random:a,b}}');
  });
});

describe('crops', () => {
  test('are clamped to the portrait and kept to one decimal', () => {
    expect(clampCrop(-4)).toBe(0);
    expect(clampCrop(120)).toBe(100);
    expect(clampCrop(31.46)).toBe(31.5);
  });

  test('the picture follows the pointer: dragging down moves the crop up', () => {
    expect(cropAfterDrag(20, 50, 500)).toBe(10);
    expect(cropAfterDrag(20, -50, 500)).toBe(30);
    expect(cropAfterDrag(20, 900, 500)).toBe(0);
    // A picture with nothing hidden cannot be moved.
    expect(cropAfterDrag(20, 50, 0)).toBe(20);
  });

  test('a tall portrait overflows a strip; a wide one does not', () => {
    // 360×128 strip, 564×1000 portrait: scaled to 360 wide it is 638 tall.
    expect(
      Math.round(coverOverflow({ width: 360, height: 128 }, { width: 564, height: 1000 })),
    ).toBe(510);
    expect(coverOverflow({ width: 360, height: 128 }, { width: 2000, height: 400 })).toBe(0);
    expect(coverOverflow({ width: 360, height: 128 }, { width: 0, height: 0 })).toBe(0);
  });

  test('the automatic crop is stored as no entry at all', () => {
    expect(storedCrop(20)).toBeUndefined();
    expect(storedCrop(20.04)).toBeUndefined();
    expect(storedCrop(33)).toBe(33);
  });
});

describe('readableNotes', () => {
  test('notes without markup pass through untouched', () => {
    const notes = '  Written for slow burn.\n\n    Indented on purpose.';
    expect(readableNotes(notes)).toBe(notes);
  });

  test('a styled page reads as its words and line breaks', () => {
    const notes = [
      '<div style="position: relative; font-family: Inter;">',
      '  <!-- SOCIAL MEDIA HEADER -->',
      '  <style>.x { color: red; }</style>',
      '  <div style="padding: 2rem">',
      '    <h1 style="font-size: 2.2rem">Mirei</h1>',
      '    <div>Vampire &amp; heiress<br>Rated &#8220;spicy&#8221;</div>',
      '    <ul><li>One</li><li>Two</li></ul>',
      '  </div>',
      '</div>',
    ].join('\n');
    expect(readableNotes(notes)).toBe(
      'Mirei\n\nVampire & heiress\nRated “spicy”\n\n- One\n\n- Two',
    );
  });
});
