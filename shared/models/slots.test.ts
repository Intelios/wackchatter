import { describe, expect, test } from 'bun:test';
import type { Connection } from '../providers/types.ts';
import {
  DEFAULT_MODEL_SLOTS,
  MAX_RECENT_MODELS,
  normalizeFavoriteModels,
  normalizeModelRef,
  normalizeModelSlots,
  normalizePickerGroups,
  normalizeRecentModels,
  pushRecentModel,
  resolveModelRef,
  resolveSlot,
  slotRef,
  toggleFavoriteModel,
} from './slots.ts';

const connection = (id: string, baseUrl = 'https://example.test/v1'): Connection => ({
  id,
  name: id.toUpperCase(),
  provider: 'openrouter',
  baseUrl,
});

const connections = [connection('a'), connection('b'), connection('bare', '')];

describe('normalizeModelRef', () => {
  test('keeps a well-formed ref and trims the model id', () => {
    expect(normalizeModelRef({ connectionId: 'a', modelId: ' x/y ' })).toEqual({
      connectionId: 'a',
      modelId: 'x/y',
    });
  });

  test('rejects a missing connection or a blank model', () => {
    expect(normalizeModelRef({ connectionId: '', modelId: 'm' })).toBeNull();
    expect(normalizeModelRef({ connectionId: 'a', modelId: '  ' })).toBeNull();
    expect(normalizeModelRef({ connectionId: 'a' })).toBeNull();
    expect(normalizeModelRef(null)).toBeNull();
  });

  test('with connections, a ref to a deleted connection is dropped', () => {
    expect(normalizeModelRef({ connectionId: 'gone', modelId: 'm' }, connections)).toBeNull();
    expect(normalizeModelRef({ connectionId: 'gone', modelId: 'm' })).not.toBeNull();
  });
});

test('normalizeModelSlots fills every slot and drops refs to deleted connections', () => {
  expect(
    normalizeModelSlots(
      { chat: { connectionId: 'a', modelId: 'm' }, nexus: { connectionId: 'gone', modelId: 'n' } },
      connections,
    ),
  ).toEqual({ ...DEFAULT_MODEL_SLOTS, chat: { connectionId: 'a', modelId: 'm' } });
  expect(normalizeModelSlots('junk', connections)).toEqual(DEFAULT_MODEL_SLOTS);
});

describe('recent models', () => {
  const ref = (n: number) => ({ connectionId: 'a', modelId: `m${n}` });

  test('a pick moves to the front without duplicating', () => {
    expect(pushRecentModel([ref(1), ref(2), ref(3)], ref(2))).toEqual([ref(2), ref(1), ref(3)]);
  });

  test('the list is capped', () => {
    const full = Array.from({ length: MAX_RECENT_MODELS }, (_, i) => ref(i));
    const pushed = pushRecentModel(full, ref(99));
    expect(pushed).toHaveLength(MAX_RECENT_MODELS);
    expect(pushed[0]).toEqual(ref(99));
  });

  test('normalising dedupes, caps and drops deleted connections', () => {
    const stored = [
      ref(1),
      ref(1),
      { connectionId: 'gone', modelId: 'x' },
      ...Array.from({ length: 20 }, (_, i) => ref(i + 2)),
    ];
    const recent = normalizeRecentModels(stored, connections);
    expect(recent).toHaveLength(MAX_RECENT_MODELS);
    expect(recent[0]).toEqual(ref(1));
    expect(recent[1]).toEqual(ref(2));
  });
});

describe('resolving', () => {
  test('summary and Co-Creator follow chat when unset; Nexus and side chat do not', () => {
    const slots = { ...DEFAULT_MODEL_SLOTS, chat: { connectionId: 'a', modelId: 'm' } };
    expect(slotRef(slots, 'summary')).toEqual(slots.chat);
    expect(slotRef(slots, 'cocreator')).toEqual(slots.chat);
    expect(slotRef(slots, 'nexus')).toBeNull();
    expect(slotRef(slots, 'sideChat')).toBeNull();
  });

  test('a slot of its own wins over chat', () => {
    const own = { connectionId: 'b', modelId: 'other' };
    const slots = {
      ...DEFAULT_MODEL_SLOTS,
      chat: { connectionId: 'a', modelId: 'm' },
      summary: own,
    };
    expect(slotRef(slots, 'summary')).toEqual(own);
  });

  test('a resolved model is the connection bound to the ref’s model', () => {
    const result = resolveSlot(
      {
        connections,
        models: { ...DEFAULT_MODEL_SLOTS, chat: { connectionId: 'b', modelId: 'x' } },
      },
      'chat',
    );
    expect(result.ok && result.model).toEqual({ ...connection('b'), model: 'x' });
  });

  test('every way to be unrunnable says why', () => {
    const unset = resolveSlot({ connections, models: DEFAULT_MODEL_SLOTS }, 'nexus');
    expect(unset).toEqual({ ok: false, ref: null, reason: 'Choose a Nexus model.' });

    const deleted = resolveModelRef(connections, { connectionId: 'gone', modelId: 'm' }, 'chat');
    expect(deleted.ok).toBe(false);
    expect(!deleted.ok && deleted.reason).toContain('was deleted');

    const bare = resolveModelRef(connections, { connectionId: 'bare', modelId: 'm' }, 'chat');
    expect(!bare.ok && bare.reason).toContain('no endpoint');
  });
});

describe('favourite models', () => {
  const ref = (connectionId: string, modelId: string) => ({ connectionId, modelId });

  test('normalising dedupes, keeps star order and drops refs to missing connections', () => {
    expect(
      normalizeFavoriteModels(
        [ref('b', 'x'), ref('a', 'y'), ref('b', 'x'), ref('gone', 'z'), 'junk'],
        connections,
      ),
    ).toEqual([ref('b', 'x'), ref('a', 'y')]);
    expect(normalizeFavoriteModels(null, connections)).toEqual([]);
  });

  test('toggling appends a new star and removes an existing one', () => {
    const one = toggleFavoriteModel([], ref('a', 'x'));
    const two = toggleFavoriteModel(one, ref('b', 'y'));
    expect(two).toEqual([ref('a', 'x'), ref('b', 'y')]);
    expect(toggleFavoriteModel(two, ref('a', 'x'))).toEqual([ref('b', 'y')]);
  });
});

describe('normalizePickerGroups', () => {
  test('keeps boolean entries only', () => {
    expect(normalizePickerGroups({ 'conn:a': false, 'vendor:a:openai': true, bad: 'yes' })).toEqual(
      { 'conn:a': false, 'vendor:a:openai': true },
    );
    expect(normalizePickerGroups([])).toEqual({});
    expect(normalizePickerGroups(undefined)).toEqual({});
  });
});
