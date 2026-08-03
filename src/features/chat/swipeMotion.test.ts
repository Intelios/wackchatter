import { describe, expect, test } from 'bun:test';
import { type SwipeMotionSnapshot, resolveSwipeMotion } from './swipeMotion.ts';

function snap(overrides: Partial<SwipeMotionSnapshot> = {}): SwipeMotionSnapshot {
  return {
    swipeId: 2,
    streaming: false,
    mode: null,
    prevSwipeId: 2,
    prevStreaming: false,
    ...overrides,
  };
}

describe('resolveSwipeMotion', () => {
  test('a cached next swipe enters from the right', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 3 }))).toBe('next');
  });

  test('a cached previous swipe enters from the left', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 1 }))).toBe('prev');
  });

  test('an idle re-render animates nothing', () => {
    expect(resolveSwipeMotion(snap())).toBeNull();
  });

  test('loading a chat animates nothing', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 0, prevSwipeId: 0 }))).toBeNull();
  });

  test('a plain send placeholder animates nothing', () => {
    expect(
      resolveSwipeMotion(snap({ swipeId: 0, prevSwipeId: 0, streaming: true, mode: 'send' })),
    ).toBeNull();
  });

  test('an overswipe streams its blank alternate in from the right', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 3, streaming: true, mode: 'swipe' }))).toBe('next');
  });

  test('a regenerate placeholder enters from the right', () => {
    expect(
      resolveSwipeMotion(snap({ swipeId: 0, prevSwipeId: 0, streaming: true, mode: 'regenerate' })),
    ).toBe('next');
  });

  test('a guided swipe animates like an overswipe', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 3, streaming: true, mode: 'swipe' }))).toBe('next');
  });

  test('continue extends in place and animates nothing', () => {
    expect(resolveSwipeMotion(snap({ streaming: true, mode: 'continue' }))).toBeNull();
  });

  test('stream ticks animate nothing', () => {
    expect(
      resolveSwipeMotion(snap({ streaming: true, prevStreaming: true, mode: 'swipe' })),
    ).toBeNull();
  });

  test('settling an overswipe animates nothing', () => {
    expect(
      resolveSwipeMotion(snap({ streaming: false, prevStreaming: true, mode: null })),
    ).toBeNull();
  });

  test('settling a regenerate animates nothing', () => {
    expect(
      resolveSwipeMotion(snap({ swipeId: 0, prevSwipeId: 0, prevStreaming: true })),
    ).toBeNull();
  });

  test('a failed overswipe revert reads as a swipe back', () => {
    expect(resolveSwipeMotion(snap({ swipeId: 2, prevSwipeId: 3 }))).toBe('prev');
  });
});
