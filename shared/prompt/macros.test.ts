import { describe, expect, test } from 'bun:test';
import { type MacroEnvironment, substituteMacros } from './macros.ts';

const env: MacroEnvironment = {
  char: 'Seraphina',
  user: 'Jack',
  description: 'A forest guardian.',
  personality: 'Kind.',
  scenario: 'A glade.',
  persona: 'A weary traveller.',
  maxContext: 8192,
  maxResponse: 512,
};

describe('identity macros', () => {
  test('substitutes char and user', () => {
    expect(substituteMacros('{{char}} greets {{user}}', env)).toBe('Seraphina greets Jack');
  });

  test('is case-insensitive', () => {
    expect(substituteMacros('{{CHAR}} and {{User}}', env)).toBe('Seraphina and Jack');
  });

  test('tolerates surrounding whitespace inside the braces', () => {
    expect(substituteMacros('{{ char }}', env)).toBe('Seraphina');
  });

  test('resolves card fields and persona', () => {
    expect(substituteMacros('{{description}}', env)).toBe('A forest guardian.');
    expect(substituteMacros('{{personality}}', env)).toBe('Kind.');
    expect(substituteMacros('{{scenario}}', env)).toBe('A glade.');
    expect(substituteMacros('{{persona}}', env)).toBe('A weary traveller.');
  });

  test('group and charIfNotGroup fall back to the character in single chats', () => {
    expect(substituteMacros('{{charIfNotGroup}}', env)).toBe('Seraphina');
    expect(substituteMacros('{{group}}', env)).toBe('Seraphina');
  });

  test('leaves unknown macros untouched rather than blanking them', () => {
    // Silently deleting an unrecognised macro would hide typos in a user's prompt.
    expect(substituteMacros('{{notARealMacro}}', env)).toBe('{{notARealMacro}}');
  });

  test('unset optional fields resolve to empty, not "undefined"', () => {
    expect(substituteMacros('[{{model}}]', { char: 'A', user: 'B' })).toBe('[]');
  });
});

describe('budget macros', () => {
  test('reports the configured context and response sizes', () => {
    expect(substituteMacros('{{maxContext}}/{{maxResponse}}', env)).toBe('8192/512');
  });
});

describe('comments and formatting', () => {
  test('strips {{// comments}}', () => {
    expect(substituteMacros('before {{// a note}}after', env)).toBe('before after');
  });

  test('{{newline}} emits a line break', () => {
    expect(substituteMacros('a{{newline}}b', env)).toBe('a\nb');
  });

  test('{{noop}} emits nothing', () => {
    expect(substituteMacros('a{{noop}}b', env)).toBe('ab');
  });

  test('{{trim}} eats the whitespace around it', () => {
    expect(substituteMacros('line one\n\n{{trim}}\n\nline two', env)).toBe('line oneline two');
    expect(substituteMacros('a  {{trim}}  b', env)).toBe('ab');
  });

  test('{{reverse}} reverses its argument', () => {
    expect(substituteMacros('{{reverse:abc}}', env)).toBe('cba');
  });
});

describe('randomness', () => {
  test('{{random}} picks one of its choices', () => {
    const result = substituteMacros('{{random::alpha::beta::gamma}}', env);
    expect(['alpha', 'beta', 'gamma']).toContain(result);
  });

  test('{{random}} accepts comma-separated choices too', () => {
    expect(['red', 'blue']).toContain(substituteMacros('{{random:red,blue}}', env));
  });

  test('{{roll}} stays within range', () => {
    for (let i = 0; i < 20; i++) {
      const value = Number(substituteMacros('{{roll:6}}', env));
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });

  test('{{roll:2d6}} stays within the dice range', () => {
    for (let i = 0; i < 20; i++) {
      const value = Number(substituteMacros('{{roll:2d6}}', env));
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(12);
    }
  });

  test('{{pick}} is stable for the same text and seed, unlike {{random}}', () => {
    const text = '{{pick::one::two::three::four::five}}';
    const first = substituteMacros(text, env, 'chat-1');

    for (let i = 0; i < 5; i++) {
      expect(substituteMacros(text, env, 'chat-1')).toBe(first);
    }
  });

  test('{{pick}} can differ across seeds', () => {
    const text = '{{pick::one::two::three::four::five::six::seven::eight}}';
    const results = new Set(
      Array.from({ length: 30 }, (_, i) => substituteMacros(text, env, `seed-${i}`)),
    );
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('extra macros', () => {
  test('caller-supplied macros resolve, including as functions', () => {
    const result = substituteMacros('{{original}} and {{lazy}}', {
      ...env,
      extra: { original: 'ORIGINAL TEXT', lazy: () => 'COMPUTED' },
    });
    expect(result).toBe('ORIGINAL TEXT and COMPUTED');
  });
});

describe('edge cases', () => {
  test('empty input returns empty', () => {
    expect(substituteMacros('', env)).toBe('');
  });

  test('text with no macros passes through unchanged', () => {
    expect(substituteMacros('just some prose', env)).toBe('just some prose');
  });

  test('an empty macro is left alone', () => {
    expect(substituteMacros('{{}}', env)).toBe('{{}}');
  });

  test('substitution is not recursive', () => {
    // A value that itself looks like a macro must not be expanded again.
    expect(substituteMacros('{{char}}', { char: '{{user}}', user: 'Jack' })).toBe('{{user}}');
  });
});
