import { describe, expect, test } from 'bun:test';
import type { RegexScript } from '../types/regex.ts';
import { REGEX_PLACEMENT, REGEX_SUBSTITUTE } from '../types/regex.ts';
import {
  applyRegexScripts,
  compileFindRegex,
  createRegexCompileCache,
  type RegexMacros,
  runRegexScript,
  sanitizeRegexMacro,
  scriptApplies,
} from './engine.ts';

function script(overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id: 'test',
    scriptName: 'test',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: REGEX_SUBSTITUTE.NONE,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  };
}

/** A stand-in for the assembler's closure, resolving only the two macros scripts use. */
const MACROS: RegexMacros = {
  expand: (text) => text.replaceAll('{{char}}', 'Ada').replaceAll('{{user}}', 'You'),
  expandEscaped: (text) =>
    text
      .replaceAll('{{char}}', sanitizeRegexMacro('Ada'))
      .replaceAll('{{user}}', sanitizeRegexMacro('You')),
};

const DISPLAY = { placement: REGEX_PLACEMENT.AI_OUTPUT, display: true } as const;

describe('compileFindRegex', () => {
  test('parses a slashed literal with flags', () => {
    const regex = compileFindRegex('/dragon(s)?/gi');
    expect(regex?.source).toBe('dragon(s)?');
    expect(regex?.flags).toBe('gi');
  });

  test('a bare pattern gets no flags, so it replaces only the first match', () => {
    const regex = compileFindRegex('cat');
    expect(regex?.flags).toBe('');
    expect('cat cat'.replace(regex!, 'dog')).toBe('dog cat');
  });

  test('keeps g, unlike world info key parsing, because replacing every match needs it', () => {
    expect(compileFindRegex('/cat/g')?.flags).toBe('g');
  });

  test('invalid flags turn the whole original string into the pattern', () => {
    // ST does not error here; `/foo/G` ends up matching the literal text `/foo/G`.
    const regex = compileFindRegex('/foo/G');
    expect(regex?.source).toBe('\\/foo\\/G');
    expect(regex?.test('a /foo/G b')).toBe(true);
  });

  test('drops trailing junk after the flags, as ST does', () => {
    const regex = compileFindRegex('/foo/g1');
    expect(regex?.source).toBe('foo');
    expect(regex?.flags).toBe('g');
  });

  test('a flag ST allows but JS rejects yields null, so the script no-ops', () => {
    expect(compileFindRegex('/foo/x')).toBeNull();
  });

  test('keeps a multi-line pattern intact, unlike SillyTavern regexFromString', () => {
    // ST's parser is unanchored with a dot that stops at a newline, so it would compile
    // this to `/\/foo/` and silently match something else entirely.
    const regex = compileFindRegex('/foo\nbar/');
    // `source` reports a newline as the two-character escape, which is JS, not us.
    expect(regex?.source).toBe('foo\\nbar');
    expect(regex?.test('foo\nbar')).toBe(true);
  });

  test('an empty pattern is null rather than a regex that matches everything', () => {
    expect(compileFindRegex('')).toBeNull();
  });

  test('a double slash is the literal pattern, not an empty one', () => {
    expect(compileFindRegex('//')?.source).toBe('\\/\\/');
  });

  test('an uncompilable pattern yields null', () => {
    expect(compileFindRegex('/[unclosed/')).toBeNull();
  });

  test('caches by pattern string', () => {
    const cache = createRegexCompileCache();
    expect(compileFindRegex('/cat/g', cache)).toBe(compileFindRegex('/cat/g', cache));
    expect(cache.size).toBe(1);
  });
});

describe('scriptApplies — the ephemerality truth table', () => {
  const CONTEXTS = {
    display: { placement: REGEX_PLACEMENT.AI_OUTPUT, display: true },
    prompt: { placement: REGEX_PLACEMENT.AI_OUTPUT, prompt: true },
    // Neither flag is ST's storage path, which rewrites the chat file. We have no such
    // call site, so this column exists only to prove the gate still reads the way ST's does.
    storage: { placement: REGEX_PLACEMENT.AI_OUTPUT },
  } as const;

  const CASES: [
    markdownOnly: boolean,
    promptOnly: boolean,
    display: boolean,
    prompt: boolean,
    storage: boolean,
  ][] = [
    [true, false, true, false, false],
    [false, true, false, true, false],
    [true, true, true, true, false],
    [false, false, false, false, true],
  ];

  for (const [markdownOnly, promptOnly, display, prompt, storage] of CASES) {
    const label = `markdownOnly=${markdownOnly} promptOnly=${promptOnly}`;
    test(`${label} runs on display=${display} prompt=${prompt} storage=${storage}`, () => {
      const s = script({ markdownOnly, promptOnly });
      expect(scriptApplies(s, CONTEXTS.display)).toBe(display);
      expect(scriptApplies(s, CONTEXTS.prompt)).toBe(prompt);
      expect(scriptApplies(s, CONTEXTS.storage)).toBe(storage);
    });
  }

  test('a disabled script never applies', () => {
    expect(scriptApplies(script({ disabled: true }), CONTEXTS.display)).toBe(false);
  });
});

