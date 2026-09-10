import { expect, test } from 'bun:test';
import type { TokenCounter } from '../prompt/token-cache.ts';
import type { ChatMessage } from '../types/chat.ts';
import { emptyGroup, type GroupMember, type GroupScene } from '../types/group.ts';
import {
  DIRECTOR_REASONING_EFFORT,
  directorMaxTokens,
  directorMessages,
  parseDirector,
  publicCast,
} from './director.ts';

const member = (id: string, name: string, over: Partial<GroupMember> = {}): GroupMember => ({
  id,
  characterId: `${id}.png`,
  name,
  publicProfile: '',
  muted: false,
  ...over,
});

const scene = (members: GroupMember[], over: Partial<GroupScene> = {}): GroupScene => ({
  ...emptyGroup(),
  scenario: 'A tavern at closing time.',
  members,
  ...over,
});

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm',
  name: 'Alex',
  is_user: false,
  is_system: false,
  mes: 'Hello',
  send_date: 'today',
  ...over,
});

/** One token per message, so the budget controls the count rather than the prose. */
const counted: TokenCounter = {
  countText: (text) => text.length,
  countChat: (messages) => messages.length,
};

test('parseDirector accepts verbatim ids', () => {
  expect(parseDirector('{"speakers":["a"]}', ['a', 'b'], 2)).toEqual(['a']);
  expect(parseDirector('{"speakers":["a","b"]}', ['a', 'b'], 2)).toEqual(['a', 'b']);
});

