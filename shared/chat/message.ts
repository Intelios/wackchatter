/**
 * The message model, with `mes` derived rather than stored.
 *
 * SillyTavern keeps `mes` as a field alongside `swipes[swipe_id]` and has to call
 * syncMesToSwipe / syncSwipeToMes at every entry point to stop the two drifting
 * (script.js:6837, :6895). The same hazard exists one level down between the message's
 * own `extra`/`send_date`/`gen_started`/`gen_finished` and `swipe_info[swipe_id]`, which
 * is why a swiped message in ST can show the wrong model badge or timestamp.
 *
 * Here the internal shape simply has none of those fields. Text comes from
 * `swipes[swipe_id]` and metadata from `swipe_info[swipe_id]`, so there is nothing to
 * keep in step — the invariant is a property of the type, not a discipline.
 *
 * `ChatMessage` (which does carry `mes`) remains the wire and storage shape and is what
 * the assembler consumes; `toChatMessage` is the only thing that produces it, and
 * `fromChatMessage` is the only place a foreign message is repaired.
 */

import type { CardDataV2 } from '../types/card.ts';
import type { ChatMessage, MessageExtra, SwipeInfo } from '../types/chat.ts';

export interface MessageState {
  id: string;
  name: string;
  is_user: boolean;
  /** Hidden from the prompt, still shown in the transcript. */
  is_system: boolean;
  /**
   * User messages only: the persona this message was sent as. Null means no persona;
   * missing means a legacy message from before speakers were recorded. Like `name`, it
   * is captured at send time — a transcript records who you were when you wrote it.
   */
  persona_id?: string | null;
  /** Source of truth for the text. Always at least one entry. */
  swipes: string[];
  /** Always a valid index into `swipes`. */
  swipe_id: number;
  /** Always exactly `swipes.length` entries, index-parallel. */
  swipe_info: SwipeInfo[];
}

/** ISO timestamp, the format stored in SwipeInfo. */
export function timestamp(date = new Date()): string {
  return date.toISOString();
}

