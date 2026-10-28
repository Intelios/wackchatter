import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { toCharacterBook, toWorldInfoBook } from '../../shared/worldinfo/convert.ts';
import {
  createBlankCard,
  mergeCardData,
  normalizeCard,
  readCard,
  readCardJson,
  writeCard,
} from './card.ts';
import { encodeChunks, extractChunks, readTextChunks, replaceTextChunks } from './png.ts';

/** A 1x1 PNG with no text chunks — the same carrier the app uses for artless cards. */
const CARRIER = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/**
 * A V2+V3 dual-chunk card in the shape SillyTavern ships: an embedded 4-entry lorebook
 * whose entries carry ST's extension keys, and `group_only_greetings`, a field ST never
 * writes but does preserve.
 */
function sampleCard(): Uint8Array {
  const entry = (id: number, key: string) => ({
    id,
    keys: [key],
    secondary_keys: [],
    comment: key,
    content: `Lore about ${key}.`,
    constant: false,
    selective: false,
    insertion_order: 100,
    enabled: true,
    position: 'before_char',
    use_regex: true,
    extensions: {
      position: 0,
      exclude_recursion: false,
      display_index: id,
      probability: 100,
      useProbability: true,
      depth: 4,
      selectiveLogic: 0,
      group: '',
      group_override: false,
      group_weight: 100,
      prevent_recursion: false,
      delay_until_recursion: false,
      scan_depth: null,
      match_whole_words: null,
      use_group_scoring: false,
      case_sensitive: null,
      automation_id: '',
      role: 0,
      vectorized: false,
      sticky: 0,
      cooldown: 0,
      delay: 0,
    },
  });
  const card = normalizeCard({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Seraphina',
      description: 'A guardian of the glade.',
      first_mes: 'You wake in a forest clearing.',
      group_only_greetings: [],
      character_book: {
        name: 'Eldoria',
        extensions: {},
        entries: [
          entry(1, 'glade'),
          entry(2, 'forest'),
          entry(3, 'eldoria'),
          entry(4, 'shadowclaw'),
        ],
      },
    },
  });
  return writeCard(CARRIER, card);
}

describe('png chunks', () => {
  test('extracts the expected chunk layout from a card', () => {
    const chunks = extractChunks(sampleCard());
    const names = chunks.map((c) => c.name);

    expect(names[0]).toBe('IHDR');
    expect(names.at(-1)).toBe('IEND');
    expect(names.filter((n) => n === 'tEXt')).toHaveLength(2);
  });

  test('re-encoding chunks reproduces the file byte for byte', () => {
    const original = sampleCard();
    const roundTripped = encodeChunks(extractChunks(original));
    expect(roundTripped).toEqual(original);
  });

  test('reads both chara and ccv3 keywords', () => {
    const keywords = readTextChunks(sampleCard()).map((c) => c.keyword.toLowerCase());
    expect(keywords).toContain('chara');
    expect(keywords).toContain('ccv3');
  });

  test('replaceTextChunks splices before IEND and leaves image data intact', () => {
    const original = sampleCard();
    const updated = replaceTextChunks(
      original,
      ['chara', 'ccv3'],
      [{ keyword: 'chara', text: 'aGVsbG8=' }],
    );

    const chunks = extractChunks(updated);
    expect(chunks.at(-1)?.name).toBe('IEND');
    expect(chunks.filter((c) => c.name === 'tEXt')).toHaveLength(1);

    // IDAT must be identical — we never recompress.
    const originalIdat = extractChunks(original).filter((c) => c.name === 'IDAT');
    const updatedIdat = chunks.filter((c) => c.name === 'IDAT');
    expect(updatedIdat).toEqual(originalIdat);
  });

  test('rejects a non-PNG buffer', () => {
    expect(() => extractChunks(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a png/i);
  });
});

describe('reading cards', () => {
  test('ccv3 takes precedence over chara', () => {
    const base = sampleCard();
    const v2Payload = Buffer.from(
      JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'FromV2' } }),
      'utf8',
    ).toString('base64');
    const v3Payload = Buffer.from(
      JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'FromV3' } }),
      'utf8',
    ).toString('base64');

    // Deliberately write chara first, ccv3 second — precedence must not depend on order.
    const png = replaceTextChunks(
      base,
      ['chara', 'ccv3'],
      [
        { keyword: 'chara', text: v2Payload },
        { keyword: 'ccv3', text: v3Payload },
      ],
    );

    expect(JSON.parse(readCardJson(png)).data.name).toBe('FromV3');
  });

  test('falls back to chara when ccv3 is absent', () => {
    const payload = Buffer.from(
      JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'OnlyV2' } }),
      'utf8',
    ).toString('base64');
    const png = replaceTextChunks(
      sampleCard(),
      ['chara', 'ccv3'],
      [{ keyword: 'chara', text: payload }],
    );

    expect(JSON.parse(readCardJson(png)).data.name).toBe('OnlyV2');
  });

  test('keyword matching is case-insensitive', () => {
    const payload = Buffer.from(JSON.stringify({ data: { name: 'Shouty' } }), 'utf8').toString(
      'base64',
    );
    const png = replaceTextChunks(
      sampleCard(),
      ['chara', 'ccv3'],
      [{ keyword: 'CHARA', text: payload }],
    );

    expect(JSON.parse(readCardJson(png)).data.name).toBe('Shouty');
  });

  test('throws a useful error for an image with no card metadata', () => {
    const stripped = replaceTextChunks(sampleCard(), ['chara', 'ccv3'], []);
    expect(() => readCard(stripped)).toThrow(/not a character card|no character metadata/i);
  });
});

