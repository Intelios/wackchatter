import { describe, expect, test } from 'bun:test';
import type { Persona } from '@shared/types/chat.ts';
import {
  groupVariantsUnderBase,
  matchesPersonaQuery,
  matchPersonaByName,
  orderPersonas,
  personaDisplayName,
  recentGroupIds,
  recentPersonaId,
  variantsByBase,
  withRecentPersona,
} from './personaRoster.ts';

function persona(id: string, name: string, description = ''): Persona {
  return { id, name, description, avatar: null };
}

function variant(id: string, name: string, base: string, label: string): Persona {
  return { ...persona(id, name), variantOf: base, variantLabel: label };
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

  test('a variant is findable by its label, which is the part that differs', () => {
    expect(matchesPersonaQuery(variant('v', 'John Doe', 'j', 'Fantasy'), 'fantas')).toBe(true);
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

describe('matchPersonaByName with variants', () => {
  /** One group: John Doe, John Doe [Fantasy], John Doe [Sci-fi] — plus an unrelated persona. */
  const GROUP: Persona[] = [
    persona('j', 'John Doe', 'Accountant.'),
    variant('jf', 'John Doe', 'j', 'Fantasy'),
    variant('js', 'John Doe', 'j', 'Sci-fi'),
    persona('k', 'Kestrel', 'Courier.'),
  ];

  test('the bare shared name is ambiguous — base and variants all match it exactly', () => {
    const result = matchPersonaByName(GROUP, 'john doe');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('ambiguous');
    expect(result.ok === false && result.reason === 'ambiguous' && result.candidates).toHaveLength(
      3,
    );
  });

  test('"name label" resolves the one variant it names', () => {
    const result = matchPersonaByName(GROUP, 'John Doe Fantasy');
    expect(result.ok && result.persona.id).toBe('jf');
  });

  test('the bare label resolves the variant, uniquely within the group', () => {
    const result = matchPersonaByName(GROUP, 'sci-fi');
    expect(result.ok && result.persona.id).toBe('js');
  });

  test('the same label on two groups is ambiguous, not a coin toss', () => {
    const twice = [...GROUP, persona('w', 'Wren'), variant('wf', 'Wren', 'w', 'Fantasy')];
    const result = matchPersonaByName(twice, 'fantasy');
    expect(result.ok === false && result.reason).toBe('ambiguous');
  });

  test('an unrelated persona still resolves exactly, a group prefix is still ambiguous', () => {
    const exact = matchPersonaByName(GROUP, 'kestrel');
    expect(exact.ok && exact.persona.id).toBe('k');

    const prefix = matchPersonaByName(GROUP, 'john');
    expect(prefix.ok === false && prefix.reason).toBe('ambiguous');
  });
});

describe('groupVariantsUnderBase', () => {
  const rows: Persona[] = [
    persona('a', 'Aria Vance'),
    persona('j', 'John Doe'),
    variant('jf', 'John Doe', 'j', 'Fantasy'),
    variant('js', 'John Doe', 'j', 'Sci-fi'),
    persona('k', 'Kestrel'),
  ];

  test('variants leave their alphabetical slot and follow their base', () => {
    const ids = groupVariantsUnderBase(rows).map((p) => p.id);
    expect(ids).toEqual(['a', 'j', 'jf', 'js', 'k']);
  });

  test('siblings are ordered by label, not by name or arrival', () => {
    const scrambled: Persona[] = [
      persona('j', 'John Doe'),
      variant('jz', 'John Doe', 'j', 'Zombie'),
      variant('jf', 'John Doe', 'j', 'Fantasy'),
    ];
    expect(groupVariantsUnderBase(scrambled).map((p) => p.id)).toEqual(['j', 'jf', 'jz']);
  });

  test('a base that is not in the list leaves its variant standing alone', () => {
    // The base was hoisted into "Recent", or deleted: either way the list the roster
    // renders does not contain it, and the variant must not vanish with it.
    const withoutBase = rows.filter((p) => p.id !== 'j');
    expect(groupVariantsUnderBase(withoutBase).map((p) => p.id)).toEqual(['a', 'jf', 'js', 'k']);
  });

  test('a chain — only possible through a hand edit — degrades to standalone rows', () => {
    const chained: Persona[] = [
      persona('j', 'John Doe'),
      variant('j1', 'John Doe', 'j', 'Fantasy'),
      variant('j2', 'John Doe', 'j1', 'Sci-fi'), // points at a variant, not a base
    ];
    expect(groupVariantsUnderBase(chained).map((p) => p.id)).toEqual(['j', 'j1', 'j2']);
  });

  test('no variants, no change — the input order is its own answer', () => {
    expect(groupVariantsUnderBase(LIBRARY)).toEqual(LIBRARY);
  });
});

describe('variantsByBase', () => {
  const rows: Persona[] = [
    persona('a', 'Aria Vance'),
    persona('j', 'John Doe'),
    variant('jz', 'John Doe', 'j', 'Zombie'),
    variant('jf', 'John Doe', 'j', 'Fantasy'),
    persona('k', 'Kestrel'),
  ];

  test('groups each base\u2019s variants, label-sorted', () => {
    const groups = variantsByBase(rows);
    expect(groups.get('j')?.map((p) => p.id)).toEqual(['jf', 'jz']);
  });

  test('a base without variants has no entry', () => {
    const groups = variantsByBase(rows);
    expect(groups.has('a')).toBe(false);
    expect(groups.has('k')).toBe(false);
  });

  test('a variant whose base is not in the list is nobody\u2019s child', () => {
    const groups = variantsByBase(rows.filter((p) => p.id !== 'j'));
    expect(groups.size).toBe(0);
  });
});

describe('recentPersonaId', () => {
  const library: Persona[] = [
    persona('j', 'John Doe'),
    variant('jf', 'John Doe', 'j', 'Fantasy'),
    persona('k', 'Kestrel'),
  ];

  test('a variant bumps its base — recents list people, not flavours', () => {
    expect(recentPersonaId(library, 'jf')).toBe('j');
  });

  test('a base is itself, an unknown id is itself', () => {
    expect(recentPersonaId(library, 'j')).toBe('j');
    expect(recentPersonaId(library, 'k')).toBe('k');
    expect(recentPersonaId(library, 'ghost')).toBe('ghost');
  });

  test('a variant whose base is gone falls back to itself, not to a dead id', () => {
    // Pushing a dead base id would waste a capped slot in settings that nothing renders
    // and nothing cleans up — the same starvation cascadePersonaDelete exists to prevent.
    const orphaned = [variant('jf', 'John Doe', 'j', 'Fantasy'), persona('k', 'Kestrel')];
    expect(recentPersonaId(orphaned, 'jf')).toBe('jf');
  });
});

describe('recentGroupIds', () => {
  const library: Persona[] = [
    persona('a', 'Aria Vance'),
    persona('j', 'John Doe'),
    variant('jf', 'John Doe', 'j', 'Fantasy'),
    variant('js', 'John Doe', 'j', 'Sci-fi'),
  ];

  test('maps legacy variant ids onto their base and dedupes, keeping order', () => {
    expect(recentGroupIds(library, ['jf', 'a', 'j', 'js'])).toEqual(['j', 'a']);
  });

  test('an empty list stays empty', () => {
    expect(recentGroupIds(library, [])).toEqual([]);
  });
});

describe('personaDisplayName', () => {
  test('a plain persona is just its name', () => {
    expect(personaDisplayName(persona('j', 'John Doe'))).toBe('John Doe');
  });

  test('a variant carries its label in brackets — the plain-text twin of the roster chip', () => {
    expect(personaDisplayName(variant('jf', 'John Doe', 'j', 'Fantasy'))).toBe(
      'John Doe (Fantasy)',
    );
  });

  test('a variant without a label falls back to the bare name', () => {
    expect(personaDisplayName({ ...persona('jf', 'John Doe'), variantOf: 'j' })).toBe('John Doe');
  });
});
