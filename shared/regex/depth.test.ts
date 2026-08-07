import { describe, expect, test } from 'bun:test';
import { type DepthCandidate, regexDepths } from './depth.ts';

function message(id: string, mes: string, is_system = false): DepthCandidate {
  return { id, mes, is_system };
}

describe('regexDepths', () => {
  test('counts back from the end, newest at 0', () => {
    const depths = regexDepths([message('a', 'one'), message('b', 'two'), message('c', 'three')]);
    expect(depths.get('c')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('a')).toBe(2);
  });

  test('the blank generation placeholder holds no slot', () => {
    // Otherwise every real message sits one deeper than SillyTavern puts it, and a script
    // shared between the two apps would target the wrong turn.
    const depths = regexDepths([message('a', 'one'), message('b', 'two'), message('c', '')]);
    expect(depths.has('c')).toBe(false);
    expect(depths.get('b')).toBe(0);
    expect(depths.get('a')).toBe(1);
  });

  test('a whitespace-only message counts as blank', () => {
    const depths = regexDepths([message('a', 'one'), message('b', '   \n ')]);
    expect(depths.has('b')).toBe(false);
    expect(depths.get('a')).toBe(0);
  });

  test('a hidden message holds no slot and is absent, so gating is skipped for it', () => {
    const depths = regexDepths([
      message('a', 'one'),
      message('b', 'two', true),
      message('c', 'three'),
    ]);
    expect(depths.has('b')).toBe(false);
    expect(depths.get('c')).toBe(0);
    expect(depths.get('a')).toBe(1);
  });

  test('a continuation puts the message being extended at -1', () => {
    const depths = regexDepths([message('a', 'one'), message('b', 'two')], { continued: true });
    expect(depths.get('b')).toBe(-1);
    expect(depths.get('a')).toBe(0);
  });

  test('an empty transcript yields an empty map', () => {
    expect(regexDepths([]).size).toBe(0);
  });
});