describe('normalising', () => {
  test('upgrades a bare V1 card to V2 shape', () => {
    const card = normalizeCard({
      name: 'Legacy',
      description: 'desc',
      personality: 'chirpy',
      scenario: 'a place',
      first_mes: 'hi',
      mes_example: '<START>',
    });

    expect(card.spec).toBe('chara_card_v2');
    expect(card.data.name).toBe('Legacy');
    expect(card.data.personality).toBe('chirpy');
    // V2-only fields get defaults rather than being left undefined.
    expect(card.data.alternate_greetings).toEqual([]);
    expect(card.data.tags).toEqual([]);
    expect(card.data.creator_notes).toBe('');
  });

  test('mirrors data.* onto the V1 legacy top level', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Mirror', description: 'from data', creator_notes: 'notes here' },
    });

    expect(card.name).toBe('Mirror');
    expect(card.description).toBe('from data');
    expect(card.creatorcomment).toBe('notes here');
    expect(card.avatar).toBe('none');
  });

  test('always emits character_book.extensions', () => {
    const card = normalizeCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'Booked', character_book: { name: 'B', entries: [] } },
    });

    expect(card.data.character_book?.extensions).toEqual({});
  });

  test('rejects an object that is not a card at all', () => {
    expect(() => normalizeCard({ foo: 'bar' })).toThrow(/unrecognised character card/i);
    expect(() => normalizeCard(null)).toThrow(/must be a json object/i);
  });
});

describe('unknown-key preservation', () => {
  test('foreign keys survive normalise -> merge -> write -> read', () => {
    const original = normalizeCard({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Exotic',
        description: 'original description',
        // V3 fields ST never writes but does preserve
        nickname: 'Ex',
        creation_date: 1700000000,
        source: ['https://example.invalid/card'],
        group_only_greetings: ['hello group'],
        assets: [{ type: 'icon', uri: 'embeded://main.png', name: 'main', ext: 'png' }],
        // third-party namespaces
        extensions: {
          chub: { full_path: 'someone/exotic' },
          risuai: { source: ['risu'] },
          pygmalion_id: 'abc123',
        },
        // an entirely unrecognised key
        wackyFutureField: { nested: true },
      },
      topLevelStranger: 'keep me',
    });

    const edited = mergeCardData(original, { description: 'edited description' });
    const png = writeCard(CARRIER, edited);
    const readBack = readCard(png);

    expect(readBack.data.description).toBe('edited description');
    expect(readBack.data.nickname).toBe('Ex');
    expect(readBack.data.creation_date).toBe(1700000000);
    expect(readBack.data.source).toEqual(['https://example.invalid/card']);
    expect(readBack.data.group_only_greetings).toEqual(['hello group']);
    expect(readBack.data.assets).toHaveLength(1);
    expect(readBack.data.extensions.chub).toEqual({ full_path: 'someone/exotic' });
    expect(readBack.data.extensions.pygmalion_id).toBe('abc123');
    expect(readBack.data.wackyFutureField).toEqual({ nested: true });
    expect(readBack.topLevelStranger).toBe('keep me');
  });

  test('editing a card preserves group_only_greetings', () => {
    const original = readCard(sampleCard());
    // A field ST's own code never writes but preserves.
    expect(original.data.group_only_greetings).toBeDefined();

    const edited = mergeCardData(original, { name: 'Seraphina Edited' });
    const readBack = readCard(writeCard(CARRIER, edited));

    expect(readBack.data.name).toBe('Seraphina Edited');
    expect(readBack.data.group_only_greetings).toEqual(original.data.group_only_greetings!);
    expect(readBack.data.character_book?.entries).toHaveLength(4);
  });
});

