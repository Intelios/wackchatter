import { describe, expect, test } from 'bun:test';
import { type CardBlock, normalizeSlotLabel, parseCardBlocks } from './blocks.ts';

/** The blocks alone, for assertions that do not care about the surrounding prose. */
function blocksOf(source: string): CardBlock[] {
  return parseCardBlocks(source).blocks;
}

function kinds(source: string): string[] {
  return parseCardBlocks(source).parts.map((part) =>
    part.kind === 'prose' ? 'prose' : `block:${part.block.label}`,
  );
}

describe('parsing card blocks', () => {
  test('a block yields prose, block, prose in order', () => {
    const source = [
      'Here is one.',
      '',
      '```card:first_mes',
      'The lamp room is cold.',
      '```',
      '',
      'What next?',
    ].join('\n');

    expect(kinds(source)).toEqual(['prose', 'block:first_mes', 'prose']);
    const [block] = blocksOf(source);
    expect(block).toMatchObject({
      slot: 'first_mes',
      label: 'first_mes',
      text: 'The lamp room is cold.',
      closed: true,
    });
  });

  test('offsets address the block content exactly', () => {
    const source = 'Intro.\n\n```card:description\nTall and tired.\nAlways cold.\n```\n\nOutro.';
    const [block] = blocksOf(source);

    expect(source.slice(block!.start, block!.end)).toBe(block!.text);
    expect(block!.text).toBe('Tall and tired.\nAlways cold.');
  });

  test('two blocks with prose between them yield five parts', () => {
    const source = [
      'Two openings:',
      '```card:first_mes',
      'One.',
      '```',
      'Or, colder:',
      '```card:first_mes',
      'Two.',
      '```',
      'Which?',
    ].join('\n');

    expect(kinds(source)).toEqual([
      'prose',
      'block:first_mes',
      'prose',
      'block:first_mes',
      'prose',
    ]);
    expect(blocksOf(source).map((block) => block.text)).toEqual(['One.', 'Two.']);
  });

  test('a four-backtick fence survives a three-backtick fence inside it', () => {
    const source = [
      '````card:mes_example',
      '<START>',
      '```',
      'not a closer',
      '```',
      '<START>',
      '````',
    ].join('\n');
    const [block] = blocksOf(source);

    expect(block!.closed).toBe(true);
    expect(block!.text).toBe('<START>\n```\nnot a closer\n```\n<START>');
  });

  test('a three-backtick fence closes at the first three-backtick line — why the prompt asks for four', () => {
    const source = ['```card:mes_example', 'before', '```', 'after', '```'].join('\n');
    const [block] = blocksOf(source);

    expect(block!.text).toBe('before');
    expect(block!.closed).toBe(true);
  });

  test('an unterminated fence keeps its content and reports itself unclosed', () => {
    const source = 'Working on it:\n```card:description\nTall and tired, the kind of';
    const parts = parseCardBlocks(source).parts;

    expect(kinds(source)).toEqual(['prose', 'block:description']);
    expect(parts[1]).toMatchObject({
      kind: 'block',
      block: { closed: false, text: 'Tall and tired, the kind of' },
    });
  });

  test('an opener with no content yet produces no block and does not throw', () => {
    expect(blocksOf('Here you go:\n```card:description')).toEqual([]);
    expect(kinds('Here you go:\n```card:description')).toEqual(['prose']);
  });

  test('an unknown label keeps its text and is left uncoerced', () => {
    const [block] = blocksOf('```card:vibe\nSpooky.\n```');

    expect(block).toMatchObject({ slot: null, label: 'vibe', text: 'Spooky.' });
  });

  test('a plain code fence is left in prose and never scanned for openers', () => {
    const source = ['```json', '{ "note": "```card:description" }', '```'].join('\n');
    const parsed = parseCardBlocks(source);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]).toEqual({ kind: 'prose', text: source });
  });

  test('a fence indented four spaces is an indented code block, not an opener', () => {
    expect(blocksOf('    ```card:description\n    Tall.\n    ```')).toEqual([]);
  });

  test('prose parts rejoin to the source once the fence lines are gone', () => {
    const source = 'A.\n\n```card:name\nElowen\n```\n\nB.\n\n```card:tags\ngothic, keeper\n```';
    const parsed = parseCardBlocks(source);
    const rejoined = parsed.parts
      .map((part) => (part.kind === 'prose' ? part.text : part.block.text))
      .join('\n');

    expect(rejoined).toBe('A.\nElowen\nB.\ngothic, keeper');
  });

  test('CRLF input parses the same as LF', () => {
    const crlf = 'Intro.\r\n\r\n```card:first_mes\r\nCold.\r\n```\r\n\r\nOutro.';

    expect(kinds(crlf)).toEqual(['prose', 'block:first_mes', 'prose']);
    expect(blocksOf(crlf)[0]!.text).toBe('Cold.');
  });

  test('empty input parses to nothing', () => {
    expect(parseCardBlocks('')).toEqual({ parts: [], blocks: [] });
  });
});

describe('slot labels', () => {
  test('case, spaces and hyphens all fold', () => {
    expect(normalizeSlotLabel('First Mes')).toBe('first_mes');
    expect(normalizeSlotLabel('first-mes')).toBe('first_mes');
    expect(normalizeSlotLabel('  DESCRIPTION  ')).toBe('description');
  });

  test('the aliases a model actually writes resolve', () => {
    expect(normalizeSlotLabel('greeting')).toBe('first_mes');
    expect(normalizeSlotLabel('first_message')).toBe('first_mes');
    expect(normalizeSlotLabel('alternate_greetings')).toBe('alternate_greeting');
    expect(normalizeSlotLabel('example_dialogue')).toBe('mes_example');
    expect(normalizeSlotLabel('notes')).toBe('creator_notes');
  });

  test('an unrecognised label is null rather than a guess', () => {
    expect(normalizeSlotLabel('firstmes')).toBeNull();
    expect(normalizeSlotLabel('backstory')).toBeNull();
    expect(normalizeSlotLabel('')).toBeNull();
  });

  test('the label folds through the parser too', () => {
    expect(blocksOf('```card:First Message\nHi.\n```')[0]!.slot).toBe('first_mes');
    expect(blocksOf('```CARD:tags\na, b\n```')[0]!.slot).toBe('tags');
  });
});
