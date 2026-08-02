import { describe, expect, test } from 'bun:test';
import { dialogueRanges, dialogueSegments, rehypeDialogue } from './dialogue.ts';

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
