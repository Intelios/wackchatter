import { describe, expect, test } from 'bun:test';
import type { Persona } from '@shared/types/chat.ts';
import {
  matchesPersonaQuery,
  matchPersonaByName,
  orderPersonas,
  withRecentPersona,
} from './personaRoster.ts';

function persona(id: string, name: string, description = ''): Persona {
  return { id, name, description, avatar: null };
}

/** As the server hands them over: already sorted by name. */
const LIBRARY: Persona[] = [
  persona('a', 'Aria Vance', 'Corporate fixer. Smiles first, bills later.'),
  persona('k', 'Kestrel', 'Courier, sixteen, all elbows.'),
  persona('t', 'Tamsin Vale', 'Field archaeologist, dry as a bone.'),
  persona('w', 'Wren Ashby', 'Archivist.'),
];

describe('matchesPersonaQuery', () => {
  test('an empty query matches everything', () => {
    expect(LIBRARY.every((p) => matchesPersonaQuery(p, '   '))).toBe(true);
  });

  test('matches on name, case-insensitively', () => {
    expect(matchesPersonaQuery(LIBRARY[0]!, 'ARIA')).toBe(true);
  });

  test('matches on description too — you remember the person, not the label', () => {
    expect(matchesPersonaQuery(LIBRARY[2]!, 'archaeolog')).toBe(true);
  });

  test('no match is no match', () => {
    expect(matchesPersonaQuery(LIBRARY[1]!, 'zzz')).toBe(false);
  });
});

describe('orderPersonas', () => {
  test('recent comes out in recency order, not library order', () => {
    const { recent } = orderPersonas(LIBRARY, ['t', 'a']);
    expect(recent.map((p) => p.id)).toEqual(['t', 'a']);
  });

  test('the rest keeps the order it arrived in', () => {
    const { rest } = orderPersonas(LIBRARY, ['t']);
    expect(rest.map((p) => p.id)).toEqual(['a', 'k', 'w']);
  });

  test('a persona is never in both halves', () => {
    const { recent, rest } = orderPersonas(LIBRARY, ['k', 'w']);
    const ids = [...recent, ...rest].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(LIBRARY.length);
  });

  /** A deleted persona leaves its id behind in settings; it must not render as a blank row. */
  test('ids for personas that no longer exist are dropped', () => {
    const { recent, rest } = orderPersonas(LIBRARY, ['ghost', 't']);
    expect(recent.map((p) => p.id)).toEqual(['t']);
    expect(rest).toHaveLength(3);
  });

  test('a duplicated stored id does not produce the row twice', () => {
    const { recent } = orderPersonas(LIBRARY, ['t', 't', 'a']);
    expect(recent.map((p) => p.id)).toEqual(['t', 'a']);
  });

  test('the limit caps recent without losing anyone from the rest', () => {
    const { recent, rest } = orderPersonas(LIBRARY, ['t', 'a', 'k'], 2);
    expect(recent.map((p) => p.id)).toEqual(['t', 'a']);
    // 'k' was over the limit, so it belongs in the rest rather than nowhere.
    expect(rest.map((p) => p.id)).toEqual(['k', 'w']);
  });
});

describe('withRecentPersona', () => {
  test('moves an id to the front without duplicating it', () => {
    expect(withRecentPersona(['a', 'k', 't'], 't', 8)).toEqual(['t', 'a', 'k']);
  });

  test('caps the list', () => {
    expect(withRecentPersona(['a', 'k', 't'], 'w', 3)).toEqual(['w', 'a', 'k']);
  });

  test('returns the same reference when the id is already at the front', () => {
    const current = ['t', 'a'];
    expect(withRecentPersona(current, 't', 8)).toBe(current);
  });

  test('clearing the persona records nothing — "no persona" is not a persona', () => {
    const current = ['t', 'a'];
    expect(withRecentPersona(current, null, 8)).toBe(current);
  });
});

describe('matchPersonaByName', () => {
  test('resolves an exact name', () => {
    const result = matchPersonaByName(LIBRARY, 'kestrel');
    expect(result).toEqual({ ok: true, persona: LIBRARY[1]! });
  });

  test('resolves a unique prefix', () => {
    const result = matchPersonaByName(LIBRARY, 'tam');
    expect(result.ok && result.persona.id).toBe('t');
  });

  test('resolves a unique substring when no prefix matches', () => {
    const result = matchPersonaByName(LIBRARY, 'ashby');
    expect(result.ok && result.persona.id).toBe('w');
  });

  /**
   * The whole reason this returns a result type rather than a persona. Names are editable
   * and free to collide, so "which Wren?" is a question the library can genuinely pose.
   */
  test('two personas sharing a name is ambiguous, not a coin toss', () => {
    const twins = [...LIBRARY, persona('w2', 'Wren Ashby', 'A different archivist.')];
    const result = matchPersonaByName(twins, 'wren ashby');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('ambiguous');
    expect(result.ok === false && result.reason === 'ambiguous' && result.candidates).toHaveLength(
      2,
    );
  });

  test('an ambiguous prefix reports its candidates', () => {
    const result = matchPersonaByName([persona('1', 'Kes'), persona('2', 'Kestrel')], 'ke');
    expect(result.ok === false && result.reason).toBe('ambiguous');
  });

  /** An exact hit wins outright, even though the prefix rung would have been ambiguous. */
  test('exact beats a prefix that would have been ambiguous', () => {
    const result = matchPersonaByName([persona('1', 'Kes'), persona('2', 'Kestrel')], 'kes');
    expect(result.ok && result.persona.id).toBe('1');
  });

  test('an ambiguous rung stops the ladder rather than falling through', () => {
    // 'wren' is an ambiguous PREFIX of two, and a substring of the same two. It must not
    // keep descending in the hope of a rung with exactly one match.
    const twins = [persona('1', 'Wren Ashby'), persona('2', 'Wren Jules')];
    const result = matchPersonaByName(twins, 'wren');
    expect(result.ok === false && result.reason).toBe('ambiguous');
  });

  test('nothing matching is "none"', () => {
    expect(matchPersonaByName(LIBRARY, 'nobody')).toEqual({ ok: false, reason: 'none' });
  });

  test('a blank query resolves nothing rather than the first persona', () => {
    expect(matchPersonaByName(LIBRARY, '   ')).toEqual({ ok: false, reason: 'none' });
  });
});
