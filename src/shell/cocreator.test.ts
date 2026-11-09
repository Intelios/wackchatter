import { describe, expect, test } from 'bun:test';
import { emptyStash } from '@shared/cocreator/stash.ts';
import type { CardStash } from '@shared/types/cocreator.ts';
import { cardFields, filledCount, wordDiff } from './cocreator.ts';

const at = { messageId: 'm', swipeIndex: 0, at: '', source: 'block' as const };
const entry = (text: string) => ({ id: text, text, provenance: at });

describe('the card so far', () => {
  test('nine fields, counted as they are written', () => {
    const stash: CardStash = {
      ...emptyStash(),
      name: entry('Hana'),
      description: entry('A barista.'),
      tags: [entry('OC')],
    };
    expect(filledCount(stash)).toBe(3);
    expect(cardFields(stash).map((f) => f.slot)).toHaveLength(9);
  });

  test('blank text is not written', () => {
    expect(filledCount({ ...emptyStash(), description: entry('  ') })).toBe(0);
  });

  test('the prompt fields join only once written', () => {
    const fields = cardFields({ ...emptyStash(), system_prompt: entry('Stay in character.') });
    expect(fields.map((f) => f.slot)).toContain('system_prompt');
    expect(fields.map((f) => f.slot)).not.toContain('post_history_instructions');
  });
});

describe('word diff', () => {
  const join = (parts: { text: string }[]) => parts.map((p) => p.text).join('');

  test('joining the parts gives each text back exactly', () => {
    const a = 'She cuts her hair herself.\nGrey eyes.';
    const b = 'She trims her hair over the sink.\nGrey eyes.';
    const diff = wordDiff(a, b);
    expect(join(diff.before)).toBe(a);
    expect(join(diff.after)).toBe(b);
  });

  test('only the words that differ are marked', () => {
    const diff = wordDiff('The cat sat on the mat.', 'The cat sat on the old mat.');
    expect(diff.before.filter((p) => p.changed)).toEqual([]);
    expect(diff.after.filter((p) => p.changed).map((p) => p.text.trim())).toEqual(['old']);
  });

  test('a removal is marked on the side it left', () => {
    const diff = wordDiff('a quiet loud girl', 'a quiet girl');
    expect(diff.before.filter((p) => p.changed).map((p) => p.text.trim())).toEqual(['loud']);
  });

  test('identical texts have nothing marked', () => {
    const diff = wordDiff('Same words.', 'Same words.');
    expect([...diff.before, ...diff.after].some((p) => p.changed)).toBe(false);
  });
});
