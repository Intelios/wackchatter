import { describe, expect, test } from 'bun:test';
import { parseSlashCommand, SLASH_COMMANDS, slashCompletion } from './slashCommands.ts';

describe('parseSlashCommand', () => {
  test('plain text is not a command', () => {
    expect(parseSlashCommand('hello there')).toBeNull();
    expect(parseSlashCommand('  hello there  ')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  test('a message that merely mentions a slash is not a command', () => {
    expect(parseSlashCommand('see /hide for help')).toBeNull();
    expect(parseSlashCommand('3/5 of a plan')).toBeNull();
  });

  test('an unknown command reports itself, not a silent send', () => {
    const result = parseSlashCommand('/giggle');
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.error).toContain('giggle');
  });

  test('a bare slash reports an error', () => {
    const result = parseSlashCommand('/');
    expect(result?.ok).toBe(false);
  });

  describe('/hide', () => {
    test('a single index hides that one message', () => {
      expect(parseSlashCommand('/hide 4')).toEqual({
        ok: true,
        command: { type: 'hide', start: 4, end: 4 },
      });
    });

    test('a range is inclusive and zero-based', () => {
      expect(parseSlashCommand('/hide 0-150')).toEqual({
        ok: true,
        command: { type: 'hide', start: 0, end: 150 },
      });
    });

    test('whitespace around the dash is accepted', () => {
      expect(parseSlashCommand('/hide 0 - 150')).toEqual({
        ok: true,
        command: { type: 'hide', start: 0, end: 150 },
      });
    });

    test('no argument means the last message', () => {
      expect(parseSlashCommand('/hide')).toEqual({
        ok: true,
        command: { type: 'hide', start: null, end: null },
      });
    });

    test('a reversed range is refused', () => {
      const result = parseSlashCommand('/hide 150-0');
      expect(result?.ok).toBe(false);
    });

    test('garbage arguments are refused with the usage string', () => {
      for (const input of ['/hide banana', '/hide 1..5', '/hide -3', '/hide 3.5']) {
        const result = parseSlashCommand(input);
        expect(result?.ok).toBe(false);
        if (result?.ok === false) expect(result.error).toContain('/hide');
      }
    });
  });

  describe('/unhide', () => {
    test('mirrors /hide', () => {
      expect(parseSlashCommand('/unhide 2-5')).toEqual({
        ok: true,
        command: { type: 'unhide', start: 2, end: 5 },
      });
      expect(parseSlashCommand('/unhide 0')).toEqual({
        ok: true,
        command: { type: 'unhide', start: 0, end: 0 },
      });
    });
  });

  describe('/jump', () => {
    test('an index normalises to a number', () => {
      expect(parseSlashCommand('/jump 4')).toEqual({
        ok: true,
        command: { type: 'jump', index: 4 },
      });
    });

    test('a missing index is an error', () => {
      const result = parseSlashCommand('/jump');
      expect(result?.ok).toBe(false);
      if (result?.ok === false) expect(result.error).toContain('/jump');
    });

    test('a non-integer index is an error', () => {
      const result = parseSlashCommand('/jump fourth');
      expect(result?.ok).toBe(false);
    });

    test('an extra argument is an error', () => {
      expect(parseSlashCommand('/jump 1 2')?.ok).toBe(false);
    });
  });

  describe('/rename', () => {
    test('the rest of the line is the title, spaces and all', () => {
      expect(parseSlashCommand('/rename The Fountain Incident')).toEqual({
        ok: true,
        command: { type: 'rename', title: 'The Fountain Incident' },
      });
    });

    test('surrounding whitespace is trimmed but inner spacing is kept', () => {
      expect(parseSlashCommand('/rename   day  two  ')).toEqual({
        ok: true,
        command: { type: 'rename', title: 'day  two' },
      });
    });

    test('a title is required — an empty rename would erase the label', () => {
      expect(parseSlashCommand('/rename')?.ok).toBe(false);
      expect(parseSlashCommand('/rename   ')?.ok).toBe(false);
    });
  });

  describe('/reload', () => {
    test('bare /reload parses', () => {
      expect(parseSlashCommand('/reload')).toEqual({ ok: true, command: { type: 'reload' } });
    });

    test('arguments are refused', () => {
      expect(parseSlashCommand('/reload now')?.ok).toBe(false);
    });
  });
});

describe('slashCompletion', () => {
  test('a plain message is not a command', () => {
    expect(slashCompletion('hello')).toBeNull();
    expect(slashCompletion('')).toBeNull();
  });

  test('a bare slash offers every command and is completing', () => {
    const result = slashCompletion('/');
    expect(result?.completing).toBe(true);
    expect(result?.suggestions.map((c) => c.name)).toEqual([
      'hide',
      'unhide',
      'jump',
      'rename',
      'reload',
    ]);
  });

  test('a prefix filters the list and stays completing', () => {
    expect(slashCompletion('/h')?.suggestions.map((c) => c.name)).toEqual(['hide']);
    expect(slashCompletion('/u')?.suggestions.map((c) => c.name)).toEqual(['unhide']);
    expect(slashCompletion('/un')?.suggestions.map((c) => c.name)).toEqual(['unhide']);
    // Two commands share the "re" prefix, so it narrows without resolving.
    expect(slashCompletion('/re')?.suggestions.map((c) => c.name)).toEqual(['rename', 'reload']);
    expect(slashCompletion('/rel')?.suggestions.map((c) => c.name)).toEqual(['reload']);
    expect(slashCompletion('/h')?.completing).toBe(true);
  });

  test('an exact command name is not completing — Enter runs it', () => {
    expect(slashCompletion('/hide')?.suggestions.map((c) => c.name)).toEqual(['hide']);
    expect(slashCompletion('/hide')?.completing).toBe(false);
  });

  test('arguments switch to the usage reference, still not completing', () => {
    expect(slashCompletion('/hide 0-150')?.suggestions.map((c) => c.name)).toEqual(['hide']);
    expect(slashCompletion('/hide 0-150')?.completing).toBe(false);
    expect(slashCompletion('/jump 4')?.suggestions.map((c) => c.name)).toEqual(['jump']);
  });

  test('matching is case-insensitive', () => {
    expect(slashCompletion('/HIDE 0-3')?.suggestions.map((c) => c.name)).toEqual(['hide']);
  });

  test('an unknown name offers nothing to complete', () => {
    expect(slashCompletion('/xyz')?.suggestions).toEqual([]);
  });

  test('the registry covers every command the parser recognises', () => {
    const names = new Set(SLASH_COMMANDS.map((command) => command.name));
    for (const input of ['/hide', '/unhide', '/jump', '/reload']) {
      expect(names.has(input.slice(1))).toBe(true);
    }
  });
});
