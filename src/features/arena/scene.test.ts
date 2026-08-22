import { describe, expect, test } from 'bun:test';
import type { CardDataV2 } from '@shared/types/card.ts';
import { buildScene, OPENING_MESSAGE_ID, PROBE_MESSAGE_ID, sceneSeedId } from './scene.ts';

function card(overrides: Partial<CardDataV2> = {}): CardDataV2 {
  return {
    name: 'Seraphina',
    description: '',
    personality: '',
    scenario: '',
    first_mes: 'The door opens.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  };
}

describe('buildScene', () => {
  test('opening then probe, in that order', () => {
    const messages = buildScene({ card: card(), probe: 'Who are you?' });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: OPENING_MESSAGE_ID,
      is_user: false,
      name: 'Seraphina',
      mes: 'The door opens.',
    });
    expect(messages[1]).toMatchObject({
      id: PROBE_MESSAGE_ID,
      is_user: true,
      mes: 'Who are you?',
    });
  });

  test('ids are stable across builds, so the lore draw does not move under a re-roll', () => {
    const a = buildScene({ card: card(), probe: 'Hello.' });
    const b = buildScene({ card: card(), probe: 'Hello.' });

    expect(a).toEqual(b);
  });

  test('a card with no greeting produces the probe alone, not a blank opening', () => {
    // A blank message holds no depth slot; sending one would shift every regex depth bound
    // by one against a card that merely left first_mes empty.
    const messages = buildScene({ card: card({ first_mes: '   ' }), probe: 'Hello.' });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.is_user).toBe(true);
  });

  test('an alternate greeting can open the scene', () => {
    const messages = buildScene({
      card: card({ alternate_greetings: ['A different morning.'] }),
      probe: 'Hello.',
      greetingIndex: 1,
    });

    expect(messages[0]?.mes).toBe('A different morning.');
  });

  test('an out-of-range greeting index falls back to the first rather than vanishing', () => {
    const messages = buildScene({ card: card(), probe: 'Hello.', greetingIndex: 7 });

    expect(messages[0]?.mes).toBe('The door opens.');
  });

  test('the probe records the persona it was spoken as', () => {
    const messages = buildScene({ card: card(), probe: 'Hi.', personaId: 'p1' });

    expect(messages.at(-1)?.persona_id).toBe('p1');
  });

  test('no persona is recorded as an explicit null, never as missing', () => {
    // Missing means "legacy, not recorded"; null means "sent with no persona". The arena
    // always knows, so it must never produce the legacy state.
    const messages = buildScene({ card: card(), probe: 'Hi.' });

    expect(messages.at(-1)?.persona_id).toBeNull();
  });
});

describe('sceneSeedId', () => {
  test('differs per card, so two cards do not draw identical lore', () => {
    expect(sceneSeedId('a.png')).not.toBe(sceneSeedId('b.png'));
  });
});
