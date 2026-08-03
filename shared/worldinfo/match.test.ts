import { describe, expect, test } from 'bun:test';
import { WI_LOGIC } from '../types/worldinfo.ts';
import { splitKeys } from './keys.ts';
import {
  createRegexCache,
  evaluateSecondary,
  type MatchSettings,
  matchAny,
  matchKey,
  matchSettingsFor,
  parseRegexLiteral,
} from './match.ts';

const LOOSE: MatchSettings = { caseSensitive: false, matchWholeWords: false };
const WHOLE: MatchSettings = { caseSensitive: false, matchWholeWords: true };
const EXACT: MatchSettings = { caseSensitive: true, matchWholeWords: true };

describe('parseRegexLiteral', () => {
  test('parses a literal with flags', () => {
    const regex = parseRegexLiteral('/dragon(s)?/i');
    expect(regex).not.toBeNull();
    expect(regex?.source).toBe('dragon(s)?');
    expect(regex?.flags).toContain('i');
  });

  test('rejects anything that is not a literal', () => {
    expect(parseRegexLiteral('dragon')).toBeNull();
    expect(parseRegexLiteral('/unterminated')).toBeNull();
    expect(parseRegexLiteral('//')).toBeNull();
    expect(parseRegexLiteral('/bad(/')).toBeNull();
  });

  test('rejects a literal with an unescaped slash in the body', () => {
    // Legal to JS, but not a well-formed literal to any other engine, so ST refuses it.
    expect(parseRegexLiteral('/and/or/i')).toBeNull();
    // Escaped is fine.
    expect(parseRegexLiteral('/and\\/or/i')).not.toBeNull();
  });

  test('rejects an unsupported flag rather than throwing', () => {
    expect(parseRegexLiteral('/x/z')).toBeNull();
  });

  test('strips g and y so a cached regex is not stateful', () => {
    const regex = parseRegexLiteral('/cat/g');
    expect(regex?.flags).not.toContain('g');

    // The whole point: .test() on a /g regex advances lastIndex, so the second call
    // against the same instance would return false. Reusing a cached regex must not do
    // that — this is the difference between us and ST, which recompiles every call.
    expect(regex?.test('cat cat')).toBe(true);
    expect(regex?.test('cat cat')).toBe(true);
    expect(regex?.test('cat cat')).toBe(true);
  });

  test('a cached regex key still matches on the second pass', () => {
    const cache = createRegexCache();
    expect(matchKey('a cat here', '/cat/g', LOOSE, cache)).toBe(true);
    expect(matchKey('a cat here', '/cat/g', LOOSE, cache)).toBe(true);
  });
});

describe('matchKey', () => {
  test('a regex key overrides case sensitivity and whole words', () => {
    // EXACT would normally reject both a case mismatch and a partial word.
    expect(matchKey('the DRAGONFLY sat', '/dragon/i', EXACT)).toBe(true);
    // And it tests the raw haystack, not the case-folded one.
    expect(matchKey('the DRAGONFLY sat', '/DRAGON/', EXACT)).toBe(true);
    expect(matchKey('the dragonfly sat', '/DRAGON/', LOOSE)).toBe(false);
  });

  test('whole-word matching respects word boundaries', () => {
    expect(matchKey('\x01a red dragon flew', 'dragon', WHOLE)).toBe(true);
    expect(matchKey('\x01a dragonfly flew', 'dragon', WHOLE)).toBe(false);
  });

  test('punctuation counts as a word boundary', () => {
    expect(matchKey('\x01a dragon, flying', 'dragon', WHOLE)).toBe(true);
    expect(matchKey('\x01"dragon"', 'dragon', WHOLE)).toBe(true);
  });

  test('the \\x01 sentinel is a boundary, so a key at the head of a message matches', () => {
    expect(matchKey('\x01dragon flew', 'dragon', WHOLE)).toBe(true);
  });

  test('QUIRK: a multi-word key silently falls back to a substring test', () => {
    // ST splits the key on whitespace and abandons whole-word matching entirely when it
    // finds more than one word (world-info.js:349). Replicated on purpose: books were
    // authored against it. Do not "fix" this without a compatibility discussion.
    expect(matchKey('bored dragonfly', 'red dragon', WHOLE)).toBe(true);
    // The single-word equivalent correctly does not match.
    expect(matchKey('\x01bored dragonfly', 'dragon', WHOLE)).toBe(false);
  });

  test('QUIRK: non-Latin keys effectively lose whole-word matching', () => {
    // The boundary regex uses \W with no `u` flag, so every Cyrillic letter is itself a
    // "non-word" character and therefore a boundary. Replicated on purpose.
    expect(matchKey('\x01приветствие', 'привет', WHOLE)).toBe(true);
    // The Latin equivalent behaves as you would expect.
    expect(matchKey('\x01greetings', 'greet', WHOLE)).toBe(false);
  });

  test('case sensitivity is honoured for plain keys', () => {
    expect(matchKey('\x01a Dragon', 'dragon', WHOLE)).toBe(true);
    expect(matchKey('\x01a Dragon', 'dragon', EXACT)).toBe(false);
    expect(matchKey('\x01a Dragon', 'Dragon', EXACT)).toBe(true);
  });

  test('a blank key never matches', () => {
    expect(matchKey('anything at all', '', LOOSE)).toBe(false);
    expect(matchKey('anything at all', '   ', LOOSE)).toBe(false);
  });

  test('keys are trimmed before matching', () => {
    expect(matchKey('\x01a dragon flew', '  dragon  ', WHOLE)).toBe(true);
  });

  test('regex metacharacters in a plain key are escaped, not interpreted', () => {
    expect(matchKey('\x01cost is 3+4', '3+4', WHOLE)).toBe(true);
    expect(matchKey('\x01cost is 34', '3+4', WHOLE)).toBe(false);
  });
});

