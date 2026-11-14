import { describe, expect, test } from 'bun:test';
import type { Preset } from '../types/preset.ts';
import {
  type ChatReasoningEfforts,
  COCREATOR_REASONING_TARGETS,
  type CoCreatorReasoningEfforts,
  chatReasoningEffort,
  coCreatorReasoningEffort,
  emptyCoCreatorReasoningEfforts,
  mergeChatReasoningEfforts,
  mergeCoCreatorReasoningEfforts,
  normalizeChatReasoningEfforts,
  normalizeCoCreatorReasoningEfforts,
  REASONING_EFFORT_OPTIONS,
  withReasoningEffort,
} from './reasoning.ts';

const connections = [{ id: 'a' }, { id: 'b' }] as const;
const ref = (connectionId = 'a', modelId = 'm') => ({ connectionId, modelId });

test('reasoning effort options keep the preset values and their display names', () => {
  expect(REASONING_EFFORT_OPTIONS).toEqual([
    ['auto', 'Auto'],
    ['min', 'Min'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['max', 'Max'],
  ]);
});

describe('chatReasoningEffort and withReasoningEffort', () => {
  test('absence inherits the preset; an explicit auto is a saved override', () => {
    const preset: Preset = { reasoning_effort: 'high', temperature: 0.8 };
    const efforts: ChatReasoningEfforts = { a: { m: 'auto' }, b: { m: 'low' } };
    expect(chatReasoningEffort(efforts, null)).toBeUndefined();
    expect(chatReasoningEffort(efforts, undefined)).toBeUndefined();
    expect(chatReasoningEffort(efforts, ref('missing'))).toBeUndefined();
    expect(chatReasoningEffort(efforts, ref('a', 'missing'))).toBeUndefined();
    expect(withReasoningEffort(preset, chatReasoningEffort({}, ref()))).toBe(preset);
    expect(withReasoningEffort(preset, chatReasoningEffort(efforts, ref())).reasoning_effort).toBe(
      'auto',
    );
    expect(chatReasoningEffort(efforts, ref('b'))).toBe('low');
  });

  test('a value equal to the preset still pins it, and only a reset resumes inheritance', () => {
    const preset: Preset = { reasoning_effort: 'high' };
    const pinned = mergeChatReasoningEfforts({}, { a: { m: 'high' } }, connections);
    expect(chatReasoningEffort(pinned, ref())).toBe('high');
    expect(withReasoningEffort(preset, chatReasoningEffort(pinned, ref()))).not.toBe(preset);
    const editedPreset: Preset = { ...preset, reasoning_effort: 'low' };
    expect(
      withReasoningEffort(editedPreset, chatReasoningEffort(pinned, ref())).reasoning_effort,
    ).toBe('high');

    const reset = mergeChatReasoningEfforts(pinned, { a: { m: null } }, connections);
    expect(reset).toEqual({});
    expect(chatReasoningEffort(reset, ref())).toBeUndefined();
    expect(withReasoningEffort(editedPreset, chatReasoningEffort(reset, ref()))).toBe(editedPreset);
  });

  test('defined efforts make temporary copies without changing the original preset', () => {
    const preset: Preset = {
      reasoning_effort: 'medium',
      prompts: [{ identifier: 'main', name: 'Main', content: 'Keep me.' }],
      extensions: { future: { kept: true } },
      futureSampler: 'kept',
    };
    const snapshot = structuredClone(preset);
    Object.freeze(preset);
    for (const [effort] of REASONING_EFFORT_OPTIONS) {
      const temporary = withReasoningEffort(preset, effort);
      expect(temporary).not.toBe(preset);
      expect(temporary).toEqual({ ...snapshot, reasoning_effort: effort });
      expect(temporary.prompts).toBe(preset.prompts);
      expect(temporary.extensions).toBe(preset.extensions);
    }
    expect(withReasoningEffort(preset, undefined)).toBe(preset);
    expect(preset).toEqual(snapshot);
  });

  test('model ids trim like normalizeModelRef; connection ids remain opaque', () => {
    expect(chatReasoningEffort({ a: { m: 'max' } }, ref('a', ' m '))).toBe('max');
    expect(chatReasoningEffort({ a: { m: 'max' } }, ref(' a ', 'm'))).toBeUndefined();
    expect(chatReasoningEffort({ a: { m: 'max' } }, ref('a', '  '))).toBeUndefined();
  });
});

describe('normalizeChatReasoningEfforts', () => {
  test('keeps every valid effort, trims model ids, and prunes junk and dead connections', () => {
    expect(
      normalizeChatReasoningEfforts(
        {
          a: {
            ' vendor/model ': 'auto',
            min: 'min',
            low: 'low',
            medium: 'medium',
            high: 'high',
            max: 'max',
            blank: '',
            uppercase: 'HIGH',
            reset: null,
            number: 1,
            nested: { effort: 'low' },
            '  ': 'high',
          },
          b: {},
          dead: { m: 'high' },
        },
        connections,
      ),
    ).toEqual({
      a: {
        'vendor/model': 'auto',
        min: 'min',
        low: 'low',
        medium: 'medium',
        high: 'high',
        max: 'max',
      },
    });
  });

  test('malformed maps read as empty rather than reaching the client', () => {
    for (const stored of [undefined, null, [], 'high', 4, false, { a: null }, { a: ['high'] }]) {
      expect(normalizeChatReasoningEfforts(stored, connections)).toEqual({});
    }
    expect(normalizeChatReasoningEfforts({ a: { m: 'high' } }, [])).toEqual({});
  });

  test('normalization uses own entries only and leaves the stored values untouched', () => {
    const models = Object.freeze({ ' m ': 'high', bad: null });
    const stored = Object.freeze({ a: models, dead: { m: 'max' } });
    const snapshot = structuredClone(stored);
    expect(normalizeChatReasoningEfforts(stored, connections)).toEqual({ a: { m: 'high' } });
    expect(stored).toEqual(snapshot);
    expect(normalizeChatReasoningEfforts(Object.create({ a: { m: 'high' } }), connections)).toEqual(
      {},
    );
    expect(normalizeChatReasoningEfforts({ a: Object.create({ m: 'high' }) }, connections)).toEqual(
      {},
    );
  });
});

describe('mergeChatReasoningEfforts', () => {
  test('merges both levels without replacing other models or connections', () => {
    const current: ChatReasoningEfforts = { a: { m: 'high', other: 'low' }, b: { m: 'auto' } };
    const next = mergeChatReasoningEfforts(
      current,
      { a: { ' m ': 'max', added: 'min' } },
      connections,
    );
    expect(next).toEqual({ a: { m: 'max', other: 'low', added: 'min' }, b: { m: 'auto' } });
    expect(mergeChatReasoningEfforts(next, { b: { m: 'medium' } }, connections)).toEqual({
      a: { m: 'max', other: 'low', added: 'min' },
      b: { m: 'medium' },
    });
  });

  test('only a model-level null clears; invalid or empty patches cannot wipe a map', () => {
    const current: ChatReasoningEfforts = { a: { m: 'high' }, b: { m: 'auto' } };
    for (const patch of [
      undefined,
      null,
      [],
      'low',
      0,
      false,
      {},
      { a: null },
      { a: [] },
      { a: 'low' },
      { a: {} },
      { a: { m: undefined } },
      { a: { m: 'invalid' } },
      { a: { m: { effort: 'low' } } },
      { a: { '  ': 'low' } },
      { missing: { m: 'low' } },
    ]) {
      expect(mergeChatReasoningEfforts(current, patch, connections)).toEqual(current);
    }
  });

  test('resets prune empty model maps and never create an empty connection', () => {
    const current: ChatReasoningEfforts = { a: { m: 'high', other: 'low' }, b: { m: 'auto' } };
    const reset = mergeChatReasoningEfforts(
      current,
      { a: { ' m ': null, missing: null }, b: { m: null } },
      connections,
    );
    expect(reset).toEqual({ a: { other: 'low' } });
    expect(mergeChatReasoningEfforts(reset, { a: { other: null } }, connections)).toEqual({});
    expect(mergeChatReasoningEfforts({}, { b: { absent: null } }, connections)).toEqual({});
  });

  test('an unrelated patch also prunes preferences on a deleted connection', () => {
    expect(
      mergeChatReasoningEfforts({ a: { m: 'high' }, dead: { m: 'max' } }, null, connections),
    ).toEqual({ a: { m: 'high' } });
  });

  test('neither level of the current values or patch is mutated', () => {
    const current: ChatReasoningEfforts = Object.freeze({
      a: Object.freeze({ m: 'high', other: 'low' }),
      b: Object.freeze({ m: 'auto' }),
    });
    const patch = Object.freeze({ a: Object.freeze({ ' m ': null, added: 'max' }) });
    const before = structuredClone(current);
    const patchBefore = structuredClone(patch);
    const next = mergeChatReasoningEfforts(current, patch, connections);
    expect(next).toEqual({ a: { other: 'low', added: 'max' }, b: { m: 'auto' } });
    expect(current).toEqual(before);
    expect(patch).toEqual(patchBefore);
    expect(next).not.toBe(current);
    expect(next.a).not.toBe(current.a);
    expect(connections).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

test('connection and model ids named __proto__ and constructor are ordinary own entries', () => {
  const protoId = '__proto__';
  const opaqueConnections = [{ id: protoId }, { id: 'constructor' }];
  const stored = JSON.parse(
    '{"__proto__":{"__proto__":"high","constructor":"auto"},"constructor":{"__proto__":"low","constructor":"max"}}',
  );
  const snapshot = structuredClone(stored);
  const normalized = normalizeChatReasoningEfforts(stored, opaqueConnections);
  expect(normalized).toEqual(stored);
  expect(JSON.stringify(normalized)).toBe(JSON.stringify(stored));
  expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(normalized[protoId])).toBe(Object.prototype);
  expect(Object.hasOwn(normalized, protoId)).toBe(true);
  expect(Object.hasOwn(normalized[protoId]!, protoId)).toBe(true);
  expect(mergeChatReasoningEfforts({}, stored, opaqueConnections)).toEqual(normalized);
  expect(chatReasoningEffort(normalized, ref('__proto__', '__proto__'))).toBe('high');
  expect(chatReasoningEffort(normalized, ref('constructor', 'constructor'))).toBe('max');
  expect(chatReasoningEffort({}, ref('__proto__', 'constructor'))).toBeUndefined();
  expect(chatReasoningEffort({ a: {} }, ref('a', 'constructor'))).toBeUndefined();
  expect(chatReasoningEffort(Object.create({ a: { m: 'high' } }), ref())).toBeUndefined();
  expect(chatReasoningEffort({ a: Object.create({ m: 'high' }) }, ref())).toBeUndefined();

  const patch = JSON.parse(
    '{"__proto__":{"__proto__":null,"constructor":"medium"},"constructor":{"__proto__":"min","constructor":null}}',
  );
  const merged = mergeChatReasoningEfforts(normalized, patch, opaqueConnections);
  expect(merged).toEqual(
    JSON.parse('{"__proto__":{"constructor":"medium"},"constructor":{"__proto__":"min"}}'),
  );
  expect(JSON.stringify(merged)).toBe(
    '{"__proto__":{"constructor":"medium"},"constructor":{"__proto__":"min"}}',
  );
  expect(chatReasoningEffort(merged, ref('__proto__', 'constructor'))).toBe('medium');
  expect(chatReasoningEffort(merged, ref('constructor', '__proto__'))).toBe('min');
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(merged.constructor)).toBe(Object.prototype);
  expect(Object.hasOwn(merged[protoId]!, protoId)).toBe(false);
  expect(Object.hasOwn(merged, 'constructor')).toBe(true);
  expect(stored).toEqual(snapshot);
  expect(normalized).toEqual(snapshot);
  expect(Object.hasOwn(Object.prototype, 'm')).toBe(false);
});

describe('Co-Creator reasoning effort maps', () => {
  test('each target starts empty and stays isolated from the others', () => {
    const empty = emptyCoCreatorReasoningEfforts();
    expect(Object.keys(empty)).toEqual([...COCREATOR_REASONING_TARGETS]);
    for (const target of COCREATOR_REASONING_TARGETS) {
      expect(empty[target]).toEqual({});
    }
    const afterCharacter = mergeCoCreatorReasoningEfforts(
      empty,
      { character: { a: { m: 'high' } } },
      connections,
    );
    expect(coCreatorReasoningEffort(afterCharacter, 'character', ref())).toBe('high');
    expect(coCreatorReasoningEffort(afterCharacter, 'sideChat', ref())).toBeUndefined();
    expect(coCreatorReasoningEffort(afterCharacter, 'presetAssistant', ref())).toBeUndefined();
    expect(coCreatorReasoningEffort(afterCharacter, 'presetBench', ref())).toBeUndefined();

    const afterBench = mergeCoCreatorReasoningEfforts(
      afterCharacter,
      { presetBench: { a: { m: 'auto' } } },
      connections,
    );
    expect(coCreatorReasoningEffort(afterBench, 'character', ref())).toBe('high');
    expect(coCreatorReasoningEffort(afterBench, 'presetBench', ref())).toBe('auto');

    const cleared = mergeCoCreatorReasoningEfforts(
      afterBench,
      { character: { a: { m: null } } },
      connections,
    );
    expect(coCreatorReasoningEffort(cleared, 'character', ref())).toBeUndefined();
    expect(coCreatorReasoningEffort(cleared, 'presetBench', ref())).toBe('auto');
  });

  test('normalizes malformed maps and prunes deleted connections across every target', () => {
    const stored = {
      character: { a: { ' m ': 'low' }, dead: { m: 'high' } },
      sideChat: 'invalid',
      presetAssistant: { b: { m: 'max', bad: 'nope' } },
      presetBench: null,
      unknownTarget: { a: { m: 'high' } },
    };
    const normalized = normalizeCoCreatorReasoningEfforts(stored, connections);
    expect(normalized).toEqual({
      character: { a: { m: 'low' } },
      sideChat: {},
      presetAssistant: { b: { m: 'max' } },
      presetBench: {},
    });
    expect(Object.hasOwn(normalized, 'unknownTarget')).toBe(false);
    const snapshot = structuredClone(normalized) as CoCreatorReasoningEfforts;
    expect(mergeCoCreatorReasoningEfforts(normalized, { character: null }, connections)).toEqual(
      snapshot,
    );
  });
});
