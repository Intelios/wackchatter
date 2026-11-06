import { describe, expect, test } from 'bun:test';
import { agoInWords, isNamedChat, quoteOf, splitName, stepStack, whenInWords } from './home.ts';

/** A local moment, so the tests read in the calendar they are about. */
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

// Friday 6 November 2026, mid-morning.
const NOW = at(2026, 11, 6, 10, 30);

describe('isNamedChat', () => {
  test('the default title and blanks are unnamed', () => {
    expect(isNamedChat('New chat')).toBe(false);
    expect(isNamedChat('  ')).toBe(false);
    expect(isNamedChat('The café after the rain')).toBe(true);
  });
});

describe('whenInWords', () => {
  test('earlier today reads by the part of the day', () => {
    expect(whenInWords(at(2026, 11, 6, 10, 0), NOW)).toBe('Just now');
    expect(whenInWords(at(2026, 11, 6, 7), NOW)).toBe('This morning');
  });

  test('the small hours belong to the night before', () => {
    expect(whenInWords(at(2026, 11, 6, 1), NOW)).toBe('Late last night');
    expect(whenInWords(at(2026, 11, 5, 23), NOW)).toBe('Late last night');
    expect(whenInWords(at(2026, 11, 5, 15), NOW)).toBe('Yesterday afternoon');
  });

  test('this week names the day, then it gets vaguer', () => {
    expect(whenInWords(at(2026, 11, 2, 19), NOW)).toBe('Monday evening');
    // 2am on Tuesday is still Monday night.
    expect(whenInWords(at(2026, 11, 3, 2), NOW)).toBe('Monday night');
    expect(whenInWords(at(2026, 10, 28, 12), NOW)).toBe('Last Wednesday');
    expect(whenInWords(at(2026, 10, 20, 12), NOW)).toBe('A fortnight ago');
    expect(whenInWords(at(2026, 10, 13, 12), NOW)).toBe('Three weeks ago');
    expect(whenInWords(at(2026, 9, 25, 12), NOW)).toBe('Last month');
    expect(whenInWords(at(2026, 7, 1, 12), NOW)).toBe('Four months ago');
    expect(whenInWords(at(2025, 6, 1, 12), NOW)).toBe('Last year');
  });
});

describe('agoInWords', () => {
  test('exact, for the stack', () => {
    expect(agoInWords(NOW - 2 * 3_600_000, NOW)).toBe('2 hours ago');
    expect(agoInWords(at(2026, 11, 5, 9), NOW)).toBe('Yesterday');
    expect(agoInWords(at(2026, 11, 3, 9), NOW)).toBe('3 days ago');
    expect(agoInWords(at(2026, 10, 20, 9), NOW)).toBe('2 weeks ago');
  });
});

describe('quoteOf', () => {
  const names = { char: 'Mika', user: 'Rowan' };

  test('the first line they speak, from inside its quotation marks', () => {
    expect(quoteOf('[Scene]: The officer sighs. "Fine. You don\'t." Then: "Go home."', names)).toBe(
      "Fine. You don't.",
    );
  });

  test('curly and guillemet quotes count, actions in asterisks never do', () => {
    expect(quoteOf('*She yawns.* \u201cStill awake?\u201d', names)).toBe('Still awake?');
    expect(quoteOf('*"not this"* «Bonjour.»', names)).toBe('Bonjour.');
  });

  test('a reply with nothing in quotes has no quote', () => {
    expect(quoteOf('[Scene]: She nods slowly and leaves.', names)).toBe('');
  });

  test('names resolve, other macros never show raw', () => {
    expect(quoteOf('"Hi {{user}}, I\'m {{char}}.{{random:a,b}}"', names)).toBe(
      "Hi Rowan, I'm Mika.",
    );
  });

  test('a long line is cut at a word with an ellipsis', () => {
    const quote = quoteOf(`"${'word '.repeat(60)}"`, names, 40);
    expect(quote.endsWith('word…')).toBe(true);
    expect(quote.length).toBeLessThanOrEqual(41);
  });
});

describe('splitName', () => {
  test('short or single-word names stay on one line', () => {
    expect(splitName('Mika')).toEqual(['Mika']);
    expect(splitName('Supercalifragilistic')).toEqual(['Supercalifragilistic']);
  });

  test('a long name breaks into two balanced lines', () => {
    expect(splitName('Lady Marisol of the Ninth Bell')).toEqual([
      'Lady Marisol of',
      'the Ninth Bell',
    ]);
  });
});

describe('stepStack', () => {
  test('walks down and back up to the cover, never past the ends', () => {
    expect(stepStack(-1, 3, 1)).toBe(0);
    expect(stepStack(2, 3, 1)).toBe(2);
    expect(stepStack(0, 3, -1)).toBe(-1);
    expect(stepStack(-1, 3, -1)).toBe(-1);
  });
});