describe('scriptApplies — placement', () => {
  test('fires only for a listed placement', () => {
    const s = script({ placement: [REGEX_PLACEMENT.AI_OUTPUT] });
    expect(scriptApplies(s, { placement: REGEX_PLACEMENT.AI_OUTPUT, display: true })).toBe(true);
    expect(scriptApplies(s, { placement: REGEX_PLACEMENT.USER_INPUT, display: true })).toBe(false);
  });

  test('a placement we do not implement is preserved and never fires', () => {
    // 4 is ST's retired `sendAs`. It has to survive a round trip; it must not run.
    const s = script({ placement: [4] });
    for (const placement of Object.values(REGEX_PLACEMENT)) {
      expect(scriptApplies(s, { placement, display: true })).toBe(false);
    }
  });
});

describe('scriptApplies — depth', () => {
  const at = (depth: number | undefined) => ({ ...DISPLAY, depth });

  test('both bounds are inclusive', () => {
    const s = script({ minDepth: 1, maxDepth: 3 });
    expect(scriptApplies(s, at(0))).toBe(false);
    expect(scriptApplies(s, at(1))).toBe(true);
    expect(scriptApplies(s, at(3))).toBe(true);
    expect(scriptApplies(s, at(4))).toBe(false);
  });

  test('null means unlimited', () => {
    const s = script({ minDepth: null, maxDepth: null });
    expect(scriptApplies(s, at(0))).toBe(true);
    expect(scriptApplies(s, at(99))).toBe(true);
  });

  test('minDepth -1 reaches the message being continued', () => {
    expect(scriptApplies(script({ minDepth: -1 }), at(-1))).toBe(true);
    expect(scriptApplies(script({ minDepth: 0 }), at(-1))).toBe(false);
  });

  test('an out-of-range bound is ignored rather than blocking the script', () => {
    // ST treats minDepth < -1 and maxDepth < 0 as unset. A stray value in a box must not
    // silently switch a script off.
    expect(scriptApplies(script({ minDepth: -5 }), at(0))).toBe(true);
    expect(scriptApplies(script({ maxDepth: -1 }), at(9))).toBe(true);
  });

  test('no depth at all skips gating entirely', () => {
    expect(scriptApplies(script({ minDepth: 5, maxDepth: 6 }), at(undefined))).toBe(true);
  });
});

describe('runRegexScript — replacement', () => {
  test('replaces the first match without g, every match with it', () => {
    expect(runRegexScript(script({ findRegex: 'a', replaceString: 'X' }), 'aaa')).toBe('Xaa');
    expect(runRegexScript(script({ findRegex: '/a/g', replaceString: 'X' }), 'aaa')).toBe('XXX');
  });

  test('resolves numbered capture groups', () => {
    const s = script({ findRegex: '/(\\w+) (\\w+)/', replaceString: '$2 $1' });
    expect(runRegexScript(s, 'hello world')).toBe('world hello');
  });

  test('resolves named capture groups', () => {
    const s = script({ findRegex: '/(?<who>\\w+)!/', replaceString: 'hi $<who>' });
    expect(runRegexScript(s, 'Ada!')).toBe('hi Ada');
  });

  test('{{match}} is the whole match', () => {
    const s = script({ findRegex: '/world/', replaceString: '[{{match}}]' });
    expect(runRegexScript(s, 'hello world')).toBe('hello [world]');
  });

  test('$& is not a capture reference — the engine only knows $N and $<name>', () => {
    const s = script({ findRegex: '/world/', replaceString: '[$&]' });
    expect(runRegexScript(s, 'hello world')).toBe('hello [$&]');
  });

  test('an unmatched optional group becomes the empty string', () => {
    const s = script({ findRegex: '/cat(s)?/', replaceString: 'dog$1' });
    expect(runRegexScript(s, 'cat')).toBe('dog');
    expect(runRegexScript(s, 'cats')).toBe('dogs');
  });

  test('a reference past the last group yields nothing, not the match offset', () => {
    // ST splices its callback's trailing arguments in here, so `$1` on a pattern with no
    // groups produces a number. That is a bug, not a behaviour worth reproducing.
    const s = script({ findRegex: '/cat/', replaceString: '[$1]' });
    expect(runRegexScript(s, 'a cat')).toBe('a []');
  });

  test('deleting a match is just an empty replacement', () => {
    const s = script({ findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '' });
    expect(runRegexScript(s, 'a<think>hm</think>b')).toBe('ab');
  });

  test('a g-flagged script reused from the cache still matches from the start', () => {
    const cache = createRegexCompileCache();
    const s = script({ findRegex: '/a/g', replaceString: 'X' });
    expect(runRegexScript(s, 'aa', { cache })).toBe('XX');
    expect(runRegexScript(s, 'aa', { cache })).toBe('XX');
  });

  test('no-ops rather than throwing on an empty or uncompilable pattern', () => {
    expect(runRegexScript(script({ findRegex: '' }), 'text')).toBe('text');
    expect(runRegexScript(script({ findRegex: '/[unclosed/' }), 'text')).toBe('text');
    expect(runRegexScript(script({ findRegex: 'a' }), '')).toBe('');
  });
});

