import { describe, expect, test } from 'bun:test';
import { resolveDialogueColor } from './avatarColor.ts';

describe('resolveDialogueColor', () => {
  test('global and speaker off both disable colouring', () => {
    expect(resolveDialogueColor(false, '#abcdef', '#123456')).toEqual({
      active: false,
      color: null,
      gradient: null,
    });
    expect(resolveDialogueColor(true, null, '#123456')).toEqual({
      active: false,
      color: null,
      gradient: null,
    });
  });

  test('custom wins and missing override uses avatar or token fallback', () => {
    expect(resolveDialogueColor(true, '#abcdef', '#123456')).toEqual({
      active: true,
      color: '#abcdef',
      gradient: null,
    });
    expect(resolveDialogueColor(true, undefined, '#123456')).toEqual({
      active: true,
      color: '#123456',
      gradient: null,
    });
    expect(resolveDialogueColor(true, undefined, null)).toEqual({
      active: true,
      color: null,
      gradient: null,
    });
  });
});
