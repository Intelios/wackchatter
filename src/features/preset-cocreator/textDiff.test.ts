import { describe, expect, test } from 'bun:test';
import { type DiffPart, diffText, FOLD_CONTEXT_WORDS, foldParts, tokenize } from './textDiff.ts';

/** Both sides must rebuild exactly: "same + removed" is the old text, "same + added" the new. */
function sides(parts: readonly DiffPart[]) {
  return {
    before: parts
      .filter((part) => part.kind !== 'added')
      .map((part) => part.text)
      .join(''),
    after: parts
      .filter((part) => part.kind !== 'removed')
      .map((part) => part.text)
      .join(''),
  };
}

function words(count: number, tag = 'w') {
  return Array.from({ length: count }, (_, index) => `${tag}${index}`).join(' ');
}

describe('tokenize', () => {
  test('tokens always join back to the input', () => {
    const samples = [
      '',
      'plain words here',
      'Line one.\n\nLine two — with a dash, "quotes" and {{char}}.',
      "don't split contractions; café naïve 日本語 emoji 🙂 tabs\tend",
      '   leading and trailing   ',
    ];
    for (const sample of samples) expect(tokenize(sample).join('')).toBe(sample);
  });

  test('whitespace, words and punctuation are separate tokens', () => {
    expect(tokenize("It's {{char}}, ok.")).toEqual([
      "It's",
      ' ',
      '{',
      '{',
      'char',
      '}',
      '}',
      ',',
      ' ',
      'ok',
      '.',
    ]);
  });
});

describe('diffText', () => {
  test('a replaced word is one strike and one insert between untouched text', () => {
    const diff = diffText('the cat sat down', 'the dog sat down');
    expect(diff.mode).toBe('words');
    if (diff.mode !== 'words') return;
    expect(diff.parts).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'removed', text: 'cat' },
      { kind: 'added', text: 'dog' },
      { kind: 'same', text: ' sat down' },
    ]);
    expect(diff.addedWords).toBe(1);
    expect(diff.removedWords).toBe(1);
  });

  test('pure insertions and deletions at either end', () => {
    const inserted = diffText('keep this', 'keep this and more');
    expect(inserted.mode === 'words' && inserted.parts).toEqual([
      { kind: 'same', text: 'keep this' },
      { kind: 'added', text: ' and more' },
    ]);
    const deleted = diffText('drop this then keep', 'keep');
    expect(deleted.mode === 'words' && sides(deleted.parts)).toEqual({
      before: 'drop this then keep',
      after: 'keep',
    });
  });

  test('a tiny equality between two changes joins the change instead of splitting it', () => {
    const diff = diffText('alpha a omega', 'beta a gamma');
    expect(diff.mode === 'words' && diff.parts).toEqual([
      { kind: 'removed', text: 'alpha a omega' },
      { kind: 'added', text: 'beta a gamma' },
    ]);
  });

  test('both sides rebuild exactly, line breaks included', () => {
    const before = `${words(30)}\n\nReason briefly and once — never self-debate.\n${words(20, 'x')}`;
    const after = `${words(30)}\n\nReason briefly and once — no self-debate, no re-drafting.\n\n${words(20, 'x')}`;
    const diff = diffText(before, after);
    expect(diff.mode).toBe('words');
    if (diff.mode !== 'words') return;
    expect(sides(diff.parts)).toEqual({ before, after });
    expect(diff.parts.filter((part) => part.kind !== 'same').length).toBeLessThanOrEqual(4);
  });

  test('identical text is a single unchanged part', () => {
    const diff = diffText('same text', 'same text');
    expect(diff).toEqual({
      mode: 'words',
      parts: [{ kind: 'same', text: 'same text' }],
      addedWords: 0,
      removedWords: 0,
    });
  });

  test('mostly changed text falls back to before and after', () => {
    const diff = diffText(words(20, 'old'), words(20, 'new'));
    expect(diff.mode).toBe('rewritten');
    if (diff.mode !== 'rewritten') return;
    expect(diff.before).toBe(words(20, 'old'));
    expect(diff.after).toBe(words(20, 'new'));
  });

  test('short text is diffed however much of it changed', () => {
    expect(diffText('Main', 'Main Prompt V4').mode).toBe('words');
    expect(diffText('one two', 'three four').mode).toBe('words');
  });

  test('past the edit cap the diff gives up gracefully instead of exhausting memory', () => {
    expect(diffText(words(50, 'a'), words(50, 'b'), 10).mode).toBe('rewritten');
  });

  test('a 13,000-character prompt with a few local edits stays fast and exact', () => {
    const base = Array.from(
      { length: 250 },
      (_, index) => `Rule ${index}: ${words(8, `r${index}`)}.`,
    );
    const before = base.join('\n');
    const edited = [...base];
    edited[12] = 'Rule 12: rewritten entirely with new words.';
    edited[95] = `${edited[95]} Added clause here.`;
    edited.splice(150, 1);
    const after = edited.join('\n');
    expect(before.length).toBeGreaterThan(13_000);

    const started = performance.now();
    const diff = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(250);
    expect(diff.mode).toBe('words');
    if (diff.mode === 'words') expect(sides(diff.parts)).toEqual({ before, after });
  });
});

describe('foldParts', () => {
  test('a long unchanged middle folds, keeping context either side of each change', () => {
    const before = `start ${words(60, 'mid')} end`;
    const after = `begin ${words(60, 'mid')} finish`;
    const diff = diffText(before, after);
    if (diff.mode !== 'words') throw new Error('expected a word diff');
    const folded = foldParts(diff.parts);
    const fold = folded.find((part) => part.kind === 'fold');
    expect(fold?.kind === 'fold' && fold.words).toBe(60 - 2 * FOLD_CONTEXT_WORDS);
    // Nothing is lost: the fold carries its text, so the whole still rebuilds.
    expect(
      folded
        .filter((part) => part.kind !== 'added')
        .map((part) => part.text)
        .join(''),
    ).toBe(before);
  });

  test('leading and trailing context keep only the side next to the change', () => {
    const diff = diffText(`${words(40)} old`, `${words(40)} new`);
    if (diff.mode !== 'words') throw new Error('expected a word diff');
    const folded = foldParts(diff.parts);
    expect(folded[0]!.kind).toBe('fold');
    expect(folded[0]!.kind === 'fold' && folded[0]!.words).toBe(40 - FOLD_CONTEXT_WORDS);
  });

  test('a fold breaks at whitespace, never inside a macro or next to its punctuation', () => {
    const context = `${words(FOLD_CONTEXT_WORDS - 1)} {{user}}, ${words(30, 'm')}`;
    const diff = diffText(`old ${context} end`, `new ${context} end`);
    if (diff.mode !== 'words') throw new Error('expected a word diff');
    const folded = foldParts(diff.parts);
    const visible = folded.find((part) => part.kind === 'same')!;
    expect(visible.text.endsWith('{{user}},')).toBe(true);
  });

  test('a short stretch is left alone rather than folded to save a few words', () => {
    const diff = diffText(`one ${words(20)} two`, `uno ${words(20)} dos`);
    if (diff.mode !== 'words') throw new Error('expected a word diff');
    expect(foldParts(diff.parts).some((part) => part.kind === 'fold')).toBe(false);
  });
});
