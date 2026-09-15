import { expect, test } from 'bun:test';
import type { ChatMessage } from '../types/chat.ts';
import { applyExtraction, buildNexusExtraction, CONTRACT, parseExtraction } from './extract.ts';
import { emptyNexus, messageFingerprint } from './state.ts';
import { DEFAULT_NEXUS } from './types.ts';

const msg: ChatMessage = {
  id: 'm',
  name: 'Joe',
  mes: 'I am from London.',
  is_system: false,
  is_user: true,
  send_date: '',
};
const counter = {
  countText: (s: string) => s.length,
  countChat: (m: readonly { content: string }[]) => m.reduce((n, s) => n + s.content.length, 0),
};
test('extraction accepts overlapping facts, validates all source references, and checkpoints empty results', () => {
  const n = emptyNexus();
  const batch = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, 'Joe');
  const raw = {
    nodes: [{ ref: 'joe', name: 'Joe', kind: 'person', aliases: [], sources: [0] }],
    records: [
      {
        text: 'Joe is from London.',
        kind: 'fact',
        assertion: 'claim',
        status: 'active',
        nodeRefs: ['joe'],
        sources: [0],
        cues: ['hometown'],
      },
    ],
  };
  const parsed = parseExtraction(JSON.stringify(raw), batch, n);
  const result = applyExtraction(n, parsed, batch, 'test');
  expect(result.records).toHaveLength(1);
  expect(result.processed.m).toBe(messageFingerprint(msg));
  raw.records[0]!.sources = [9];
  expect(() => parseExtraction(JSON.stringify(raw), batch, n)).toThrow();
  const empty = applyExtraction(
    n,
    parseExtraction('{"nodes":[],"records":[]}', batch, n),
    batch,
    'test',
  );
  expect(empty.processed.m).toBe(messageFingerprint(msg));
});
test('oversized message packs in pieces without claiming the unseen end was read', () => {
  const m = { ...msg, mes: 'Long story. '.repeat(4000) };
  const batch = buildNexusExtraction(
    emptyNexus(),
    [m],
    { ...DEFAULT_NEXUS, inputTokens: 5000, outputTokens: 256 },
    counter,
    'Joe',
  );
  expect(counter.countChat(batch.messages)).toBeLessThanOrEqual(5000 - 256 - 128);
  expect(batch.progress.m).not.toBe(messageFingerprint(m));
  expect(batch.items[0]!.end).toBeLessThan(m.mes.length);
});

test('malformed, truncated, oversized and conflicting extraction cannot advance checkpoints', () => {
  const n = emptyNexus();
  const batch = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
  for (const raw of ['', '{"nodes":[],"records":[', '{}', '{"nodes":{},"records":[]}'])
    expect(() => parseExtraction(raw, batch, n)).toThrow();
  const parsed = parseExtraction('{"nodes":[],"records":[]}', batch, n);
  expect(() => applyExtraction({ ...n, paused: true }, parsed, batch, 'test')).toThrow('edited');
  expect(n.processed).toEqual({});
});
test('duplicate output cannot resurrect a manual edit, disabled record, or tombstone', () => {
  const text = 'Joe is from London.';
  const raw = {
    nodes: [],
    records: [
      {
        text,
        kind: 'fact',
        assertion: 'claim',
        status: 'active',
        nodeRefs: [],
        sources: [0],
        cues: ['hometown'],
      },
    ],
  };
  const initial = emptyNexus();
  const batch = buildNexusExtraction(initial, [msg], DEFAULT_NEXUS, counter, '');
  const extracted = applyExtraction(
    initial,
    parseExtraction(JSON.stringify(raw), batch, initial),
    batch,
    'test',
  );
  for (const flags of [{ manual: true }, { enabled: false }, { deleted: true }]) {
    const n = structuredClone(extracted);
    Object.assign(n.records[0]!.revisions[0]!, flags);
    n.processed = {};
    const retry = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
    const after = applyExtraction(n, parseExtraction(JSON.stringify(raw), retry, n), retry, 'test');
    expect(after.records[0]!.revisions).toEqual(n.records[0]!.revisions);
    expect(after.records).toHaveLength(1);
  }
});

test('the excerpt is labelled as the only evidence the model may cite', () => {
  const batch = buildNexusExtraction(emptyNexus(), [msg], DEFAULT_NEXUS, counter, '');
  const user = batch.messages.at(-1)!;
  expect(user.role).toBe('user');
  expect(
    user.content.startsWith(
      'TRANSCRIPT EXCERPT — the only evidence. Cite line numbers from this block only.\n',
    ),
  ).toBe(true);
  expect(user.content).toContain('[0] Joe: I am from London.');
});

