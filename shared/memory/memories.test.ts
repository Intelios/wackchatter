import { describe, expect, test } from 'bun:test';
import type { ChatMessage, Memory } from '../types/chat.ts';
import type { DraftMemory } from './extract.ts';
import {
  autoExtractDue,
  coveredMessageIds,
  draftsToMemories,
  hideableMessageIds,
  markMemoriesStale,
  nextWatermark,
} from './memories.ts';

function message(id: string): ChatMessage {
  return { id, name: 'Sera', is_user: false, is_system: false, mes: id, send_date: '' };
}

const transcript = ['a', 'b', 'c', 'd', 'e', 'f'].map(message);

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    title: 'First Meeting',
    text: 'They met.',
    keywords: [],
    range: { startId: 'b', endId: 'd' },
    pinned: false,
    enabled: true,
    source: 'generated',
    edited: false,
    generatedAt: 0,
    ...overrides,
  };
}

describe('coveredMessageIds', () => {
  test('covers both endpoints', () => {
    expect(coveredMessageIds(memory(), transcript)).toEqual(['b', 'c', 'd']);
  });

  test('a deleted endpoint yields nothing rather than a guessed range', () => {
    expect(
      coveredMessageIds(memory({ range: { startId: 'gone', endId: 'd' } }), transcript),
    ).toEqual([]);
  });
});

describe('hideableMessageIds', () => {
  test('the verbatim tail is protected even when a memory covers it', () => {
    // Range b–f, tail of 3 protects d, e and f.
    const covered = memory({ range: { startId: 'b', endId: 'f' } });
    expect(hideableMessageIds(covered, transcript, 3)).toEqual(['b', 'c']);
  });

  test('a tail of zero protects nothing', () => {
    expect(hideableMessageIds(memory(), transcript, 0)).toEqual(['b', 'c', 'd']);
  });

  test('a tail longer than the chat protects everything', () => {
    expect(hideableMessageIds(memory(), transcript, 50)).toEqual([]);
  });
});

describe('draftsToMemories', () => {
  const draft: DraftMemory = {
    title: 'First Meeting',
    text: 'They met at the treeline.',
    keywords: ['Sera'],
    quotes: [],
    startId: 'b',
    endId: 'd',
  };

  test('new memories start live, unpinned and unedited', () => {
    const [made] = draftsToMemories([draft], { newId: () => 'fixed', now: 5, model: 'gpt' });
    expect(made).toMatchObject({
      id: 'fixed',
      pinned: false,
      enabled: true,
      edited: false,
      source: 'generated',
      generatedAt: 5,
      model: 'gpt',
    });
  });

  test('an empty quote list is dropped rather than stored empty', () => {
    const [made] = draftsToMemories([draft], { newId: () => 'fixed' });
    expect(made?.quotes).toBeUndefined();
  });
});

describe('markMemoriesStale', () => {
  test('marks a memory whose range contains the message', () => {
    const next = markMemoriesStale([memory()], transcript, 'c', 'edited');
    expect(next?.[0]?.stale).toBe('edited');
  });

  test('leaves memories that do not cover the message alone', () => {
    expect(markMemoriesStale([memory()], transcript, 'f', 'edited')).toBeNull();
  });

  test('endpoints count as covered', () => {
    expect(markMemoriesStale([memory()], transcript, 'b', 'deleted')?.[0]?.stale).toBe('deleted');
  });

  test('an unknown message id changes nothing', () => {
    expect(markMemoriesStale([memory()], transcript, 'gone', 'edited')).toBeNull();
  });

  test('re-marking with the same reason is a no-op, so no revision is burned', () => {
    expect(markMemoriesStale([memory({ stale: 'edited' })], transcript, 'c', 'edited')).toBeNull();
  });
});

describe('nextWatermark', () => {
  test('advances to the end of the last memory written', () => {
    expect(nextWatermark([memory({ range: { startId: 'b', endId: 'd' } })], 'a')).toBe('d');
  });

  test('a window that produced nothing does not advance past unrecorded material', () => {
    expect(nextWatermark([], 'a')).toBe('a');
  });
});

describe('autoExtractDue', () => {
  test('fires once the backlog reaches the interval', () => {
    expect(autoExtractDue('memories', 50, 50)).toBe(true);
    expect(autoExtractDue('memories', 50, 51)).toBe(true);
  });

  test('a backlog below the interval waits', () => {
    expect(autoExtractDue('memories', 50, 49)).toBe(false);
  });

  test('an interval of 0 is the off switch, whatever is waiting', () => {
    expect(autoExtractDue('memories', 0, 500)).toBe(false);
  });

  test('only the memories mode auto-spends', () => {
    expect(autoExtractDue('classic', 50, 500)).toBe(false);
    expect(autoExtractDue('off', 50, 500)).toBe(false);
  });
});

describe('the verbatim tail is a floor, not a suggestion', () => {
  // Regression cover for the hiding contract the extraction run depends on: a memory can
  // never reach past its own range, and never into the tail. Anything hidden outside those
  // bounds did not come from a memory.
  test('a memory never hides outside its own range', () => {
    const covered = memory({ range: { startId: 'b', endId: 'c' } });
    expect(hideableMessageIds(covered, transcript, 0)).toEqual(['b', 'c']);
  });

  test('a memory covering the whole chat still leaves the tail alone', () => {
    const covered = memory({ range: { startId: 'a', endId: 'f' } });
    expect(hideableMessageIds(covered, transcript, 2)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a memory with no range hides nothing at all', () => {
    expect(hideableMessageIds(memory({ range: undefined }), transcript, 0)).toEqual([]);
  });
});
