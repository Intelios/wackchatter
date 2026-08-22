/**
 * The scene: what both contenders are actually answering.
 *
 * A scene is a card's opening message followed by one probe line standing in for the
 * user's turn. That is the whole transcript — nothing a contender writes is ever fed back
 * in, so run five and run one are answering the identical question. It is the reason the
 * comparison means anything, and the reason this is a test bench rather than a chat.
 *
 * Message ids are FIXED rather than minted per run. World Info seeds its probability rolls
 * and group draws on the last user message id (`worldInfoForChat`'s `seedFor`), so fresh
 * uuids would re-roll the lore on every re-roll of the same scene — and a comparison that
 * was supposed to be about the model would quietly become one about which facts each run
 * happened to draw. Same argument the chat's own seeding makes.
 */

import { greetingTexts } from '@shared/chat/message.ts';
import type { CardDataV2 } from '@shared/types/card.ts';
import type { ChatMessage } from '@shared/types/chat.ts';

export const OPENING_MESSAGE_ID = 'arena-opening';
export const PROBE_MESSAGE_ID = 'arena-probe';

export interface SceneOptions {
  card: CardDataV2;
  /** The user turn. Macros are legal — assembly substitutes it like any other message. */
  probe: string;
  /**
   * Which of the card's greetings opens the scene. Out of range falls back to the first,
   * so a pool entry that outlived an edit removing an alternate still produces a scene.
   */
  greetingIndex?: number;
  /** The persona the probe was spoken as, for the transcript's speaker record. */
  personaId?: string | null;
}

/**
 * Build the two-message transcript a round is assembled from.
 *
 * The opening is omitted entirely when the card has no greeting worth showing, rather than
 * sent as an empty assistant turn: a blank message holds no depth slot and would shift
 * every regex depth bound by one against a card that merely left `first_mes` empty.
 */
export function buildScene(options: SceneOptions): ChatMessage[] {
  const { card, probe, greetingIndex = 0, personaId = null } = options;

  const greetings = greetingTexts(card);
  const opening = greetings[greetingIndex] ?? greetings[0] ?? '';
  const sent = new Date(0).toISOString();

  const messages: ChatMessage[] = [];

  if (opening.trim()) {
    messages.push({
      id: OPENING_MESSAGE_ID,
      name: card.name || 'Character',
      is_user: false,
      is_system: false,
      mes: opening,
      // A constant, not `Date.now()`. Nothing displays it, and a moving timestamp would
      // make two otherwise identical scenes compare unequal in tests for no reason.
      send_date: sent,
    });
  }

  messages.push({
    id: PROBE_MESSAGE_ID,
    name: 'User',
    is_user: true,
    is_system: false,
    persona_id: personaId,
    mes: probe,
    send_date: sent,
  });

  return messages;
}

/**
 * The stand-in chat id for a scene.
 *
 * World Info's seed is `chatId` + the last user message id, and the message id is constant
 * here — so this is what keeps two different cards from drawing identical lore while
 * keeping one card's draw stable across re-rolls.
 */
export function sceneSeedId(characterId: string): string {
  return `arena:${characterId}`;
}
