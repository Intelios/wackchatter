import { describe, expect, test } from 'bun:test';
import { colorizeJson, prettyJson } from './log.ts';

const RESET = '\x1b[0m';
const KEY = '\x1b[36m';
const STRING = '\x1b[32m';
const NUMBER = '\x1b[33m';
const SPECIAL = '\x1b[35m';

describe('colorizeJson', () => {
  test('returns the input unchanged when colours are disabled', () => {
    const json = '{"a":1}';
    expect(colorizeJson(json, false)).toBe(json);
  });

  test('colours keys, strings, numbers and specials', () => {
    expect(colorizeJson('{"name":"Seraphina","age":1,"ok":true,"extra":null}', true)).toBe(
      `{${KEY}"name"${RESET}:${STRING}"Seraphina"${RESET},` +
        `${KEY}"age"${RESET}:${NUMBER}1${RESET},` +
        `${KEY}"ok"${RESET}:${SPECIAL}true${RESET},` +
        `${KEY}"extra"${RESET}:${SPECIAL}null${RESET}}`,
    );
  });

  test('a string value with digits and colons stays one string', () => {
    expect(colorizeJson('{"time":"12:30"}', true)).toBe(
      `{${KEY}"time"${RESET}:${STRING}"12:30"${RESET}}`,
    );
  });

  test('a numeric-looking key is still a key', () => {
    expect(colorizeJson('{"123":"x"}', true)).toBe(`{${KEY}"123"${RESET}:${STRING}"x"${RESET}}`);
  });

  test('escaped quotes stay inside their string', () => {
    expect(colorizeJson('{"a":"say \\"hi\\""}', true)).toBe(
      `{${KEY}"a"${RESET}:${STRING}"say \\"hi\\""${RESET}}`,
    );
  });

  test('negative and exponent numbers', () => {
    expect(colorizeJson('[-1.5,2e10,-3E-2]', true)).toBe(
      `[${NUMBER}-1.5${RESET},${NUMBER}2e10${RESET},${NUMBER}-3E-2${RESET}]`,
    );
  });

  test('pretty-printed input keeps its whitespace', () => {
    expect(colorizeJson('{\n  "a": 1\n}', true)).toBe(
      `{\n  ${KEY}"a"${RESET}: ${NUMBER}1${RESET}\n}`,
    );
  });
});

describe('prettyJson', () => {
  test('indents a valid document', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  test('returns unparseable input unchanged', () => {
    expect(prettyJson('not json')).toBe('not json');
  });
});
