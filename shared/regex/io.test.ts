import { describe, expect, test } from 'bun:test';
import { REGEX_SUBSTITUTE } from '../types/regex.ts';
import {
  normalizeRegexScript,
  parseRegexScriptFile,
  regexScriptFilename,
  serializeRegexScript,
} from './io.ts';

/** `regex-usercharhide.json` from ExtensionsForSillyTavernSource, verbatim. */
const ST_FILE = {
  id: 'f535620c-808b-45b9-81f2-47435ff6b161',
  scriptName: 'usercharhide',
  findRegex: '^\\[({{char}}|{{user}})\\]:\\s?',
  replaceString: '',
  trimStrings: [],
  placement: [1, 2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 1,
  minDepth: null,
  maxDepth: null,
};

let counter = 0;
const mintId = () => `minted-${++counter}`;

describe('parseRegexScriptFile', () => {
  test('reads a single exported script', () => {
    const scripts = parseRegexScriptFile(ST_FILE, mintId);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.scriptName).toBe('usercharhide');
    expect(scripts[0]?.substituteRegex).toBe(REGEX_SUBSTITUTE.RAW);
    expect(scripts[0]?.placement).toEqual([1, 2]);
  });

  test('reads a bulk export array', () => {
    expect(parseRegexScriptFile([ST_FILE, ST_FILE], mintId)).toHaveLength(2);
  });

  test('always mints a fresh id, so two people exports cannot collide', () => {
    const [first] = parseRegexScriptFile(ST_FILE, mintId);
    const [second] = parseRegexScriptFile(ST_FILE, mintId);
    expect(first?.id).not.toBe(ST_FILE.id);
    expect(first?.id).not.toBe(second?.id);
  });

  test('rejects JSON that is not a regex script', () => {
    // scriptName is ST's own import check and the only field that distinguishes one.
    expect(parseRegexScriptFile({ name: 'a lorebook' }, mintId)).toEqual([]);
    expect(parseRegexScriptFile({ scriptName: '  ' }, mintId)).toEqual([]);
    expect(parseRegexScriptFile('nonsense', mintId)).toEqual([]);
    expect(parseRegexScriptFile(null, mintId)).toEqual([]);
  });
});

describe('normalizeRegexScript', () => {
  test('never rejects, so a script mid-edit survives its own autosave', () => {
    const script = normalizeRegexScript({}, 'id');
    expect(script.scriptName).toBe('');
    expect(script.placement).toEqual([]);
    expect(script.trimStrings).toEqual([]);
  });

  test('stores an uncompilable pattern verbatim', () => {
    // Anything else deletes the user work as they type `/[`.
    expect(normalizeRegexScript({ findRegex: '/[unclosed/' }, 'id').findRegex).toBe('/[unclosed/');
  });

  test('keeps a placement value we do not implement', () => {
    expect(normalizeRegexScript({ placement: [1, 4, 'x'] }, 'id').placement).toEqual([1, 4]);
  });

  test('NaN and null depths both mean unlimited', () => {
    // ST holds a blank box as NaN and JSON.stringify writes it as null, so both shapes
    // reach us from the wild.
    expect(
      normalizeRegexScript({ minDepth: Number.NaN, maxDepth: null }, 'id').minDepth,
    ).toBeNull();
    expect(normalizeRegexScript({ minDepth: 0 }, 'id').minDepth).toBe(0);
    expect(normalizeRegexScript({ maxDepth: -1 }, 'id').maxDepth).toBe(-1);
  });

  test('an unknown substitute mode falls back to leaving macros literal', () => {
    expect(normalizeRegexScript({ substituteRegex: 9 }, 'id').substituteRegex).toBe(
      REGEX_SUBSTITUTE.NONE,
    );
  });

  test('runOnEdit defaults to true, matching ST new-script state', () => {
    expect(normalizeRegexScript({}, 'id').runOnEdit).toBe(true);
  });
});

describe('serializeRegexScript', () => {
  test('round-trips a SillyTavern file byte for byte', () => {
    const normalized = normalizeRegexScript(ST_FILE, ST_FILE.id);
    expect(serializeRegexScript(normalized)).toBe(JSON.stringify(ST_FILE, null, 4));
  });

  test('writes ST thirteen keys in ST order', () => {
    const keys = Object.keys(JSON.parse(serializeRegexScript(normalizeRegexScript({}, 'id'))));
    expect(keys).toEqual([
      'id',
      'scriptName',
      'findRegex',
      'replaceString',
      'trimStrings',
      'placement',
      'disabled',
      'markdownOnly',
      'promptOnly',
      'runOnEdit',
      'substituteRegex',
      'minDepth',
      'maxDepth',
    ]);
  });
});

describe('regexScriptFilename', () => {
  test('matches ST naming, hyphens included', () => {
    expect(regexScriptFilename(normalizeRegexScript({ scriptName: 'usercharhide' }, 'id'))).toBe(
      'regex-usercharhide.json',
    );
  });

  test('replaces whitespace and path characters', () => {
    expect(regexScriptFilename(normalizeRegexScript({ scriptName: 'My Script/v2' }, 'id'))).toBe(
      'regex-my_script_v2.json',
    );
  });

  test('an unnamed script still gets a usable filename', () => {
    expect(regexScriptFilename(normalizeRegexScript({}, 'id'))).toBe('regex-script.json');
  });
});