describe('matchAny', () => {
  test('is true when any key hits and false for an empty list', () => {
    expect(matchAny('\x01a dragon', ['castle', 'dragon'], WHOLE)).toBe(true);
    expect(matchAny('\x01a dragon', ['castle', 'moat'], WHOLE)).toBe(false);
    expect(matchAny('\x01a dragon', [], WHOLE)).toBe(false);
  });
});

describe('matchSettingsFor', () => {
  test('null means inherit, false means override', () => {
    const globals: MatchSettings = { caseSensitive: false, matchWholeWords: true };

    expect(matchSettingsFor({ caseSensitive: null, matchWholeWords: null }, globals)).toEqual(
      globals,
    );
    // false is a real value, not an absence — this is why the fields are `T | null`.
    expect(matchSettingsFor({ caseSensitive: true, matchWholeWords: false }, globals)).toEqual({
      caseSensitive: true,
      matchWholeWords: false,
    });
  });
});

describe('evaluateSecondary', () => {
  const haystack = '\x01the knight rode at night';

  test('AND_ANY needs at least one secondary present', () => {
    expect(evaluateSecondary(haystack, ['night', 'dawn'], WI_LOGIC.AND_ANY, WHOLE)).toBe(true);
    expect(evaluateSecondary(haystack, ['dawn', 'noon'], WI_LOGIC.AND_ANY, WHOLE)).toBe(false);
  });

  test('AND_ALL needs every secondary present', () => {
    expect(evaluateSecondary(haystack, ['knight', 'night'], WI_LOGIC.AND_ALL, WHOLE)).toBe(true);
    expect(evaluateSecondary(haystack, ['knight', 'dawn'], WI_LOGIC.AND_ALL, WHOLE)).toBe(false);
  });

  test('NOT_ANY needs no secondary present', () => {
    expect(evaluateSecondary(haystack, ['dawn', 'noon'], WI_LOGIC.NOT_ANY, WHOLE)).toBe(true);
    expect(evaluateSecondary(haystack, ['dawn', 'night'], WI_LOGIC.NOT_ANY, WHOLE)).toBe(false);
  });

  test('NOT_ALL needs at least one secondary missing', () => {
    expect(evaluateSecondary(haystack, ['knight', 'dawn'], WI_LOGIC.NOT_ALL, WHOLE)).toBe(true);
    expect(evaluateSecondary(haystack, ['knight', 'night'], WI_LOGIC.NOT_ALL, WHOLE)).toBe(false);
  });

  test('an empty secondary list is no restriction, whatever the logic', () => {
    for (const logic of Object.values(WI_LOGIC)) {
      expect(evaluateSecondary(haystack, [], logic, WHOLE)).toBe(true);
    }
  });
});

describe('splitKeys', () => {
  test('splits a plain comma list and trims', () => {
    expect(splitKeys('castle, dragon ,moat')).toEqual(['castle', 'dragon', 'moat']);
  });

  test('does not shred a regex literal containing commas', () => {
    // The whole reason this is not TagField.
    expect(splitKeys('/foo,bar/i, castle')).toEqual(['/foo,bar/i', 'castle']);
    expect(splitKeys('/a{1,3}/')).toEqual(['/a{1,3}/']);
  });

  test('a mid-key slash does not open a literal', () => {
    expect(splitKeys('and/or, castle')).toEqual(['and/or', 'castle']);
  });

  test('handles an escaped slash inside a literal', () => {
    expect(splitKeys('/a\\/b,c/i, next')).toEqual(['/a\\/b,c/i', 'next']);
  });

  test('drops empty segments', () => {
    expect(splitKeys('')).toEqual([]);
    expect(splitKeys(' , , ')).toEqual([]);
    expect(splitKeys('castle,,dragon')).toEqual(['castle', 'dragon']);
  });

  test('what it produces still parses as the same keys', () => {
    const line = '/foo,bar/i, castle, and/or, /a{1,3}/';
    const keys = splitKeys(line);
    expect(splitKeys(keys.join(', '))).toEqual(keys);
    // And the regex ones are still regexes.
    expect(parseRegexLiteral(keys[0]!)).not.toBeNull();
  });
});