describe('runRegexScript — trimStrings', () => {
  test('are removed from substituted captures only, never from literal text', () => {
    const s = script({
      findRegex: '/say (.+)/',
      replaceString: 'um: $1',
      trimStrings: ['um '],
    });
    // The `um ` inside the capture goes; the `um: ` the script author typed stays.
    expect(runRegexScript(s, 'say um hello')).toBe('um: hello');
  });

  test('are literal strings, not patterns', () => {
    const s = script({ findRegex: '/(.+)/', replaceString: '$1', trimStrings: ['.+'] });
    expect(runRegexScript(s, 'a.+b')).toBe('ab');
  });

  test('expand macros before matching', () => {
    const s = script({ findRegex: '/(.+)/', replaceString: '$1', trimStrings: ['{{char}}: '] });
    expect(runRegexScript(s, 'Ada: hello', { macros: MACROS })).toBe('hello');
  });

  test('a trim string that expands to nothing is skipped, not spliced between every char', () => {
    const blank = (text: string) => text.replaceAll('{{nope}}', '');
    const macros: RegexMacros = { expand: blank, expandEscaped: blank };
    const s = script({ findRegex: '/(.+)/', replaceString: '$1', trimStrings: ['{{nope}}'] });
    expect(runRegexScript(s, 'abc', { macros })).toBe('abc');
  });
});

describe('runRegexScript — macros', () => {
  test('the replacement is macro-expanded last, after captures are filled in', () => {
    const s = script({ findRegex: '/^/', replaceString: '[{{char}}]: ' });
    expect(runRegexScript(s, 'hello', { macros: MACROS })).toBe('[Ada]: hello');
  });

  test('substituteRegex NONE leaves the find pattern literal', () => {
    const s = script({
      findRegex: '{{char}}',
      replaceString: 'X',
      substituteRegex: REGEX_SUBSTITUTE.NONE,
    });
    expect(runRegexScript(s, 'Ada and {{char}}', { macros: MACROS })).toBe('Ada and X');
  });

  test('substituteRegex RAW expands the find pattern', () => {
    const s = script({
      findRegex: '{{char}}',
      replaceString: 'X',
      substituteRegex: REGEX_SUBSTITUTE.RAW,
    });
    expect(runRegexScript(s, 'Ada speaks', { macros: MACROS })).toBe('X speaks');
  });

  test('substituteRegex RAW lets metacharacters in a name go live — the documented footgun', () => {
    const macros: RegexMacros = {
      expand: (text) => text.replaceAll('{{char}}', 'A.a'),
      expandEscaped: (text) => text.replaceAll('{{char}}', sanitizeRegexMacro('A.a')),
    };
    const raw = script({
      findRegex: '{{char}}',
      replaceString: 'X',
      substituteRegex: REGEX_SUBSTITUTE.RAW,
    });
    // `A.a` compiles as "A, anything, a" and eats a name it should not have matched.
    expect(runRegexScript(raw, 'Aba speaks', { macros })).toBe('X speaks');

    const escaped = script({ ...raw, substituteRegex: REGEX_SUBSTITUTE.ESCAPED });
    expect(runRegexScript(escaped, 'Aba speaks', { macros })).toBe('Aba speaks');
    expect(runRegexScript(escaped, 'A.a speaks', { macros })).toBe('X speaks');
  });
});

