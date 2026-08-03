import { describe, expect, test } from 'bun:test';
import {
  dialogueRanges,
  dialogueSegments,
  emphasisRanges,
  rehypeDialogue,
  streamSegments,
} from './dialogue.ts';

describe('dialogueRanges', () => {
  test('recognises straight and curly English double quotes', () => {
    expect(dialogueRanges('She said "hello", then “goodbye”.')).toEqual([
      { start: 9, end: 16 },
      { start: 23, end: 32 },
    ]);
  });

  test('finds several pairs but ignores single and unmatched quotes', () => {
    expect(dialogueRanges(`"one" and 'two' and "three" then "unfinished`)).toEqual([
      { start: 0, end: 5 },
      { start: 20, end: 27 },
    ]);
  });

  test('never carries a pair across a line boundary', () => {
    expect(dialogueRanges('"first\nsecond"')).toEqual([]);
  });
});

describe('dialogueSegments', () => {
  test('preserves every character while marking completed dialogue', () => {
    expect(dialogueSegments('Before "hello" after')).toEqual([
      { text: 'Before ', dialogue: false },
      { text: '"hello"', dialogue: true },
      { text: ' after', dialogue: false },
    ]);
  });

  test('ignores quotes inside inline and fenced code', () => {
    const source = 'Say `"not dialogue"` then "yes".\n```txt\n"also not"\n```';
    expect(
      dialogueSegments(source)
        .filter((part) => part.dialogue)
        .map((part) => part.text),
    ).toEqual(['"yes"']);
    expect(
      dialogueSegments(source)
        .map((part) => part.text)
        .join(''),
    ).toBe(source);
  });

  test('does not pair across an inline-code barrier', () => {
    expect(dialogueSegments('"hello `code` world"').some((part) => part.dialogue)).toBeFalse();
  });
});

describe('emphasisRanges', () => {
  test('finds closed em and strong pairs with delimiters excluded', () => {
    expect(emphasisRanges('*hi* and **there**')).toEqual([
      { delimStart: 0, start: 1, end: 3, delimEnd: 4, kind: 'em' },
      { delimStart: 9, start: 11, end: 16, delimEnd: 18, kind: 'strong' },
    ]);
  });

  test('an unclosed opener reaches the end of the text', () => {
    expect(emphasisRanges('*she smiled at')).toEqual([
      { delimStart: 0, start: 1, end: 14, delimEnd: 1, kind: 'em' },
    ]);
  });

  test('an opener followed by whitespace stays literal', () => {
    expect(emphasisRanges('* not a bullet\n* list')).toEqual([]);
  });

  test('a closer preceded by whitespace stays literal', () => {
    expect(emphasisRanges('*never *')).toEqual([
      { delimStart: 0, start: 1, end: 8, delimEnd: 1, kind: 'em' },
    ]);
  });

  test('pairs can span newlines', () => {
    expect(emphasisRanges('*first line\nsecond line*')).toEqual([
      { delimStart: 0, start: 1, end: 23, delimEnd: 24, kind: 'em' },
    ]);
  });

  test('backslash-escaped asterisks stay literal', () => {
    expect(emphasisRanges('\\*not em\\*')).toEqual([]);
    expect(emphasisRanges('\\\\*real*')).toEqual([
      { delimStart: 2, start: 3, end: 7, delimEnd: 8, kind: 'em' },
    ]);
  });
});

describe('streamSegments', () => {
  test('hides delimiters and marks emphasis and dialogue', () => {
    const source = '*"run"* she said';
    const segments = streamSegments(source);
    expect(segments.map((segment) => segment.text).join('')).toBe(source);
    expect(segments).toEqual([
      { text: '*', hidden: true, dialogue: false, emphasis: [] },
      { text: '"run"', hidden: false, dialogue: true, emphasis: ['em'] },
      { text: '*', hidden: true, dialogue: false, emphasis: [] },
      { text: ' she said', hidden: false, dialogue: false, emphasis: [] },
    ]);
  });

  test('an unclosed opener italicises the rest and dialogue still nests', () => {
    expect(streamSegments('*he said "go"')).toEqual([
      { text: '*', hidden: true, dialogue: false, emphasis: [] },
      { text: 'he said ', hidden: false, dialogue: false, emphasis: ['em'] },
      { text: '"go"', hidden: false, dialogue: true, emphasis: ['em'] },
    ]);
  });

  test('bold pairs hide their delimiters', () => {
    expect(streamSegments('**bold** text')).toEqual([
      { text: '**', hidden: true, dialogue: false, emphasis: [] },
      { text: 'bold', hidden: false, dialogue: false, emphasis: ['strong'] },
      { text: '**', hidden: true, dialogue: false, emphasis: [] },
      { text: ' text', hidden: false, dialogue: false, emphasis: [] },
    ]);
  });

  test('triple asterisks apply both kinds to the same content', () => {
    expect(streamSegments('***a***')).toEqual([
      { text: '***', hidden: true, dialogue: false, emphasis: [] },
      { text: 'a', hidden: false, dialogue: false, emphasis: ['em', 'strong'] },
      { text: '***', hidden: true, dialogue: false, emphasis: [] },
    ]);
  });

  test('nested strong inside em marks both and hides the inner delimiters', () => {
    expect(streamSegments('*a **b** c*')).toEqual([
      { text: '*', hidden: true, dialogue: false, emphasis: [] },
      { text: 'a ', hidden: false, dialogue: false, emphasis: ['em'] },
      { text: '**', hidden: true, dialogue: false, emphasis: ['em'] },
      { text: 'b', hidden: false, dialogue: false, emphasis: ['strong', 'em'] },
      { text: '**', hidden: true, dialogue: false, emphasis: ['em'] },
      { text: ' c', hidden: false, dialogue: false, emphasis: ['em'] },
      { text: '*', hidden: true, dialogue: false, emphasis: [] },
    ]);
  });

  test('no asterisks or quotes is a single plain segment', () => {
    expect(streamSegments('plain text')).toEqual([
      { text: 'plain text', hidden: false, dialogue: false, emphasis: [] },
    ]);
  });

  test('dialogue alone is marked as before', () => {
    expect(streamSegments('Before "hello" after')).toEqual([
      { text: 'Before ', hidden: false, dialogue: false, emphasis: [] },
      { text: '"hello"', hidden: false, dialogue: true, emphasis: [] },
      { text: ' after', hidden: false, dialogue: false, emphasis: [] },
    ]);
  });

  test('asterisks inside code stay literal', () => {
    const source = 'Use `*a*` then *b*';
    const segments = streamSegments(source);
    expect(segments.map((segment) => segment.text).join('')).toBe(source);
    expect(
      segments.filter((segment) => segment.emphasis.length > 0).map((segment) => segment.text),
    ).toEqual(['b']);
  });
});

describe('rehypeDialogue', () => {
  test('marks a quote across Markdown emphasis while leaving code alone', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'text', value: 'She said "' },
            {
              type: 'element',
              tagName: 'em',
              children: [{ type: 'text', value: 'hello' }],
            },
            { type: 'text', value: ' there" and ' },
            {
              type: 'element',
              tagName: 'code',
              children: [{ type: 'text', value: '"not dialogue"' }],
            },
          ],
        },
      ],
    };

    rehypeDialogue()(tree as never);
    const serialized = JSON.stringify(tree);
    expect(serialized.match(/message__dialogue/g)?.length).toBe(3);
    expect(serialized).not.toContain(
      'message__dialogue\\",\\"children\\":[{\\"type\\":\\"text\\",\\"value\\":\\"not dialogue',
    );
    expect(serialized).toContain('\\"not dialogue\\"');
  });
});
