import { describe, expect, test } from 'bun:test';
import { EXAMPLE_CUE_GROUPS } from './exampleCues.ts';

/**
 * These are shipped data, not user input, so the invariants are about keeping the library
 * honest as it is edited: every rule below is a way a well-meant edit silently breaks the
 * picker or the rounds it feeds.
 */

const ANY_MACRO = /\{\{[^{}]*\}\}/g;

/** `{{char}}` and `{{user}}` resolve per card at assembly time; anything else is a typo. */
const EXPANDABLE = ['{{char}}', '{{user}}'];

const texts = EXAMPLE_CUE_GROUPS.flatMap((group) => group.cues);

describe('example cues', () => {
  test('every cue is non-blank — an empty example is a dead button', () => {
    for (const text of texts) expect(text.trim().length).toBeGreaterThan(0);
  });

  test('no cue appears twice — duplicates pad the pool and break the picker’s keys', () => {
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('every macro used is one the assembler expands', () => {
    for (const text of texts) {
      const found = text.match(ANY_MACRO) ?? [];
      for (const macro of found) {
        expect(EXPANDABLE).toContain(macro);
      }
    }
  });

  test('speech is quoted, action is asterisked — the format the cards themselves use', () => {
    /*
     * Strip the action spans; whatever is left is either nothing (a pure-action cue) or it
     * is speech, and speech must sit inside double quotes. Unquoted speech reads as
     * narration, and the model answers a different cue than the one written.
     */
    const ACTION = /\*[^*]*\*/g;
    for (const text of texts) {
      const speech = text.replace(ACTION, '').trim();
      expect(speech === '' || /^".*"$/u.test(speech)).toBe(true);
    }
  });

  test('every group is labelled, noted, and holds more than one cue', () => {
    for (const group of EXAMPLE_CUE_GROUPS) {
      expect(group.label.trim().length).toBeGreaterThan(0);
      expect(group.note.trim().length).toBeGreaterThan(0);
      expect(group.cues.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('the library is deep enough to stock a pool', () => {
    expect(EXAMPLE_CUE_GROUPS.length).toBeGreaterThanOrEqual(5);
    expect(texts.length).toBeGreaterThanOrEqual(12);
  });
});