describe('mergeCardData and character_book', () => {
  test('an update that omits character_book leaves the stored book intact', () => {
    // CharacterEditor's autosave field list omits it for exactly this reason.
    const original = readCard(sampleCard());
    const edited = mergeCardData(original, { description: 'edited' });

    expect(edited.data.character_book?.entries).toHaveLength(4);
    expect(edited.data.character_book).toEqual(original.data.character_book!);
  });

  test('a character_book in the update REPLACES the stored one wholesale', () => {
    // The contract the per-entry endpoints depend on. The spread is shallow, so entries
    // are not merged — which is deliberate: entries are an array, and a deep merge over
    // an array cannot express "this entry was deleted".
    //
    // The consequence is that a caller must never pass a book the client assembled. If
    // this test ever starts failing because someone deep-merged character_book, the
    // endpoints in routes/characters.ts need rethinking, not this test.
    const original = readCard(sampleCard());
    expect(original.data.character_book?.entries.length).toBeGreaterThan(1);

    const edited = mergeCardData(original, {
      character_book: {
        extensions: {},
        entries: [
          { keys: ['x'], content: 'only', enabled: true, insertion_order: 0, extensions: {} },
        ],
      },
    });

    expect(edited.data.character_book?.entries).toHaveLength(1);
    expect(edited.data.character_book?.entries[0]?.content).toBe('only');
  });

  test('a book edited through the converter survives the PNG round-trip with its unknown keys', () => {
    const original = readCard(sampleCard());
    const book = toWorldInfoBook(original.data.character_book!);

    const first = Object.keys(book.entries)[0]!;
    book.entries[first] = { ...book.entries[first]!, content: 'edited lore' };

    const edited = mergeCardData(original, {
      character_book: toCharacterBook(book, original.data.character_book!.name ?? 'Book'),
    });
    const readBack = readCard(writeCard(CARRIER, edited));

    const entries = readBack.data.character_book!.entries;
    expect(entries).toHaveLength(original.data.character_book!.entries.length);
    expect(entries.some((entry) => entry.content === 'edited lore')).toBe(true);

    // Every extension key the shipped card carried is still there, on every entry.
    original.data.character_book!.entries.forEach((before, index) => {
      for (const [key, value] of Object.entries(before.extensions ?? {})) {
        expect(entries[index]!.extensions[key]).toEqual(value);
      }
    });
  });
});

describe('writing', () => {
  test('writes both chunks with matching data and differing spec', () => {
    const card = createBlankCard('Dual');
    const png = writeCard(CARRIER, card);
    const chunks = readTextChunks(png);

    const chara = chunks.find((c) => c.keyword === 'chara')!;
    const ccv3 = chunks.find((c) => c.keyword === 'ccv3')!;
    expect(chara).toBeDefined();
    expect(ccv3).toBeDefined();

    const v2 = JSON.parse(Buffer.from(chara.text, 'base64').toString('utf8'));
    const v3 = JSON.parse(Buffer.from(ccv3.text, 'base64').toString('utf8'));

    expect(v2.spec).toBe('chara_card_v2');
    expect(v2.spec_version).toBe('2.0');
    expect(v3.spec).toBe('chara_card_v3');
    expect(v3.spec_version).toBe('3.0');
    // Payloads must be identical apart from the spec markers.
    expect({ ...v2, spec: null, spec_version: null }).toEqual({
      ...v3,
      spec: null,
      spec_version: null,
    });
  });

  test('rewriting does not accumulate duplicate chunks', () => {
    let png = sampleCard();
    for (let i = 0; i < 3; i++) {
      png = writeCard(png, readCard(png));
    }
    expect(readTextChunks(png)).toHaveLength(2);
  });

  test('survives unicode in card fields', () => {
    const card = createBlankCard('日本語');
    const merged = mergeCardData(card, {
      description: 'émoji 🎭 and “smart quotes” — plus ünïcödé',
    });
    const readBack = readCard(writeCard(CARRIER, merged));

    expect(readBack.data.name).toBe('日本語');
    expect(readBack.data.description).toBe('émoji 🎭 and “smart quotes” — plus ünïcödé');
  });
});
