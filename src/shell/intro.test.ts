import { describe, expect, test } from 'bun:test';
import { introLine } from './intro.ts';

describe('introLine', () => {
  test('takes the first sentence of prose', () => {
    expect(introLine('A travelling bard who owes everyone money. She sings badly and often.')).toBe(
      'A travelling bard who owes everyone money.',
    );
  });

  test('collapses whitespace', () => {
    expect(introLine('  A quiet   harbourmaster\nof a drowned city.  ')).toBe(
      'A quiet harbourmaster of a drowned city.',
    );
  });

  test('cuts a long sentence-free description short', () => {
    const long = 'word '.repeat(60).trim();
    const line = introLine(long);
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith('…')).toBe(true);
  });

  test('gives nothing for W++ and JSON blocks', () => {
    expect(introLine('[Seraphina\'s Personality= "caring", "protective"]')).toBe('');
    expect(introLine('{"name": "Mika", "age": 20}')).toBe('');
    expect(introLine('Personality= "caring" + "warm"')).toBe('');
  });

  test('gives nothing for a run of labelled fields', () => {
    expect(introLine('Name: Mika Asagiri Age: 20 Gender: Female Nationality: Japanese')).toBe('');
  });

  test('keeps prose that merely contains one colon', () => {
    expect(
      introLine('She has one rule: never sing before noon. Everything else is negotiable.'),
    ).toBe('She has one rule: never sing before noon.');
  });

  test('empty in, empty out', () => {
    expect(introLine('   ')).toBe('');
  });
});