describe('sanitizeRegexMacro', () => {
  test('escapes the metacharacters that would otherwise go live', () => {
    expect(sanitizeRegexMacro('a.b*c(d)')).toBe('a\\.b\\*c\\(d\\)');
  });

  test('escapes a slash, which would end the literal', () => {
    expect(sanitizeRegexMacro('a/b')).toBe('a\\/b');
  });

  test('turns real control characters into their escape sequences', () => {
    expect(sanitizeRegexMacro('a\nb')).toBe('a\\nb');
  });

  test('does not escape a hyphen, so a substituted name inside [...] can still form a range', () => {
    // An ST oversight, reproduced: `[{{char}}]` with a name like `a-z` becomes a range.
    expect(sanitizeRegexMacro('a-z')).toBe('a-z');
  });
});

describe('applyRegexScripts', () => {
  test('chains, so each script sees the previous one output', () => {
    const scripts = [
      script({ id: 'a', findRegex: '/cat/g', replaceString: 'dog' }),
      script({ id: 'b', findRegex: '/dog/g', replaceString: 'bird' }),
    ];
    expect(applyRegexScripts('a cat', scripts, DISPLAY)).toBe('a bird');
  });

  test('skips scripts the gate rejects', () => {
    const scripts = [
      script({
        id: 'a',
        findRegex: '/cat/g',
        replaceString: 'dog',
        promptOnly: true,
        markdownOnly: false,
      }),
    ];
    expect(applyRegexScripts('a cat', scripts, DISPLAY)).toBe('a cat');
    expect(
      applyRegexScripts('a cat', scripts, { placement: REGEX_PLACEMENT.AI_OUTPUT, prompt: true }),
    ).toBe('a dog');
  });

  test('an empty list or empty input is the identity', () => {
    expect(applyRegexScripts('text', [], DISPLAY)).toBe('text');
    expect(applyRegexScripts('', [script({ findRegex: '/a/', replaceString: 'b' })], DISPLAY)).toBe(
      '',
    );
  });
});

describe('the shared SillyTavern speaker-tag scripts', () => {
  // The three files in ExtensionsForSillyTavernSource/Regex, verbatim. Together they are
  // the feature this system exists for: a tag the model reads and the reader never sees.
  const CHAR = script({
    id: 'char',
    scriptName: 'char',
    findRegex: '^[^[]',
    replaceString: '[{{char}}]: $0',
    placement: [REGEX_PLACEMENT.AI_OUTPUT],
    markdownOnly: true,
    promptOnly: true,
  });
  const USER = script({
    id: 'user',
    scriptName: 'user',
    findRegex: '^[^[]',
    replaceString: '[{{user}}]: $0',
    placement: [REGEX_PLACEMENT.USER_INPUT],
    markdownOnly: true,
    promptOnly: true,
  });
  const HIDE = script({
    id: 'hide',
    scriptName: 'usercharhide',
    findRegex: '^\\[({{char}}|{{user}})\\]:\\s?',
    replaceString: '',
    placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
    markdownOnly: true,
    promptOnly: false,
    substituteRegex: REGEX_SUBSTITUTE.RAW,
  });
  const ALL = [CHAR, USER, HIDE];
  const options = { macros: MACROS };

  test('the model is told who is speaking', () => {
    expect(
      applyRegexScripts(
        'Hello there.',
        ALL,
        { placement: REGEX_PLACEMENT.AI_OUTPUT, prompt: true },
        options,
      ),
    ).toBe('[Ada]: Hello there.');
    expect(
      applyRegexScripts(
        'Hi Ada.',
        ALL,
        { placement: REGEX_PLACEMENT.USER_INPUT, prompt: true },
        options,
      ),
    ).toBe('[You]: Hi Ada.');
  });

  test('the reader is not — the tag is added and then stripped again on display', () => {
    expect(applyRegexScripts('Hello there.', ALL, DISPLAY, options)).toBe('Hello there.');
    expect(
      applyRegexScripts(
        'Hi Ada.',
        ALL,
        { placement: REGEX_PLACEMENT.USER_INPUT, display: true },
        options,
      ),
    ).toBe('Hi Ada.');
  });

  test('a tag already in the stored text is hidden from the reader and kept for the model', () => {
    // The case the user actually asked for: the model writes the tag itself.
    const stored = '[Ada]: Hello there.';
    expect(applyRegexScripts(stored, [HIDE], DISPLAY, options)).toBe('Hello there.');
    expect(
      applyRegexScripts(
        stored,
        [HIDE],
        { placement: REGEX_PLACEMENT.AI_OUTPUT, prompt: true },
        options,
      ),
    ).toBe(stored);
  });

  test('order matters — stripping before prefixing would leave the tag on screen', () => {
    const reversed = [HIDE, CHAR, USER];
    expect(applyRegexScripts('Hello there.', reversed, DISPLAY, options)).toBe(
      '[Ada]: Hello there.',
    );
  });
});
