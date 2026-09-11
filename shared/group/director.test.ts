import { expect, test } from 'bun:test';
import type { TokenCounter } from '../prompt/token-cache.ts';
import type { ApiMessage, ChatMessage } from '../types/chat.ts';
import { emptyGroup, type GroupMember, type GroupScene, memberLabel } from '../types/group.ts';
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

/** One token per character, with the real ChatML envelope — additive, like production. */
const counted: TokenCounter = {
  countText: (text) => text.length,
  countChat: (messages) =>
    3 +
    messages.reduce(
      (total, m) => total + 3 + m.role.length + m.content.length + (m.name ? m.name.length + 1 : 0),
      0,
    ),
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

test('parseDirector strips an inline thinking block before reading the reply', () => {
  // Proxies of reasoning models often leave <think> in the content. When the thought
  // muses with JSON shapes, the first-{-to-last-} read spans both and parses nothing.
  expect(
    parseDirector(
      '<think>The cast maps to {"speakers":["..."]}. Kellan just spoke, so Wren reacts.</think>\n{"speakers":["a"]}',
      ['a', 'b'],
      2,
    ),
  ).toEqual(['a']);
  // Deliberation that never made it out of the think block is still a decision.
  expect(
    parseDirector(
      '<thinking>Wren has been quiet and the hook is hers. {"speakers":["a"]}</thinking>',
      ['a', 'b'],
      2,
    ),
  ).toEqual(['a']);
});

test('parseDirector reads the structured object that answers, not a span across two', () => {
  // An example object in prose followed by the real one: first-to-last splices them
  // into one unparseable string.
  expect(
    parseDirector('For example {"speakers":["a"]} but really:\n{"speakers":["b"]}', ['a', 'b'], 2),
  ).toEqual(['b']);
  // The last object with a usable shape wins; later objects without one do not hide it.
  expect(parseDirector('{"speakers":["a"]}\n{"note":"Kellan spoke last"}', ['a', 'b'], 2)).toEqual([
    'a',
  ]);
});

test('parseDirector accepts the shapes models actually answer with', () => {
  // Singular key.
  expect(parseDirector('{"speaker":"a"}', ['a', 'b'], 2)).toEqual(['a']);
  // A bare array.
  expect(parseDirector('["a"]', ['a', 'b'], 2)).toEqual(['a']);
  // A bare quoted id.
  expect(parseDirector('"a"', ['a', 'b'], 2)).toEqual(['a']);
  // Single-quoted JSON, a small-model habit. Only tried when no double quotes exist,
  // so prose apostrophes can never corrupt a real parse.
  expect(parseDirector("{'speakers':['a']}", ['a', 'b'], 2)).toEqual(['a']);
});

test('parseDirector resolves a cast-line entry, punctuation and all', () => {
  const members = [member('a', 'Alex'), member('b', 'Bryn')];
  // Copying the whole "Name (id: …)" prefix off the Cast block.
  expect(parseDirector('{"speakers":["Alex (id: a)"]}', ['a', 'b'], 2, members)).toEqual(['a']);
  // A label with a sentence period, quoted.
  expect(parseDirector('{"speakers":["\\"Alex.\\""]}', ['a', 'b'], 2, members)).toEqual(['a']);
});

test('parseDirector rescues a mis-copied id when exactly one eligible id is close', () => {
  const uuid = '23cb4ead-b0cd-4d45-804c-8323fc841279';
  const garbled = '23cb4ead-b0cd-4d45-804c-8323fc841278'; // one hex digit off
  expect(parseDirector(`{"speakers":["${garbled}"]}`, [uuid, 'b'], 2)).toEqual([uuid]);
  // A slug id one letter off is the same slip.
  expect(parseDirector('{"speakers":["wrenn"]}', ['wren', 'bryn'], 2)).toEqual(['wren']);
  // Two near-identical ids: ambiguity resolves to nothing rather than to a guess.
  expect(() => parseDirector('{"speakers":["wren-3"]}', ['wren-1', 'wren-2'], 2)).toThrow();
  // Fuzzy rescue is for ids, not one-letter noise.
  expect(() => parseDirector('{"speakers":["m"]}', ['a'], 1)).toThrow();
});

test('parseDirector falls back to names mentioned in a plain-prose reply', () => {
  const members = [member('a', 'Alex'), member('b', 'Bryn')];
  expect(
    parseDirector('Alex should speak next, reacting to the storm.', ['a', 'b'], 2, members),
  ).toEqual(['a']);
  // Mentions in order, capped at capacity.
  expect(
    parseDirector('Bryn reacts first; Alex can jump in alongside.', ['a', 'b'], 1, members),
  ).toEqual(['b']);
  // A member who is not eligible is not a prose selection either.
  expect(() => parseDirector('Alex should speak next.', ['b'], 1, members)).toThrow();
  // And a refusal that names nobody still refuses — nothing is invented.
  expect(() =>
    parseDirector("I'm sorry, I can't pick a character for this scene.", ['a', 'b'], 2, members),
  ).toThrow('Director returned an invalid speaker selection. Continue to try again.');
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
  // A name is accepted wherever an id is, so a model never has to transcribe an id.
  expect(system.content).toContain("or the member's name");
  expect(system.content).not.toContain('Copy an id verbatim');
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

test('the output contract is the last thing the director reads', () => {
  // Models weight the tail of the instruction most; the reply shape belongs there,
  // after the cast, scenario and memory it must not get lost among.
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  const messages = directorMessages(s, [], [], ['a', 'b'], 2, 4, 'Earlier, a deal.', counted);
  const content = messages[0]!.content.trimEnd();
  expect(content.endsWith('{"speakers":["member-id"]}')).toBe(true);
  const lastLine = content.slice(content.lastIndexOf('\n') + 1);
  expect(lastLine).toContain('one line');
  expect(lastLine).toContain('no markdown fence');
});

test('director history packs newest-first, skips hidden and blank messages, labels speakers', () => {
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  const history = [
    message({ id: 'old', memberId: 'a', mes: 'Oldest' }),
    message({ id: 'blank', memberId: 'a', mes: '   ' }),
    message({ id: 'hidden', memberId: 'b', mes: 'Hidden', is_system: true }),
    message({ id: 'b2', memberId: 'b', mes: 'Middle' }),
    message({ id: 'u', is_user: true, name: 'You', mes: 'Speak up' }),
  ];
  // A budget admitting the setup plus exactly the three speakable history messages:
  // `countChat` is the envelope plus a per-message charge, so each admission costs
  // `countChat([message]) - 3` on top of `countChat([system])`. The prompt embeds the
  // pending list, so the probe reads the system prompt with the same one.
  const system = directorMessages(s, [], ['b'], ['a', 'b'], 2, 3, '', counted)[0]!;
  const setup = counted.countChat([system]);
  const perMessage = (m: ChatMessage) =>
    counted.countChat([
      { role: m.is_user ? 'user' : 'assistant', content: `${m.name}: ${m.mes}` },
    ]) - 3;
  const speakable = [history[4]!, history[3]!, history[0]!];
  const admitted = speakable.reduce((total, m) => total + perMessage(m), 0);
  const tight = {
    ...s,
    director: { ...s.director, contextTokens: s.director.maxTokens + setup + admitted },
  };
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

test('director packing matches a whole-array re-count on a long transcript', () => {
  // The running-sum read must pack exactly what counting every candidate prefix whole
  // packs: same messages, same order, same cut — the envelope makes the two identical.
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  const history = Array.from({ length: 300 }, (_, i) =>
    message({
      id: `m${i}`,
      memberId: i % 2 ? 'b' : 'a',
      mes: `line ${i} of the scene. `.repeat(6),
    }),
  );
  const long = { ...s, director: { ...s.director, contextTokens: s.director.maxTokens + 12000 } };
  const packed = directorMessages(long, history, [], ['a', 'b'], 2, 4, '', counted);
  const system = packed[0]!;
  const budget = long.director.contextTokens - long.director.maxTokens;
  const naive: ApiMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    const member = long.members.find((v) => v.id === m.memberId);
    const next: ApiMessage = {
      role: m.is_user ? 'user' : 'assistant',
      content: `${member ? memberLabel(member, long.members) : m.name}: ${m.mes}`,
    };
    if (counted.countChat([system, next, ...naive]) > budget) break;
    naive.unshift(next);
  }
  expect(packed.length).toBeGreaterThan(2); // cut by the budget, not vacuously equal
  expect(packed.slice(1)).toEqual(naive);
});

test('director packing reads each message once, not once per candidate prefix', () => {
  // 300 messages cost ~80,000 countText reads under the quadratic read; the linear read
  // is bounded by two per history message plus the system prompt's.
  const s = scene([member('a', 'Alex'), member('b', 'Bryn')]);
  const history = Array.from({ length: 300 }, (_, i) =>
    message({ id: `m${i}`, memberId: 'a', mes: `spoken line ${i} of the scene.` }),
  );
  const long = { ...s, director: { ...s.director, contextTokens: s.director.maxTokens + 60000 } };
  let reads = 0;
  const spy: TokenCounter = {
    countText: (text) => {
      reads++;
      return counted.countText(text);
    },
    countChat: (messages) => counted.countChat(messages),
  };
  directorMessages(long, history, [], ['a', 'b'], 2, 4, '', spy);
  expect(reads).toBeLessThanOrEqual(history.length * 2 + 8);
});
