import { describe, expect, test } from 'bun:test';
import { findMacro } from '@shared/prompt/macroCatalog.ts';
import { macroCompletion, macroInsertion } from './macroCompletion.ts';

/** The caret sits where the `|` is; the marker is removed before the call. */
function at(marked: string) {
  const caret = marked.indexOf('|');
  return macroCompletion(marked.replace('|', ''), caret);
}

describe('when the box opens', () => {
  test('opens on the braces and narrows as the name is typed', () => {
    expect(at('{{|')?.query).toBe('');
    expect(at('{{r|')?.query).toBe('r');
    expect(at('{{ro|')?.suggestions[0]?.name).toBe('roll');
  });

  test('opens mid-sentence, on the nearest opener', () => {
    expect(at('I greet {{char}} and then {{us|')?.query).toBe('us');
  });

  test('is not open in ordinary text', () => {
    expect(at('hello|')).toBeNull();
    expect(at('a single { brace|')).toBeNull();
  });
});

describe('when the box closes', () => {
  // The name is settled; a listbox over the transcript while somebody writes 2d6 is noise.
  test('closes once arguments begin', () => {
    expect(at('{{roll:|')).toBeNull();
    expect(at('{{roll::1d|')).toBeNull();
    expect(at('{{random a|')).toBeNull();
  });

  test('closes on a finished macro', () => {
    expect(at('{{char}}|')).toBeNull();
    expect(at('{{char}} said|')).toBeNull();
  });

  test('a macro is one line, so a newline ends the context', () => {
    expect(at('{{ro\n|')).toBeNull();
  });

  test('a name matching nothing offers nothing rather than an empty box', () => {
    expect(at('{{zzzz|')).toBeNull();
  });

  test('the caret behind the braces is not inside them', () => {
    expect(at('|{{ro')).toBeNull();
  });
});

describe('accepting a suggestion', () => {
  test('completes a plain macro and leaves the caret after it', () => {
    const completion = at('I greet {{ch|')!;
    const result = macroInsertion('I greet {{ch', completion, findMacro('char')!);
    expect(result.text).toBe('I greet {{char}}');
    expect(result.caret).toBe(result.text.length);
  });

  /*
   * A skeleton rather than the documented example: `{{roll::1d20}}` would leave a sample
   * somebody has to notice and delete before typing their own formula.
   */
  test('an argument-taking macro lands the caret inside the arguments', () => {
    const completion = at('{{ro|')!;
    const result = macroInsertion('{{ro', completion, findMacro('roll')!);
    expect(result.text).toBe('{{roll::}}');
    expect(result.caret).toBe('{{roll::'.length);
  });

  test('keeps whatever followed the caret', () => {
    const text = '{{ch and {{user}}';
    const completion = macroCompletion(text, 4)!;
    const result = macroInsertion(text, completion, findMacro('char')!);
    expect(result.text).toBe('{{char}} and {{user}}');
  });

  test('a leading space inside the braces is replaced, not left behind', () => {
    const text = '{{ ch';
    const completion = macroCompletion(text, text.length)!;
    expect(macroInsertion(text, completion, findMacro('char')!).text).toBe('{{char}}');
  });

  test('the comment macro inserts room for prose rather than a :: list', () => {
    const text = '{{//';
    const completion = macroCompletion(text, text.length)!;
    const result = macroInsertion(text, completion, findMacro('//')!);
    expect(result.text).toBe('{{// }}');
    expect(result.caret).toBe('{{// '.length);
  });
});
