import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types/chat.ts';
import {
  branchNexus,
  describeRevisionChange,
  emptyNexus,
  evidenceFor,
  liveRecords,
  migrateMemories,
  reviseRecord,
} from './state.ts';
import type { NexusRecord, NexusRevision } from './types.ts';

const message = (id: string, mes: string): ChatMessage => ({
  id,
  mes,
  name: 'Joe',
  is_user: false,
  is_system: false,
  send_date: '',
});
const messages = [message('a', 'I live in London.'), message('b', 'I moved to Paris.')];
const version = (index: number, text: string): NexusRevision => ({
  text,
  kind: 'fact',
  assertion: 'claim',
  status: 'active',
  nodeIds: [],
  evidence: [evidenceFor(messages[index]!)],
  anchorId: messages[index]!.id,
  created: index,
  enabled: true,
  pinned: false,
  deleted: false,
  manual: false,
  cues: [],
});
const record: NexusRecord = {
  id: 'residence',
  revisions: [version(0, 'Joe lives in London.'), version(1, 'Joe now lives in Paris.')],
};

describe('Nexus evidence and revisions', () => {
  test('a changed or hidden source cannot reintroduce an abandoned swipe', () => {
    const nexus = { ...emptyNexus(), records: [record] };
    expect(liveRecords(nexus, messages)[0]?.revision.text).toContain('Paris');
    expect(
      liveRecords(nexus, [messages[0]!, message('b', 'I stayed in London.')])[0]?.revision.text,
    ).toContain('London');
    expect(
      liveRecords(
        nexus,
        messages.map((m) => ({ ...m, is_system: true })),
      ),
    ).toHaveLength(0);
  });
  test('manual edits and tombstones are preserved', () => {
    const nexus = reviseRecord(
      { ...emptyNexus(), records: [record] },
      record.id,
      { text: 'A correction', deleted: true },
      'b',
    );
    expect(nexus.records[0]?.revisions).toHaveLength(3);
    expect(liveRecords(nexus, messages)).toHaveLength(0);
    expect(nexus.records[0]?.revisions.at(-1)?.manual).toBe(true);
  });
  test('branch keeps earlier revision, remaps evidence, and drops future manual additions', () => {
    const nexus = {
      ...emptyNexus(),
      records: [
        record,
        { id: 'manual', revisions: [{ ...version(1, 'Future'), manual: true, evidence: [] }] },
      ],
    };
    const next = branchNexus(nexus, new Map([['a', 'branch-a']]));
    expect(next.records).toHaveLength(1);
    expect(next.records[0]?.revisions).toHaveLength(1);
    expect(next.records[0]?.revisions[0]?.evidence[0]?.messageId).toBe('branch-a');
  });
  test('legacy events preserve flags and text; do not change transcript visibility', () => {
    const before = JSON.stringify(messages);
    const nexus = migrateMemories(
      [
        {
          id: 'old',
          title: 'Move',
          text: 'Joe moved.',
          keywords: ['Joe'],
          source: 'generated',
          edited: true,
          enabled: false,
          pinned: true,
          generatedAt: 0,
          range: { startId: 'a', endId: 'b' },
        },
      ],
      messages,
    );
    expect(nexus.records[0]?.revisions[0]).toMatchObject({
      text: 'Joe moved.',
      manual: true,
      pinned: true,
      enabled: false,
      legacy: true,
    });
    expect(JSON.stringify(messages)).toBe(before);
  });
  test('migrated legacy events carry a real created timestamp', () => {
    const memory = (id: string, generatedAt: number) => ({
      id,
      title: id,
      text: 'Joe moved.',
      keywords: [],
      source: 'generated' as const,
      edited: false,
      enabled: true,
      pinned: false,
      generatedAt,
      range: { startId: 'a', endId: 'b' },
    });
    const nexus = migrateMemories(
      [memory('stamped', 1787328363137), memory('untimed', 0)],
      messages,
    );
    expect(nexus.records[0]?.revisions[0]?.created).toBe(1787328363137);
    expect(nexus.records[1]?.revisions[0]?.created).toBeGreaterThan(0);
  });
});

test('spanning descriptions are excluded at a fork, and manual corrections never expose old versions', () => {
  const spanning = {
    id: 'span',
    revisions: [{ ...version(1, 'A whole event'), evidence: messages.map(evidenceFor) }],
  };
  expect(
    branchNexus({ ...emptyNexus(), records: [spanning] }, new Map([['a', 'copy']])).records,
  ).toHaveLength(0);
  const corrected = reviseRecord(
    { ...emptyNexus(), records: [record] },
    record.id,
    { text: 'Joe corrected the claim: he lives in Rome.' },
    'b',
  );
  expect(liveRecords(corrected, [messages[0]!, message('b', 'Another swipe')])).toHaveLength(0);
});

describe('describeRevisionChange', () => {
  const base = { ...version(0, 'Joe said he grew up in London.'), created: 100 };
  test('labels each flag toggle instead of repeating unchanged text', () => {
    expect(describeRevisionChange(base, { ...base, pinned: true })).toEqual(['Pinned']);
    expect(describeRevisionChange({ ...base, pinned: true }, { ...base })).toEqual(['Unpinned']);
    expect(describeRevisionChange(base, { ...base, enabled: false })).toEqual(['Disabled']);
    expect(describeRevisionChange({ ...base, deleted: true }, { ...base })).toEqual(['Restored']);
    expect(describeRevisionChange(base, { ...base, deleted: true })).toEqual(['Deleted']);
    expect(describeRevisionChange(base, { ...base, kind: 'event' })).toEqual(['Kind → event']);
    expect(describeRevisionChange(base, { ...base, status: 'resolved' })).toEqual([
      'Status → resolved',
    ]);
    expect(describeRevisionChange(base, { ...base, assertion: 'fact' })).toEqual([
      'Attribution → fact',
    ]);
  });
  test('labels multi-field patches together', () => {
    expect(describeRevisionChange(base, { ...base, pinned: true, kind: 'event' })).toEqual([
      'Pinned',
      'Kind → event',
    ]);
  });
  test('labels identity, connection and evidence changes', () => {
    expect(describeRevisionChange(base, { ...base, nodeIds: ['n1'] })).toEqual([
      'Identities changed',
    ]);
    const relation = { from: 'a', to: 'b', label: 'is from' };
    expect(describeRevisionChange(base, { ...base, relation })).toEqual(['Connection changed']);
    expect(describeRevisionChange({ ...base, relation }, { ...base })).toEqual([
      'Connection removed',
    ]);
    expect(describeRevisionChange(base, { ...base, evidence: [], needsReview: false })).toEqual([
      'Reasserted',
    ]);
    expect(
      describeRevisionChange(base, { ...base, evidence: [evidenceFor(messages[1]!)] }),
    ).toEqual(['Evidence changed']);
  });
  test('text edits, first revisions and no-op patches fall back to the text row', () => {
    expect(describeRevisionChange(base, { ...base, text: 'Joe grew up in London.' })).toBeNull();
    expect(describeRevisionChange(undefined, base)).toBeNull();
    expect(describeRevisionChange(base, { ...base })).toBeNull();
  });
});
