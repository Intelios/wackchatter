import { expect, test } from 'bun:test';
import { GroupCoordinator, type GroupJob } from './coordinator.ts';
import { groupReducer, initialGroupState, persistedGroupMessages } from './groupReducer.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('overlap is bounded, preparation ordered, new input invalidates stale director', async () => {
  const selections: ReturnType<typeof deferred<string[]>>[] = [];
  const replies: ReturnType<typeof deferred<void>>[] = [];
  const prepared: GroupJob[] = [];
  const c = new GroupCoordinator({
    limits: () => ({ concurrency: 2, replyLimit: 4 }),
    eligible: () => ['a', 'b', 'c'],
    select: async () => {
      const d = deferred<string[]>();
      selections.push(d);
      return d.promise;
    },
    prepare: async (job) => {
      prepared.push(job);
      const d = deferred<void>();
      replies.push(d);
      return () => d.promise;
    },
    changed() {},
    error() {},
  });
  c.start();
  selections[0]!.resolve(['a', 'b']);
  await tick();
  expect(prepared.map((j) => j.memberId)).toEqual(['a', 'b']);
  expect(c.jobs.size).toBe(2);
  c.start();
  expect(selections.length).toBe(1);
  replies[1]!.resolve();
  await tick();
  expect(selections.length).toBe(2);
  c.start();
  selections[1]!.resolve(['c']);
  await tick();
  expect(prepared.length).toBe(2);
  c.pause();
  replies[0]!.resolve();
  await tick();
  expect(c.jobs.size).toBe(0);
  await c.close();
});

test('failure pauses without retries and keeps sibling running', async () => {
  let calls = 0;
  let errors = 0;
  const sibling = deferred<void>();
  const c = new GroupCoordinator({
    limits: () => ({ concurrency: 2, replyLimit: 4 }),
    eligible: () => ['a', 'b'],
    select: async () => {
      calls++;
      return ['a', 'b'];
    },
    prepare: async (j) => async () => {
      if (j.memberId === 'a') throw new Error('429');
      await sibling.promise;
    },
    changed() {},
    error() {
      errors++;
    },
  });
  c.start();
  await tick();
  expect(errors).toBe(1);
  expect(c.running).toBe(false);
  expect(c.jobs.size).toBe(1);
  sibling.resolve();
  await tick();
  expect(calls).toBe(1);
  await c.close();
});

test('concurrent settlements and saves retain intervening user text', () => {
  let s = initialGroupState;
  s = groupReducer(s, {
    type: 'group/start',
    jobId: 'a',
    memberId: 'a',
    characterId: 'a.png',
    name: 'A',
    mode: 'send',
  });
  s = groupReducer(s, {
    type: 'group/start',
    jobId: 'b',
    memberId: 'b',
    characterId: 'b.png',
    name: 'B',
    mode: 'send',
  });
  s = groupReducer(s, {
    type: 'message/appendUser',
    id: 'u',
    name: 'User',
    personaId: null,
    text: 'Wait!',
  });
  expect(persistedGroupMessages(s).map((m) => m.id)).toEqual(['u']);
  s = groupReducer(s, { type: 'group/settle', jobId: 'b', text: 'B first', extra: {} });
  expect(persistedGroupMessages(s).map((m) => m.id)).toEqual(['b', 'u']);
  s = groupReducer(s, { type: 'group/settle', jobId: 'a', text: 'A later', extra: {} });
  expect(persistedGroupMessages(s).map((m) => m.id)).toEqual(['a', 'b', 'u']);
  expect(groupReducer(s, { type: 'group/settle', jobId: 'a', text: 'late', extra: {} })).toBe(s);
});
