import { describe, expect, test } from 'bun:test';
import { readScenarioNotes } from './creatorNotes.ts';

/** The shape the convention actually appears in: a header, then one bare line per greeting. */
const MIKA = `Mika, standalone ver from Talia & Mika and also alternate universe.

Scenarios:
user is transfer student, mika introduces self to user
user & mika are dating, she is keeping it private
user is a photographer for Sophia and Mika overhears her
Mika has had a negative article about her and she's hiding`;

describe('reading a scenario list out of creator notes', () => {
  test('a headed run of one line per greeting maps, and the header goes with the intro', () => {
    const notes = readScenarioNotes(MIKA, 4);

    expect(notes.scenarios).toHaveLength(4);
    expect(notes.scenarios[0]).toBe('user is transfer student, mika introduces self to user');
    expect(notes.scenarios[3]).toBe("Mika has had a negative article about her and she's hiding");
    expect(notes.intro).toContain('standalone ver');
    expect(notes.intro).toContain('Scenarios:');
  });

  test('markers come off, so a bulleted list reads the same as a bare one', () => {
    const notes = readScenarioNotes('- first\n* second\n3. third\n4) fourth', 4);

    expect(notes.scenarios).toEqual(['first', 'second', 'third', 'fourth']);
  });

  test('text below the list is kept, not swallowed', () => {
    const notes = readScenarioNotes('Intro.\n\none\ntwo\n\nWritten for a 32k context.', 2);

    expect(notes.intro).toBe('Intro.');
    expect(notes.scenarios).toEqual(['one', 'two']);
    expect(notes.outro).toBe('Written for a 32k context.');
  });

  test('a list that starts at the top leaves no intro', () => {
    const notes = readScenarioNotes('one\ntwo\nthree', 3);

    expect(notes.intro).toBe('');
    expect(notes.scenarios).toEqual(['one', 'two', 'three']);
  });

  /*
   * The whole point of the count check. Notes that merely happen to be four paragraphs long
   * are not a scenario list, and highlighting the third paragraph because you swiped to
   * greeting three would be a confident lie.
   */
  test('a run of the wrong length does not map', () => {
    const notes = readScenarioNotes('one\ntwo\nthree', 10);

    expect(notes.scenarios).toEqual([]);
    expect(notes.intro).toBe('one\ntwo\nthree');
  });

  test('prose is left whole', () => {
    const prose = 'A slow-burn card. Give it a long context and it will pay off.';

    expect(readScenarioNotes(prose, 4).scenarios).toEqual([]);
    expect(readScenarioNotes(prose, 4).intro).toBe(prose);
  });

  test('a card with one greeting never maps — every run of one would qualify', () => {
    expect(readScenarioNotes('Just the one.', 1).scenarios).toEqual([]);
  });

  test('empty notes stay empty', () => {
    expect(readScenarioNotes('   \n\n', 4)).toEqual({ intro: '', scenarios: [], outro: '' });
  });

  test('the first qualifying run wins, later prose cannot steal it', () => {
    const notes = readScenarioNotes('one\ntwo\n\nlater\nlines', 2);

    expect(notes.scenarios).toEqual(['one', 'two']);
    expect(notes.outro).toBe('later\nlines');
  });

  test('a header alone is not mistaken for a list entry', () => {
    // Five lines, four greetings: only stripping the header makes the count work.
    const notes = readScenarioNotes('Greetings:\na\nb\nc\nd', 4);

    expect(notes.scenarios).toEqual(['a', 'b', 'c', 'd']);
    expect(notes.intro).toBe('Greetings:');
  });

  test('a run one too long without a header does not map', () => {
    const notes = readScenarioNotes('a\nb\nc\nd\ne', 4);

    expect(notes.scenarios).toEqual([]);
  });

  test('CRLF notes map the same as LF ones', () => {
    const notes = readScenarioNotes('Scenarios:\r\none\r\ntwo', 2);

    expect(notes.scenarios).toEqual(['one', 'two']);
  });
});
