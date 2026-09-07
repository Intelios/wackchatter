import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types/chat.ts';
import {
  branchNexus,
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
