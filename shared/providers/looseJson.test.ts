import { expect, test } from 'bun:test';
import { looseParseJson, stripThinkBlocks } from './looseJson.ts';

test('looseParseJson reads a plain, fenced, or prefaced object', () => {
  expect(looseParseJson('{"a":1}')).toEqual({ a: 1 });
  expect(looseParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(looseParseJson('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  // The trailing-comma retry is the quirk this file exists to keep in one copy.
  expect(looseParseJson('{"a":[1,2,]}')).toEqual({ a: [1, 2] });
  expect(looseParseJson('No JSON in this reply.')).toBe(null);
});

test('looseParseJson strips a thinking block that muses with JSON shapes', () => {
  // A reasoning model's scratchpad quoting an example shape would otherwise splice itself
  // into the first-{-to-last-} span and parse as nothing — the same hazard the group
  // director strips for.
  expect(
    looseParseJson(
      '<think>The user wants facts shaped like {"facts": ["example"]}. Kella rides north.</think>\nHere is the extraction:\n{"facts":["Kella owns a red bicycle"]}',
    ),
  ).toEqual({ facts: ['Kella owns a red bicycle'] });
});

test('looseParseJson strips <thinking> and is case-insensitive about it', () => {
  expect(looseParseJson('<Thinking>maybe {"kind": "event"}?</thinking>{"kind":"place"}')).toEqual({
    kind: 'place',
  });
});

test('looseParseJson returns null when the think block held the only objects', () => {
  // The deliberation is scratchpad, not an answer; reading it back would file a musing as
  // a fact. The director may fall back to the original text for its selection — that is
  // its own policy, layered on this reader.
  expect(
    looseParseJson(
      '<think>Shaped like {"facts": ["example"]}</think>\nI could not extract anything.',
    ),
  ).toBe(null);
  expect(looseParseJson('<think>So: {"a":1}</think>')).toBe(null);
});

test('stripThinkBlocks removes closed blocks and keeps the rest', () => {
  expect(stripThinkBlocks('a<think>b</think>c')).toBe('a c');
  // Open-tag whitespace is allowed; the closing tag must be exact.
  expect(stripThinkBlocks('a<thinking >b</thinking>c')).toBe('a c');
  expect(stripThinkBlocks('no blocks here')).toBe('no blocks here');
});