test('parseDirector recovers from model noise instead of pausing', () => {
  // Case is a model's habit, not a directed choice.
  expect(parseDirector('{"speakers":["A"]}', ['a'], 1)).toEqual(['a']);
  // Prose around the JSON is trimmed by looseParseJson.
  expect(parseDirector('Wren should speak.\n{"speakers":["a"]}', ['a'], 1)).toEqual(['a']);
  // Fenced blocks are standard model output.
  expect(parseDirector('```json\n{"speakers":["a"]}\n```', ['a'], 1)).toEqual(['a']);
  // Unknown entries drop out and the valid remainder still directs the scene.
  expect(parseDirector('{"speakers":["ghost","a"]}', ['a'], 2)).toEqual(['a']);
  // Duplicates are one speaker, not two.
  expect(parseDirector('{"speakers":["a","a","b"]}', ['a', 'b'], 2)).toEqual(['a', 'b']);
  // Never more than the exchange can run at once.
  expect(parseDirector('{"speakers":["a","b","c"]}', ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
});

test('parseDirector resolves a cast label back to its id', () => {
  const members = [member('a', 'Alex'), member('b', 'Bryn')];
  expect(parseDirector('{"speakers":["Alex"]}', ['a', 'b'], 2, members)).toEqual(['a']);
  expect(parseDirector('{"speakers":["Bryn"]}', ['a', 'b'], 2, members)).toEqual(['b']);
  // Duplicate names are disambiguated by the bracketed label the cast block prints.
  const namesakes = [member('w1', 'Wren'), member('w2', 'Wren')];
  expect(publicCast(scene(namesakes))).toContain('Wren [w2] (id: w2)');
  expect(parseDirector('{"speakers":["Wren [w2]"]}', ['w1', 'w2'], 2, namesakes)).toEqual(['w2']);
  // A label for a member who is not eligible is not a selection.
  expect(() => parseDirector('{"speakers":["Alex"]}', ['b'], 1, members)).toThrow();
});

test('parseDirector throws only when nothing usable survives', () => {
  expect(() => parseDirector('{"speakers":[]}', ['a'], 2)).toThrow();
  expect(() => parseDirector('{"speakers":["ghost"]}', ['a'], 2)).toThrow();
  expect(() => parseDirector('{"speakers":"a"}', ['a'], 2)).toThrow();
  expect(() => parseDirector('no json at all', ['a'], 2)).toThrow();
  // An id that is not eligible (muted, or already replying) is not a usable selection.
  expect(() => parseDirector('{"speakers":["m"]}', ['a'], 1)).toThrow();
});

test('an empty selection is an error, not a silent pause', () => {
  // The whole point of the refinement: the director cannot stop the exchange by returning
  // nothing. The coordinator's silent-pause branch must be unreachable from a valid reply.
  expect(() => parseDirector('{"speakers":[]}', ['a', 'b'], 2)).toThrow(
    'Director returned an invalid speaker selection. Continue to try again.',
  );
});

test('new groups get an output allowance that cannot truncate the JSON reply', () => {
  // 1024 was small enough that a model writing any prose before its JSON ran out mid-object.
  expect(emptyGroup().director.maxTokens).toBe(2048);
});

test('the director buys thinking room so reasoning cannot eat the speaker JSON', () => {
  const director = { connectionId: '', model: '', maxTokens: 2048, contextTokens: 16384 };
  const openai = { provider: 'custom' as const, model: 'gpt-5' };
  // The output allowance plus auto's headroom, which is not "never think".
  expect(DIRECTOR_REASONING_EFFORT).toBe('auto');
  expect(directorMaxTokens(director, openai)).toBe(2048 + 8192);
  expect(directorMaxTokens(director, null)).toBe(2048 + 8192);
  // Claude on OpenRouter adds its own thinking budget, so the reply travels alone.
  expect(
    directorMaxTokens(director, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }),
  ).toBe(2048);
  // The headroom clamps to the declared context's slack, and a context with no slack still
  // asks for the full reply budget.
  expect(directorMaxTokens({ ...director, contextTokens: 2048 + 128 + 1000 }, openai)).toBe(
    2048 + 1000,
  );
  expect(directorMaxTokens({ ...director, contextTokens: 2048 }, openai)).toBe(2048);
});

test('director prompt demands a speaker and offers no pause escape', () => {
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  const messages = directorMessages(s, [], [], ['a', 'b'], 2, 4, 'Earlier, a deal.', counted);
  const system = messages[0]!;
  expect(system.role).toBe('system');
  expect(system.content).toContain('always name at least one');
  expect(system.content).toContain('An empty array is not a valid reply');
  expect(system.content).toContain('no prose and no markdown fence');
  expect(system.content).toContain('Copy an id verbatim');
  expect(system.content).not.toContain('empty array pauses');
  // Capacity and remaining ride in the prompt so the model's bound matches the scheduler's.
  expect(system.content).toContain('at most 2 distinct eligible members');
  expect(system.content).toContain('There are 4 replies left in this exchange.');
  expect(system.content).toContain('Eligible IDs: ["a","b"]');
  expect(system.content).toContain('Alex (id: a)');
  expect(system.content).toContain('Bryn (id: b)');
  expect(system.content).toContain('A tavern at closing time.');
  expect(system.content).toContain('Earlier, a deal.');
});

test('director history packs newest-first, skips hidden and blank messages, labels speakers', () => {
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  // Small budget: room for the system prompt plus exactly three history messages.
  const tight = { ...s, director: { ...s.director, contextTokens: s.director.maxTokens + 4 } };
  const history = [
    message({ id: 'old', memberId: 'a', mes: 'Oldest' }),
    message({ id: 'blank', memberId: 'a', mes: '   ' }),
    message({ id: 'hidden', memberId: 'b', mes: 'Hidden', is_system: true }),
    message({ id: 'b2', memberId: 'b', mes: 'Middle' }),
    message({ id: 'u', is_user: true, name: 'You', mes: 'Speak up' }),
  ];
  const messages = directorMessages(tight, history, ['b'], ['a', 'b'], 2, 3, '', counted);
  // Blank and hidden messages take no slot, and the packed window stops at the budget.
  expect(messages.map((m) => m.content)).toEqual([
    expect.stringContaining('You direct a shared fictional roleplay scene'),
    'Alex: Oldest',
    'Bryn: Middle',
    'You: Speak up',
  ]);
  expect(messages.slice(1).map((m) => m.role)).toEqual(['assistant', 'assistant', 'user']);
});
