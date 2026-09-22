import { describe, expect, test } from 'bun:test';
import { describeJsonParseError, findJsonProblem, formatJsonProblem } from './jsonProblem.ts';

const text = '{\n    "temperature": 1,\n    "top_p" 0.9\n}';

describe('findJsonProblem', () => {
  test('accepts a JSON object', () => {
    expect(findJsonProblem('{"temperature": 1}')).toBeNull();
  });

  test('rejects JSON that parses to something other than an object', () => {
    for (const value of ['[]', 'null', '42', '"preset"']) {
      expect(findJsonProblem(value)?.message).toBe('A preset must be a JSON object.');
    }
  });

  test('reports a syntax error in whatever words the running engine uses', () => {
    const problem = findJsonProblem(text);
    expect(problem).not.toBeNull();
    expect(problem!.message.length).toBeGreaterThan(0);
  });
});

describe('describeJsonParseError', () => {
  test('newer V8: takes the line and column the message carries, and strips the tail', () => {
    const problem = describeJsonParseError(
      text,
      "Expected ':' after property name in JSON at position 36 (line 3 column 13)",
    );
    expect(problem).toEqual({
      message: "Expected ':' after property name",
      line: 3,
      column: 13,
    });
  });

  test('older V8: derives the line and column from the character position', () => {
    // Position 36 is the 0 of 0.9 on the third line.
    const problem = describeJsonParseError(text, 'Unexpected number in JSON at position 36');
    expect(problem).toEqual({ message: 'Unexpected number', line: 3, column: 13 });
  });

  test('Firefox: reads its "at line N column M of the JSON data" form', () => {
    const problem = describeJsonParseError(
      text,
      "JSON.parse: expected ':' after property name in object at line 3 column 13 of the JSON data",
    );
    expect(problem).toEqual({
      message: "Expected ':' after property name in object",
      line: 3,
      column: 13,
    });
  });

  test('end of input points past the last character', () => {
    const truncated = '{\n  "a": 1,';
    expect(describeJsonParseError(truncated, 'Unexpected end of JSON input')).toEqual({
      message: 'Unexpected end of JSON input',
      line: 2,
      column: 10,
    });
  });

  test('JavaScriptCore gives no location, so none is invented', () => {
    expect(describeJsonParseError(text, "JSON Parse error: Expected '}'")).toEqual({
      message: "Expected '}'",
      line: null,
      column: null,
    });
  });
});

test('formatJsonProblem leads with the location only when there is one', () => {
  expect(formatJsonProblem({ message: 'Unexpected number', line: 3, column: 13 })).toBe(
    'line 3, column 13 — Unexpected number',
  );
  expect(formatJsonProblem({ message: "Expected '}'", line: null, column: null })).toBe(
    "Expected '}'",
  );
});
