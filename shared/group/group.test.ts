import { expect, test } from 'bun:test';
import { fromChatMessage, toChatMessage } from '../chat/message.ts';
import { emptyGroup, groupProblem, memberLabel, validateGroup } from '../types/group.ts';

test('speaker identity survives message repair and swipes', () => {
  const message = {
    id: 'm',
    name: 'Alex',
    is_user: false,
    is_system: false,
    memberId: 'member-2',
    characterId: 'alex.png',
    mes: 'Hello',
    send_date: 'today',
  };
  expect(toChatMessage(fromChatMessage(message))).toMatchObject(message);
});

test('group validation rejects duplicate identities and unsafe pacing', () => {
  const a = { id: 'a', characterId: 'a.png', name: 'Alex', publicProfile: '', muted: false };
  const b = { ...a, id: 'b', characterId: 'b.png' };
  const g = { ...emptyGroup(), members: [a, b] };
  expect(validateGroup(g)).toBe(true);
  expect(memberLabel(a, g.members)).not.toBe(memberLabel(b, g.members));
  expect(validateGroup({ ...g, members: [a, a] })).toBe(false);
  expect(validateGroup({ ...g, concurrency: 100 })).toBe(false);
});

test('groupProblem names the failing constraint, never the cast generically', () => {
  const a = { id: 'a', characterId: 'a.png', name: 'Alex', publicProfile: '', muted: false };
  const b = { ...a, id: 'b', characterId: 'b.png' };
  const base = { ...emptyGroup(), members: [a, b] };
  expect(groupProblem(base)).toBe(null);

  // The number boxes commit any typed value, so every range the editor can produce must
  // come back as a sentence pointing at that field — not "choose valid settings".
  const cases: [mutate: (g: typeof base) => void, names: string][] = [
    [
      (g) => {
        g.director.maxTokens = 10000;
      },
      'output allowance',
    ],
    [
      (g) => {
        g.director.maxTokens = 100;
      },
      'output allowance',
    ],
    [
      (g) => {
        g.director.maxTokens = 1024.5;
      },
      'output allowance',
    ],
    [
      (g) => {
        g.director.contextTokens = 1024;
      },
      'context tokens',
    ],
    [
      (g) => {
        g.director.contextTokens = 4000000;
      },
      'context tokens',
    ],
    [
      (g) => {
        g.concurrency = 5;
      },
      'Simultaneous replies',
    ],
    [
      (g) => {
        g.replyLimit = 13;
      },
      'Replies per exchange',
    ],
    [
      (g) => {
        g.members = [a, { ...a, id: 'a2' }, b];
      },
      'join the cast once',
    ],
    [
      (g) => {
        g.name = '  ';
      },
      'name',
    ],
  ];
  for (const [mutate, phrase] of cases) {
    const g = structuredClone(base);
    mutate(g);
    const problem = groupProblem(g);
    expect(problem).toBeTypeOf('string');
    expect(problem).toContain(phrase);
    // validateGroup is derived from groupProblem; a disagreement here is a drift bug.
    expect(validateGroup(g)).toBe(false);
  }

  // A scene edit allows shrinking the cast below two members.
  const one = structuredClone(base);
  one.members = [a];
  expect(groupProblem(one, 0)).toBe(null);
  expect(groupProblem({ ...one, members: [] }, 1)).toContain('at least 1 character');
});
