import { describe, expect, test } from 'bun:test';
import { messageFingerprint } from '@shared/nexus/state.ts';
import type { ChatMessage } from '@shared/types/chat.ts';
import {
  messagesToHide,
  restoredSummary,
  SUMMARY_HIDDEN,
  summarisable,
  summaryCoverage,
  undoneSummary,
  withHistory,
  writtenSummary,
} from './coverage.ts';

function msg(id: string, mes: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const user = Number(id.replace(/\D/g, '')) % 2 === 0;
  return {
    id,
    name: user ? 'Wren' : 'Mika',
    is_user: user,
    is_system: false,
    mes,
    send_date: '',
    ...extra,
  };
}

const chat = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, `line ${i}`));
const prints = (list: ChatMessage[]) => list.map(messageFingerprint);
const now = new Date('2026-11-07T12:00:00Z');

describe('coverage', () => {
  test('the backlog is what comes after the last covered message', () => {
    const summary = { text: 'memory', covered: prints(chat.slice(0, 5)) };
    const coverage = summaryCoverage(chat, summary);
    expect(coverage.backlog.map((m) => m.id)).toEqual(['m5', 'm6', 'm7']);
    expect([coverage.covered, coverage.changed]).toEqual([5, 0]);
  });

  test('an edited covered message reads as changed; a deleted one costs nothing', () => {
    const summary = { text: 'memory', covered: prints(chat.slice(0, 5)) };
    const edited = chat.map((m) => (m.id === 'm2' ? { ...m, mes: 'changed' } : m));
    expect(summaryCoverage(edited, summary).changed).toBe(1);
    const deleted = chat.filter((m) => m.id !== 'm4');
    expect(summaryCoverage(deleted, summary).backlog.map((m) => m.id)).toEqual(['m5', 'm6', 'm7']);
    // An id checkpoint lost its place here and started over from the top.
  });

  test('a summary from before fingerprints is read through its checkpoint', () => {
    const coverage = summaryCoverage(chat, { text: 'old', checkpointMessageId: 'm3' });
    expect(coverage.backlog[0]?.id).toBe('m4');
    expect(coverage.fingerprints).toEqual(prints(chat.slice(0, 4)));
    expect(summaryCoverage(chat, undefined).backlog).toHaveLength(8);
  });

  test('summary-hidden messages are still read; ones you hid are not', () => {
    const list = [
      msg('m1', 'a', { is_system: true, hiddenBy: SUMMARY_HIDDEN }),
      msg('m2', 'b', { is_system: true }),
      msg('m3', '  '),
      msg('m4', ' c '),
    ];
    expect(summarisable(list).map((m) => [m.id, m.mes])).toEqual([
      ['m1', 'a'],
      ['m4', 'c'],
    ]);
  });
});

describe('versions', () => {
  test('writing adds the new messages; history keeps earlier versions for undo', () => {
    const first = writtenSummary(undefined, 'one', [], chat.slice(0, 3), now);
    expect(first.covered).toEqual(prints(chat.slice(0, 3)));
    const second = writtenSummary(
      withHistory(first),
      'two',
      first.covered ?? [],
      chat.slice(3, 5),
      now,
    );
    expect(second.covered).toHaveLength(5);
    expect(second.history?.map((v) => v.text)).toEqual(['one']);
    const undone = undoneSummary(second);
    expect(undone?.text).toBe('one');
    expect(undone?.covered).toEqual(prints(chat.slice(0, 3)));
    expect(undone?.history).toBeUndefined();
    expect(undoneSummary(first)).toBeNull();
  });
});

test('restoring a version keeps the one it replaces, so it can be undone', () => {
  const first = writtenSummary(undefined, 'one', [], chat.slice(0, 2), now);
  const second = writtenSummary(
    withHistory(first),
    'two',
    first.covered ?? [],
    chat.slice(2, 3),
    now,
  );
  const third = writtenSummary(
    withHistory(second),
    'three',
    second.covered ?? [],
    chat.slice(3, 4),
    now,
  );
  const back = restoredSummary(third, 1);
  expect(back?.text).toBe('one');
  expect(back?.covered).toEqual(prints(chat.slice(0, 2)));
  expect(back?.history?.map((v) => v.text)).toEqual(['three', 'two']);
  expect(restoredSummary(third, 5)).toBeNull();
});

test('hiding keeps the newest messages in the prompt', () => {
  const covered = prints(chat.slice(0, 6));
  expect(messagesToHide(chat, covered, 3)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  expect(messagesToHide(chat, covered, 0)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
});