test('a record without search cues is rejected, not silently accepted', () => {
  const n = emptyNexus();
  const batch = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
  const record = {
    text: 'Joe is from London.',
    kind: 'fact',
    assertion: 'fact',
    status: 'active',
    nodeRefs: [],
    sources: [0],
  };
  const wrap = (cues: unknown) => JSON.stringify({ nodes: [], records: [{ ...record, cues }] });
  expect(() => parseExtraction(wrap([]), batch, n)).toThrow('A memory returned no search cues.');
  expect(() => parseExtraction(wrap(undefined), batch, n)).toThrow();
  const parsed = parseExtraction(wrap(['hometown', 'origin']), batch, n);
  expect(parsed.records[0]!.revision.cues).toEqual(['hometown', 'origin']);
});

test('group and concept are valid node kinds, unknown ones still are not', () => {
  const n = emptyNexus();
  const batch = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
  const raw = {
    nodes: [
      { ref: 'guild', name: 'Vellmoor guild', kind: 'group', aliases: [], sources: [0] },
      { ref: 'bell', name: 'Sunken Bell prophecy', kind: 'concept', aliases: [], sources: [0] },
    ],
    records: [],
  };
  const parsed = parseExtraction(JSON.stringify(raw), batch, n);
  expect(parsed.nodes.map((x) => x.kind)).toEqual(['group', 'concept']);
  raw.nodes[0]!.kind = 'faction';
  expect(() => parseExtraction(JSON.stringify(raw), batch, n)).toThrow('unsupported category');
});

test('the contract’s worked example is valid against its own parser', () => {
  const second: ChatMessage = {
    ...msg,
    id: 'm2',
    name: 'Tomas',
    mes: 'The Vellmoor guild raised me.',
  };
  const batch = buildNexusExtraction(emptyNexus(), [msg, second], DEFAULT_NEXUS, counter, '');
  const example = CONTRACT.split('\n').find((l) => l.startsWith('Worked example: '));
  const parsed = parseExtraction(example!.slice('Worked example: '.length), batch, emptyNexus());
  expect(parsed.nodes.map((n) => n.ref)).toEqual(['tomas', 'vellmoor']);
  expect(parsed.records[0]!.revision.relation).toEqual({
    from: 'tomas',
    to: 'vellmoor',
    label: 'is from',
  });
});

test('a relation between new nodes survives the apply-time id remap', () => {
  const n = emptyNexus();
  const batch = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
  const raw = {
    nodes: [
      { ref: 'joe', name: 'Joe', kind: 'person', aliases: [], sources: [0] },
      { ref: 'london', name: 'London', kind: 'place', aliases: [], sources: [0] },
    ],
    records: [
      {
        text: 'Joe is from London.',
        kind: 'fact',
        assertion: 'fact',
        status: 'active',
        nodeRefs: ['joe', 'london'],
        relation: { from: 'joe', to: 'london', label: 'is from' },
        sources: [0],
        cues: ['hometown'],
      },
    ],
  };
  const after = applyExtraction(n, parseExtraction(JSON.stringify(raw), batch, n), batch, 'test');
  const [joe, london] = after.nodes;
  expect(after.records[0]!.revisions[0]!.relation).toEqual({
    from: joe!.id,
    to: london!.id,
    label: 'is from',
  });
});

test('a paraphrase over curated source and identity is disabled for review', () => {
  const initial = emptyNexus();
  const batch = buildNexusExtraction(initial, [msg], DEFAULT_NEXUS, counter, '');
  const raw = {
    nodes: [],
    records: [
      {
        text: 'Joe is from London.',
        kind: 'fact',
        assertion: 'claim',
        status: 'active',
        nodeRefs: [],
        sources: [0],
        cues: ['hometown'],
      },
    ],
  };
  const n = applyExtraction(
    initial,
    parseExtraction(JSON.stringify(raw), batch, initial),
    batch,
    'test',
  );
  n.records[0]!.revisions[0]!.deleted = true;
  n.processed = {};
  raw.records[0]!.text = 'London is where Joe says he comes from.';
  const retry = buildNexusExtraction(n, [msg], DEFAULT_NEXUS, counter, '');
  const after = applyExtraction(n, parseExtraction(JSON.stringify(raw), retry, n), retry, 'test');
  expect(after.records[1]!.revisions[0]).toMatchObject({
    enabled: false,
    status: 'conflict',
    conflicts: [n.records[0]!.id],
  });
});
