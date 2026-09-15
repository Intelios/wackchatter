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

  /*
   * `slashCompletion` lowercases its token (pinned above), so the box suggests `roll` for
   * `/Roll` the whole time the name is being typed. Recognition here must agree, or the
   * autocomplete advertises a command the parser then refuses.
   */
  test('recognition is case-insensitive, matching the autocomplete', () => {
    expect(parseSlashCommand('/Roll 2d6')).toEqual({
      ok: true,
      command: { type: 'roll', formula: '2d6' },
    });
    expect(parseSlashCommand('/HIDE 0-3')).toEqual({
      ok: true,
      command: { type: 'hide', start: 0, end: 3 },
    });
  });

  // The unknown-command error reports the user's spelling, not our lowercased one.
  test('an unknown command reports the spelling that was typed', () => {
    const result = parseSlashCommand('/Giggle');
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.error).toContain('/Giggle');
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

describe('/card', () => {
  /*
   * The only command whose argument is optional. Both halves stand alone: `/card` means
   * "show me the card", `/card hair` means "show me the bit about hair" — so an empty
   * argument is a valid command rather than the usage error every other command returns.
   */
  test('opens the card with no argument at all', () => {
    expect(parseSlashCommand('/card')).toEqual({ ok: true, command: { type: 'card', query: '' } });
  });

  test('an argument becomes the search, verbatim', () => {
    expect(parseSlashCommand('/card hair')).toEqual({
      ok: true,
      command: { type: 'card', query: 'hair' },
    });
  });

  // A search term is prose, like a chat title — "blonde hair" is one query, not two tokens.
  test('a multi-word search survives whole', () => {
    expect(parseSlashCommand('/card golden blonde hair')).toEqual({
      ok: true,
      command: { type: 'card', query: 'golden blonde hair' },
    });
  });

  test('surrounding whitespace is trimmed off the query', () => {
    expect(parseSlashCommand('  /card   hair   ')).toEqual({
      ok: true,
      command: { type: 'card', query: 'hair' },
    });
  });
});

describe('/persona', () => {
  /**
   * Optional argument, like `/card`. Bare means "show me the personas"; with a name it
   * switches. Both halves stand alone, so neither is an error.
   */
  test('opens the panel with no argument', () => {
    expect(parseSlashCommand('/persona')).toEqual({
      ok: true,
      command: { type: 'persona', query: '' },
    });
  });

  test('takes a name verbatim, spaces and all', () => {
    expect(parseSlashCommand('/persona Tamsin Vale')).toEqual({
      ok: true,
      command: { type: 'persona', query: 'Tamsin Vale' },
    });
  });

  test('passes "none" through for the executor to read as a clear', () => {
    expect(parseSlashCommand('/persona none')).toEqual({
      ok: true,
      command: { type: 'persona', query: 'none' },
    });
  });

  /*
   * Recognition and resolution are separate on purpose. This module has no library to
   * check a name against, so an unknown name parses fine and fails in the executor — which
   * is what lets the error name the candidates it actually found.
   */
  test('a name that matches nothing still parses — resolution is the executor’s job', () => {
    expect(parseSlashCommand('/persona nobody at all')).toEqual({
      ok: true,
      command: { type: 'persona', query: 'nobody at all' },
    });
  });

  test('surrounding whitespace is trimmed', () => {
    expect(parseSlashCommand('  /persona   Kestrel   ')).toEqual({
      ok: true,
      command: { type: 'persona', query: 'Kestrel' },
    });
  });
});

describe('/impersonate', () => {
  test('bare asks for an unsteered impersonation', () => {
    expect(parseSlashCommand('/impersonate')).toEqual({
      ok: true,
      command: { type: 'impersonate', instruction: '' },
    });
  });

  // Steering is prose, not tokens: "in a hurry, short sentences" is one instruction.
  test('takes an instruction verbatim, spaces and all', () => {
    expect(parseSlashCommand('/impersonate in a hurry, short sentences')).toEqual({
      ok: true,
      command: { type: 'impersonate', instruction: 'in a hurry, short sentences' },
    });
  });

  // SillyTavern's alias. Deliberately not in the help registry, so the autocomplete box
  // advertises one spelling while both parse.
  test('recognises the /imp alias', () => {
    expect(parseSlashCommand('/imp')).toEqual({
      ok: true,
      command: { type: 'impersonate', instruction: '' },
    });
    expect(parseSlashCommand('/IMP politely')).toEqual({
      ok: true,
      command: { type: 'impersonate', instruction: 'politely' },
    });
  });

  test('the alias is not advertised in the registry', () => {
    expect(SLASH_COMMANDS.some((command) => command.name === 'imp')).toBe(false);
  });
});

describe('/roll', () => {
  test('normalises the formula it hands the executor', () => {
    expect(parseSlashCommand('/roll 2d6+3')).toEqual({
      ok: true,
      command: { type: 'roll', formula: '2d6+3' },
    });
    expect(parseSlashCommand('/roll d20')).toEqual({
      ok: true,
      command: { type: 'roll', formula: '1d20' },
    });
  });

  // The die you reach for when you did not say which one.
  test('a bare /roll is 1d20', () => {
    expect(parseSlashCommand('/roll')).toEqual({
      ok: true,
      command: { type: 'roll', formula: '1d20' },
    });
  });

  /*
   * Validated at parse time, unlike `/persona`, because there is nothing to resolve later:
   * the grammar is the whole of it. Letting `2x6` through would put it in front of the
   * model as dialogue, which is exactly the failure this module exists to prevent.
   */
  test('an unrollable formula is an error, not a message', () => {
    const result = parseSlashCommand('/roll 2x6');
    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.error).toContain('2x6');
  });

  test('a formula past the dice cap is refused rather than rolled', () => {
    expect(parseSlashCommand('/roll 99999999d6')?.ok).toBe(false);
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
      'card',
      'persona',
      'roll',
      'impersonate',
    ]);
  });

  test('a prefix filters the list and stays completing', () => {
    expect(slashCompletion('/h')?.suggestions.map((c) => c.name)).toEqual(['hide']);
    expect(slashCompletion('/u')?.suggestions.map((c) => c.name)).toEqual(['unhide']);
    expect(slashCompletion('/un')?.suggestions.map((c) => c.name)).toEqual(['unhide']);
    // Two commands share the "re" prefix, so it narrows without resolving.
    expect(slashCompletion('/r')?.suggestions.map((c) => c.name)).toEqual([
      'rename',
      'reload',
      'roll',
    ]);
    expect(slashCompletion('/re')?.suggestions.map((c) => c.name)).toEqual(['rename', 'reload']);
    expect(slashCompletion('/rel')?.suggestions.map((c) => c.name)).toEqual(['reload']);
    expect(slashCompletion('/c')?.suggestions.map((c) => c.name)).toEqual(['card']);
    expect(slashCompletion('/p')?.suggestions.map((c) => c.name)).toEqual(['persona']);
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
    for (const input of [
      '/hide',
      '/unhide',
      '/jump',
      '/rename',
      '/reload',
      '/card',
      '/persona',
      '/impersonate',
    ]) {
      expect(names.has(input.slice(1))).toBe(true);
    }
  });
});
