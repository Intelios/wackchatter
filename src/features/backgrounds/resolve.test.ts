import { describe, expect, test } from 'bun:test';
import { pairBackgroundEffect, resolveBackgroundEffect } from './resolve.ts';

describe('resolveBackgroundEffect', () => {
  test('the master switch off means nothing, even with a pairing present', () => {
    expect(
      resolveBackgroundEffect({
        backgroundEffectEnabled: false,
        background: 'builtin:stormy-lighthouse',
        backgroundEffects: { 'builtin:stormy-lighthouse': 'rain' },
      }),
    ).toBeNull();
  });

  test('no background, no effect — a pairing alone animates nothing', () => {
    expect(
      resolveBackgroundEffect({ background: null, backgroundEffects: { 'builtin:x': 'rain' } }),
    ).toBeNull();
    expect(resolveBackgroundEffect({})).toBeNull();
  });

  test('an unpaired background resolves to nothing', () => {
    expect(resolveBackgroundEffect({ background: 'builtin:stargazer' })).toBeNull();
  });

  test('a missing or malformed map resolves to nothing', () => {
    expect(
      resolveBackgroundEffect({ background: 'builtin:stargazer', backgroundEffects: null }),
    ).toBeNull();
    expect(
      resolveBackgroundEffect({ background: 'builtin:stargazer', backgroundEffects: 'rain' }),
    ).toBeNull();
  });

  test('builtin and user backgrounds both resolve through their stored strings', () => {
    expect(
      resolveBackgroundEffect({
        background: 'builtin:stormy-lighthouse',
        backgroundEffects: { 'builtin:stormy-lighthouse': 'rain' },
      }),
    ).toBe('rain');
    expect(
      resolveBackgroundEffect({
        background: 'user:tavern day.jpg',
        backgroundEffects: { 'user:tavern day.jpg': 'leaves' },
      }),
    ).toBe('leaves');
  });

  test('an id the catalog no longer knows degrades to nothing, not an error', () => {
    // The deleted-upload rule: a stale pairing (renamed effect, older build) must read
    // as "no effect", never surface as a broken layer.
    expect(
      resolveBackgroundEffect({
        background: 'builtin:stargazer',
        backgroundEffects: { 'builtin:stargazer': 'fog' },
      }),
    ).toBeNull();
  });
});

describe('pairBackgroundEffect', () => {
  test('setting a pairing leaves the other backgrounds alone', () => {
    const map = { 'builtin:stargazer': 'dust' };
    expect(pairBackgroundEffect(map, 'builtin:neon-alley', 'rain')).toEqual({
      'builtin:stargazer': 'dust',
      'builtin:neon-alley': 'rain',
    });
    // And the input is not mutated — the patch is built, not edited in place.
    expect(map).toEqual({ 'builtin:stargazer': 'dust' });
  });

  test('clearing removes the key rather than blanking it, and is a no-op when absent', () => {
    const map = { 'builtin:stargazer': 'dust', 'user:x.png': 'embers' };
    expect(pairBackgroundEffect(map, 'builtin:stargazer', null)).toEqual({
      'user:x.png': 'embers',
    });
    expect(pairBackgroundEffect(map, 'builtin:absent', null)).toEqual(map);
  });
});
