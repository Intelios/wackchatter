import { describe, expect, test } from 'bun:test';
import { addRow, headersToRows, removeRow, rowsToHeaders, updateRow } from './headers.ts';

function row(id: string, name: string, value: string) {
  return { id, name, value };
}

describe('headersToRows', () => {
  test('mirrors the record in order with unique ids', () => {
    const rows = headersToRows({ 'x-first': '1', 'x-second': '2' });
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ['x-first', '1'],
      ['x-second', '2'],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.every((r) => r.id.length > 0)).toBe(true);
  });

  test('undefined means no headers yet', () => {
    expect(headersToRows(undefined)).toEqual([]);
  });
});

describe('rowsToHeaders', () => {
  test('keeps filled rows and drops blank names', () => {
    expect(
      rowsToHeaders([row('a', 'X-Goog-Api-Key', '{{key}}'), row('b', '   ', 'ignored')]),
    ).toEqual({ 'X-Goog-Api-Key': '{{key}}' });
  });

  test('trims names and values', () => {
    expect(rowsToHeaders([row('a', '  x-key  ', '  value  ')])).toEqual({ 'x-key': 'value' });
  });

  test('a later duplicate name wins', () => {
    expect(rowsToHeaders([row('a', 'x-key', 'first'), row('b', 'x-key', 'second')])).toEqual({
      'x-key': 'second',
    });
  });

  test('an empty row list clears the record', () => {
    expect(rowsToHeaders([])).toEqual({});
  });
});

describe('row edits', () => {
  test('add appends a blank row', () => {
    const rows = addRow([row('a', 'x-key', 'v')], 'new');
    expect(rows).toEqual([row('a', 'x-key', 'v'), row('new', '', '')]);
  });

  test('update touches only its row', () => {
    const rows = updateRow([row('a', 'x-key', 'v'), row('b', 'x-other', 'w')], 'b', {
      value: 'new',
    });
    expect(rows).toEqual([row('a', 'x-key', 'v'), row('b', 'x-other', 'new')]);
  });

  test('remove drops only its row', () => {
    const rows = removeRow([row('a', 'x-key', 'v'), row('b', 'x-other', 'w')], 'a');
    expect(rows).toEqual([row('b', 'x-other', 'w')]);
  });
});
