import { describe, expect, test } from 'bun:test';
import { safeJoin, sanitizeFilename, uniqueName } from './paths.ts';

describe('sanitizeFilename', () => {
  test('keeps ordinary names, including spaces and hyphens', () => {
    expect(sanitizeFilename('Seraphina')).toBe('Seraphina');
    expect(sanitizeFilename('My Character - v2')).toBe('My Character - v2');
    expect(sanitizeFilename('日本語のキャラ')).toBe('日本語のキャラ');
  });

  test('strips control characters', () => {
    expect(sanitizeFilename('bad\x00name')).toBe('badname');
    expect(sanitizeFilename('tab\there')).toBe('tabhere');
    expect(sanitizeFilename('newline\nhere')).toBe('newlinehere');
    expect(sanitizeFilename('del\x7fchar')).toBe('delchar');
  });

  test('strips path-significant characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  test('drops leading dots so a traversal attempt cannot make a hidden file', () => {
    // Removing the separators from "../../etc/passwd" used to leave "....etcpasswd" —
    // safely inside the data directory, but invisible to `ls` and to a file browser.
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('..')).toBeNull();
  });

  test('rejects names that reduce to nothing or to a dot path', () => {
    expect(sanitizeFilename('')).toBeNull();
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename('.')).toBeNull();
    expect(sanitizeFilename('..')).toBeNull();
    expect(sanitizeFilename('/')).toBeNull();
  });

  test('rejects Windows reserved device names', () => {
    expect(sanitizeFilename('CON')).toBeNull();
    expect(sanitizeFilename('nul')).toBeNull();
    expect(sanitizeFilename('COM1')).toBeNull();
    expect(sanitizeFilename('console')).toBe('console'); // not reserved
  });

  test('drops trailing dots and spaces so "foo." cannot collide with "foo"', () => {
    expect(sanitizeFilename('foo.')).toBe('foo');
    expect(sanitizeFilename('foo   ')).toBe('foo');
    expect(sanitizeFilename('foo. . ')).toBe('foo');
  });

  test('caps length', () => {
    expect(sanitizeFilename('a'.repeat(500))?.length).toBe(200);
  });
});

describe('safeJoin', () => {
  const base = '/tmp/wc-test/characters';

  test('joins an ordinary name', () => {
    expect(safeJoin(base, 'Seraphina.png')).toBe('/tmp/wc-test/characters/Seraphina.png');
  });

  test('refuses to escape the base directory', () => {
    // Separators and leading dots are both stripped, so traversal lands on an ordinary
    // visible name inside the base rather than climbing out or going hidden.
    expect(safeJoin(base, '../../../etc/passwd')).toBe('/tmp/wc-test/characters/etcpasswd');
    expect(safeJoin(base, '..')).toBeNull();
    expect(safeJoin(base, '/etc/passwd')).toBe('/tmp/wc-test/characters/etcpasswd');
  });

  test('returns null for unusable names', () => {
    expect(safeJoin(base, '')).toBeNull();
    expect(safeJoin(base, '   ')).toBeNull();
  });
});

describe('uniqueName', () => {
  test('returns the base when free', () => {
    expect(uniqueName('Seraphina', () => false)).toBe('Seraphina');
  });

  test('appends an index with no separator, matching SillyTavern', () => {
    const taken = new Set(['Seraphina', 'Seraphina1', 'Seraphina2']);
    expect(uniqueName('Seraphina', (c) => taken.has(c))).toBe('Seraphina3');
  });
});