function blankInfo(send_date = timestamp()): SwipeInfo {
  return { send_date };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function currentText(message: MessageState): string {
  return message.swipes[message.swipe_id] ?? '';
}

export function currentInfo(message: MessageState): SwipeInfo {
  return message.swipe_info[message.swipe_id] ?? blankInfo();
}

export function swipeCount(message: MessageState): number {
  return message.swipes.length;
}

/** Only the last assistant message is swipeable, matching SillyTavern. */
export function isSwipeable(message: MessageState): boolean {
  return !message.is_user;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Project to the storage/wire shape. The only producer of `mes`. */
export function toChatMessage(message: MessageState): ChatMessage {
  const info = currentInfo(message);
  const result: ChatMessage = {
    id: message.id,
    name: message.name,
    is_user: message.is_user,
    is_system: message.is_system,
    mes: currentText(message),
    send_date: info.send_date,
    swipes: [...message.swipes],
    swipe_id: message.swipe_id,
    swipe_info: message.swipe_info.map((entry) => ({ ...entry })),
  };

  // Null is a real value — "sent with no persona" — so the key cannot be dropped by a
  // truthiness check; only a missing (legacy) speaker omits it.
  if (message.persona_id !== undefined) result.persona_id = message.persona_id;

  if (info.gen_started !== undefined) result.gen_started = info.gen_started;
  if (info.gen_finished !== undefined) result.gen_finished = info.gen_finished;
  if (info.extra !== undefined) result.extra = { ...info.extra };

  return result;
}

/** The loose, possibly-inconsistent form of a MessageState — a DB row or foreign JSON. */
export interface LooseMessageState {
  id: string;
  name: string;
  is_user?: unknown;
  is_system?: unknown;
  persona_id?: unknown;
  swipes?: unknown;
  swipe_id?: unknown;
  swipe_info?: unknown;
  /** Used only to fill a missing send_date. */
  fallbackDate?: string;
}

/**
 * Repair a loose message into a valid MessageState: at least one swipe, an in-range
 * index, and a swipe_info array of exactly matching length.
 *
 * This is the single normalisation point. Every read path funnels through it, so a
 * hand-edited database or a future schema change cannot produce a message the rest of
 * the module has to defend against.
 */
export function normalizeState(input: LooseMessageState): MessageState {
  const swipes = Array.isArray(input.swipes)
    ? input.swipes.filter((swipe): swipe is string => typeof swipe === 'string')
    : [];

  // A message must always have somewhere to put its text.
  if (swipes.length === 0) swipes.push('');

  const rawId = typeof input.swipe_id === 'number' ? input.swipe_id : 0;
  const swipe_id = Math.min(Math.max(Math.trunc(rawId), 0), swipes.length - 1);

  const stored = Array.isArray(input.swipe_info) ? input.swipe_info : [];
  const fallback = input.fallbackDate || timestamp();
  const swipe_info: SwipeInfo[] = swipes.map((_, index) => {
    const entry = stored[index];
    return entry && typeof entry === 'object'
      ? { ...(entry as SwipeInfo), send_date: (entry as SwipeInfo).send_date || fallback }
      : blankInfo(fallback);
  });

  const state: MessageState = {
    id: input.id,
    name: input.name,
    is_user: Boolean(input.is_user),
    is_system: Boolean(input.is_system),
    swipes,
    swipe_id,
    swipe_info,
  };

  // Three states: a persona id, an explicit null ("sent with no persona"), and missing
  // (legacy, from before speakers were recorded). Anything else — an empty string from
  // the storage encoding, a number from foreign JSON — normalises toward one of those:
  // blank means none, garbage means unknown.
  if (typeof input.persona_id === 'string') state.persona_id = input.persona_id || null;
  else if (input.persona_id === null) state.persona_id = null;

  return state;
}

/**
 * Adopt a stored or foreign `ChatMessage`, repairing any inconsistency.
 *
 * Where a stored `mes` disagrees with `swipes[swipe_id]`, `mes` wins: it is what the user
 * last saw on screen. The same applies to the top-level timestamps and `extra`, which
 * belong to whichever swipe is currently showing.
 */
export function fromChatMessage(message: ChatMessage): MessageState {
  const state = normalizeState({
    ...message,
    // A message with no swipe array at all is a single-take message.
    swipes: Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes],
    fallbackDate: message.send_date,
  });

  const swipes = [...state.swipes];
  if (typeof message.mes === 'string' && swipes[state.swipe_id] !== message.mes) {
    swipes[state.swipe_id] = message.mes;
  }

  const swipe_info = [...state.swipe_info];
  const active: SwipeInfo = { ...swipe_info[state.swipe_id]! };
  if (message.send_date) active.send_date = message.send_date;
  if (message.gen_started !== undefined) active.gen_started = message.gen_started;
  if (message.gen_finished !== undefined) active.gen_finished = message.gen_finished;
  if (message.extra !== undefined) active.extra = { ...active.extra, ...message.extra };
  swipe_info[state.swipe_id] = active;

  return { ...state, swipes, swipe_info };
}

// ---------------------------------------------------------------------------
// Mutation — all pure, all preserving the invariant by construction
// ---------------------------------------------------------------------------

/** Replace the current swipe's text, optionally merging metadata into its info. */
export function setText(
  message: MessageState,
  text: string,
  info?: Partial<SwipeInfo> & { extra?: MessageExtra },
): MessageState {
  const swipes = [...message.swipes];
  swipes[message.swipe_id] = text;

  const swipe_info = [...message.swipe_info];
  const previous = swipe_info[message.swipe_id] ?? blankInfo();
  swipe_info[message.swipe_id] = {
    ...previous,
    ...info,
    extra: info?.extra ? { ...previous.extra, ...info.extra } : previous.extra,
  };

  return { ...message, swipes, swipe_info };
}

/** Show a different existing swipe. Out-of-range indices are ignored. */
export function selectSwipe(message: MessageState, index: number): MessageState {
  if (index < 0 || index >= message.swipes.length || index === message.swipe_id) {
    return message;
  }
  return { ...message, swipe_id: index };
}

/** Append a new swipe and select it. */
export function appendSwipe(
  message: MessageState,
  text: string,
  info: SwipeInfo = blankInfo(),
): MessageState {
  return {
    ...message,
    swipes: [...message.swipes, text],
    swipe_info: [...message.swipe_info, info],
    swipe_id: message.swipes.length,
  };
}

/**
 * Append extra takes WITHOUT moving the selection, unlike `appendSwipe`.
 *
 * This is where a multi-choice generation lands its spare completions. The reader is
 * already looking at the reply that streamed in, so the selection has to stay where it
 * is; the extras sit behind it as alternates to swipe into.
 */
export function appendAlternates(
  message: MessageState,
  alternates: { text: string; info?: SwipeInfo }[],
): MessageState {
  if (alternates.length === 0) return message;

  return {
    ...message,
    swipes: [...message.swipes, ...alternates.map((alternate) => alternate.text)],
    swipe_info: [
      ...message.swipe_info,
      ...alternates.map((alternate) => alternate.info ?? blankInfo()),
    ],
  };
}

/**
 * Drop a swipe, keeping the selection sensible. The last remaining swipe is emptied
 * rather than removed, since a message must always have at least one.
 */
export function removeSwipe(message: MessageState, index: number): MessageState {
  if (index < 0 || index >= message.swipes.length) return message;

  if (message.swipes.length === 1) {
    return setText(message, '');
  }

  const swipes = message.swipes.filter((_, i) => i !== index);
  const swipe_info = message.swipe_info.filter((_, i) => i !== index);
  // Removing at or before the selection shifts it back by one.
  const swipe_id = Math.min(
    message.swipe_id > index ? message.swipe_id - 1 : message.swipe_id,
    swipes.length - 1,
  );

  return { ...message, swipes, swipe_info, swipe_id };
}

/** Collapse to a single empty swipe. This is what regenerate does: alternates are lost. */
export function resetSwipes(message: MessageState): MessageState {
  return { ...message, swipes: [''], swipe_id: 0, swipe_info: [blankInfo()] };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function userMessage(
  id: string,
  name: string,
  text: string,
  personaId: string | null,
): MessageState {
  return {
    id,
    name,
    is_user: true,
    is_system: false,
    persona_id: personaId,
    swipes: [text],
    swipe_id: 0,
    swipe_info: [blankInfo()],
  };
}

/** An assistant message with a single empty swipe, ready to be streamed into. */
export function assistantPlaceholder(id: string, name: string): MessageState {
  return {
    id,
    name,
    is_user: false,
    is_system: false,
    swipes: [''],
    swipe_id: 0,
    swipe_info: [{ send_date: timestamp(), gen_started: timestamp() }],
  };
}

/**
 * Every greeting the card offers, in the order they become swipes.
 *
 * Exported so a reader can be counted against this list without building a message —
 * `creatorNotes` lines a card's scenario notes up with it. Macros stay unresolved.
 */
export function greetingTexts(card: CardDataV2): string[] {
  const alternates = Array.isArray(card.alternate_greetings)
    ? card.alternate_greetings.filter(
        (greeting): greeting is string => typeof greeting === 'string',
      )
    : [];

  const greetings = [card.first_mes ?? '', ...alternates];
  // An empty first_mes with alternates present means the card only has alternates.
  if (!greetings[0] && greetings.length > 1) greetings.shift();
  return greetings;
}

/**
 * The opening message of a new chat: `first_mes` as swipe 0 with each alternate greeting
 * as a subsequent swipe, exactly as SillyTavern's getFirstMessage does (script.js:7651).
 * Macros are left unresolved — the assembler substitutes them at materialisation time.
 */
export function greetingMessage(id: string, card: CardDataV2): MessageState {
  const swipes = greetingTexts(card);

  const now = timestamp();
  return {
    id,
    name: card.name,
    is_user: false,
    is_system: false,
    swipes,
    swipe_id: 0,
    swipe_info: swipes.map(() => blankInfo(now)),
  };
}
