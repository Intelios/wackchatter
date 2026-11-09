import { describe, expect, test } from 'bun:test';
import { type InkKind, inkSegments } from './ink.ts';

const kinds = (text: string) => inkSegments(text).map((s) => [s.kind, s.text] as [InkKind, string]);

describe('inkSegments', () => {
  test('every character lands in exactly one segment', () => {
    const text = '/guide "Hello, {{char}}," *I wave.*\n"Still talking';
    expect(
      inkSegments(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text);
  });

  test('colours speech, actions, macros and a leading command', () => {
    expect(kinds('/guide "Hi, {{char}}." *I wave.*')).toEqual([
      ['command', '/guide'],
      ['plain', ' '],
      ['say', '"Hi, '],
      ['macro', '{{char}}'],
      ['say', '."'],
      ['plain', ' '],
      ['act', '*I wave.*'],
    ]);
  });

  test('speech still being typed is coloured to the end of the line', () => {
    expect(kinds('She says "wait')).toEqual([
      ['plain', 'She says '],
      ['say', '"wait'],
    ]);
  });

  test('an unclosed action runs to the end of its line only', () => {
    expect(kinds('*leans in\nthen nothing')).toEqual([
      ['act', '*leans in'],
      ['plain', '\nthen nothing'],
    ]);
  });

  test('speech inside an action reads as speech', () => {
    expect(kinds('*says "hi" softly*')).toEqual([
      ['act', '*says '],
      ['say', '"hi"'],
      ['act', ' softly*'],
    ]);
  });

  test('a slash later in the text is not a command', () => {
    expect(kinds('either/or')).toEqual([['plain', 'either/or']]);
  });

  test('empty text has no segments', () => {
    expect(inkSegments('')).toEqual([]);
  });
});
