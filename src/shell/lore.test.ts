import { describe, expect, test } from 'bun:test';
import type { CharacterSummary } from '@shared/types/card.ts';
import { createWorldInfoEntry, type WorldInfoEntry } from '@shared/types/worldinfo.ts';
import type {
  ActivatedEntry,
  ActivationResult,
  SkippedEntry,
  WorldInfoSource,
} from '@shared/worldinfo/activate.ts';
import { bookRows, busiestBook, CARD_BOOK, lastReplyMarks, loreMoment, whyLine } from './lore.ts';

function card(avatar: string, linkedBook?: string): CharacterSummary {
  return { avatar, name: avatar.replace('.png', ''), linkedBook } as CharacterSummary;
}

const book = (id: string, entryCount = 3) => ({ id, name: id, entryCount, modified: 0 });

function source(kind: WorldInfoSource['kind'], name: string, entries = 2): WorldInfoSource {
  const record: Record<string, WorldInfoEntry> = {};
  for (let uid = 0; uid < entries; uid++) record[String(uid)] = createWorldInfoEntry(uid);
  return { kind, name, book: { name, entries: record } };
}

function fired(
  uid: number,
  sourceName: string,
  extra: Partial<ActivatedEntry> = {},
): ActivatedEntry {
  return {
    uid,
    sourceIndex: 0,
    sourceKind: sourceName === 'Mika' ? 'embedded' : 'linked',
    sourceName,
    label: `Entry ${uid}`,
    order: 100,
    tokens: 5,
    placement: 'before',
    reason: 'keyword',
    pass: 0,
    content: 'lore',
    ...extra,
  };
}

function skipped(uid: number, sourceName: string, reason: SkippedEntry['reason']): SkippedEntry {
  return { uid, sourceIndex: 0, sourceKind: 'linked', sourceName, label: `Entry ${uid}`, reason };
}

function result(activated: ActivatedEntry[], skips: SkippedEntry[] = []): ActivationResult {
  return {
    before: '',
    after: '',
    depth: [],
    activated,
    skipped: skips,
    tokens: 0,
    budget: 0,
    budgetExhausted: false,
    passes: 1,
  };
}

describe('bookRows', () => {
  test('the card’s own book and the chat’s books come first, with the cards that link them', () => {
    const rows = bookRows(
      [book('Harbor Town'), book('Old notes')],
      [card('Mika.png', 'Harbor Town'), card('Mirei.png', 'Harbor Town'), card('Bob.png')],
      [source('embedded', 'Mika', 6), source('linked', 'Harbor Town')],
    );
    expect(rows.thisChat.map((r) => [r.id, r.isCard, r.entryCount])).toEqual([
      [CARD_BOOK, true, 6],
      ['Harbor Town', false, 3],
    ]);
    expect(rows.thisChat[1]?.cards.map((c) => c.avatar)).toEqual(['Mika.png', 'Mirei.png']);
    expect(rows.other.map((r) => r.id)).toEqual(['Old notes']);
  });
});

describe('the last reply', () => {
  const last = result(
    [fired(1, 'Harbor Town'), fired(2, 'Mika'), fired(3, 'Harbor Town')],
    [skipped(4, 'Harbor Town', 'probability'), skipped(5, 'Harbor Town', 'disabled')],
  );

  test('marks a book’s entries, never one that is only switched off', () => {
    const marks = lastReplyMarks(last, 'Harbor Town');
    expect([...marks].map(([uid, mark]) => [uid, mark.state])).toEqual([
      [4, 'skipped'],
      [1, 'fired'],
      [3, 'fired'],
    ]);
    expect([...lastReplyMarks(last, CARD_BOOK).keys()]).toEqual([2]);
  });

  test('the island names what fired and leads to the busiest book', () => {
    expect(loreMoment(last, 2)).toEqual({ count: 3, names: ['Entry 1', 'Entry 2'], more: 1 });
    expect(loreMoment(result([]))).toBeNull();
    expect(busiestBook(last)).toBe('Harbor Town');
  });
});

describe('whyLine', () => {
  const entry = (extra: Partial<WorldInfoEntry> = {}) => ({
    ...createWorldInfoEntry(1),
    key: ['tavern'],
    ...extra,
  });

  test('says which key matched and whose message it was in', () => {
    const mark = {
      state: 'fired' as const,
      entry: fired(1, 'Harbor Town', {
        matchedKey: 'tavern',
        matchedIn: { back: 0, isUser: true, name: 'Wren' },
      }),
    };
    expect(whyLine(mark, entry(), 2)).toBe('Fired: matched ‘tavern’ in your last message.');
    mark.entry.matchedIn = { back: 1, isUser: false, name: 'Mika' };
    expect(whyLine(mark, entry(), 2)).toBe('Fired: matched ‘tavern’ in Mika’s reply 1 back.');
  });

  test('says why an entry was skipped, or why it stayed quiet', () => {
    const lost = { state: 'skipped' as const, entry: skipped(1, 'Harbor Town', 'probability') };
    expect(whyLine(lost, entry({ probability: 40 }), 2)).toBe(
      'Skipped: a key matched, but it lost its 40% chance roll this turn.',
    );
    const group = { state: 'skipped' as const, entry: skipped(1, 'Harbor Town', 'group') };
    expect(whyLine(group, entry({ group: 'weather, mood' }), 2)).toBe(
      'Skipped: another entry won its group, ‘weather’.',
    );
    expect(whyLine(undefined, entry(), 2)).toBe(
      'Did not fire: none of its keys were in the last 2 messages.',
    );
    expect(whyLine(undefined, entry({ disable: true }), 2)).toBe(
      'Switched off, so it is never sent.',
    );
  });
});
