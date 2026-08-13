/**
 * Labelled card blocks inside a design reply.
 *
 * The design assistant is asked to wrap card-bound content in a fenced block whose info
 * string names the field:
 *
 *     ```card:first_mes
 *     The lamp room is cold. …
 *     ```
 *
 * That is an ordinary CommonMark info string, so nothing about it is fragile in transport,
 * and models close fences far more reliably than they close XML-ish tags. The closing rule
 * here is deliberately the same one `markdownEligibility` already implements
 * (features/chat/dialogue.ts:50-58): the closer must use the same marker and be at least as
 * long as the opener. If that rule ever changes there, it must change here too, or a block
 * and the dialogue colourer will disagree about where code ends.
 *
 * The parse result is a list of parts, not a transformed string. The bubble renders prose
 * parts through the normal `Markdown` component and block parts through `CardBlockView`,
 * which feeds the block's own text back through `Markdown` — so block content renders as
 * prose rather than as a monospace code box, and backticks *inside* a block still work,
 * because the inner text is a fresh markdown parse that knows nothing about the outer fence.
 * Nothing here ever reaches react-markdown as a `card:` code fence.
 */

import { CARD_SLOTS, type CardSlot } from '@shared/types/cocreator.ts';

export const SLOT_LABELS: Readonly<Record<CardSlot, string>> = {
  name: 'Name',
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  first_mes: 'First message',
  alternate_greeting: 'Alternate greeting',
  mes_example: 'Example dialogue',
  tags: 'Tags',
  creator_notes: 'Creator notes',
  system_prompt: 'System prompt',
  post_history_instructions: 'Post-history instructions',
};

/**
 * Labels a model plausibly writes instead of the canonical slot name.
 *
 * Every entry here is a label that would otherwise be filed as "unknown" and cost the user
 * an extra click. Coercion is only ever toward a slot the label unambiguously names — an
 * unrecognised label stays unrecognised rather than being guessed at, because filing text
 * into the wrong field is worse than asking.
 */
const SLOT_ALIASES: Readonly<Record<string, CardSlot>> = {
  greeting: 'first_mes',
  first_message: 'first_mes',
  first_msg: 'first_mes',
  opening: 'first_mes',
  opening_message: 'first_mes',
  alt_greeting: 'alternate_greeting',
  alternate_greetings: 'alternate_greeting',
  alt_greetings: 'alternate_greeting',
  example_dialogue: 'mes_example',
  example_dialog: 'mes_example',
  examples: 'mes_example',
  message_example: 'mes_example',
  notes: 'creator_notes',
  creator_note: 'creator_notes',
  tag: 'tags',
  post_history: 'post_history_instructions',
  jailbreak: 'post_history_instructions',
};

export interface CardBlock {
  /** Null when the label names no slot we know. The block still renders and is still filable. */
  slot: CardSlot | null;
  /** The label exactly as written, for the header and the unknown-label hint. */
  label: string;
  text: string;
  /** Offsets into the source message text. `source.slice(start, end) === text`. */
  start: number;
  end: number;
  /** False when the closing fence never arrived — mid-stream, or an aborted generation. */
  closed: boolean;
}

export type MessagePart = { kind: 'prose'; text: string } | { kind: 'block'; block: CardBlock };

export interface ParsedMessage {
  parts: MessagePart[];
  /** The blocks alone, in order. */
  blocks: CardBlock[];
}

/** A fence opener naming a card slot. The `card:` prefix is required. */
const CARD_OPENER = /^ {0,3}(`{3,})[ \t]*card:([^`]*)$/i;
/** Any fence opener, including plain ones we must skip over rather than scan inside. */
const ANY_OPENER = /^ {0,3}(`{3,}|~{3,})/;

function closesFence(line: string, marker: string, length: number): boolean {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === marker && run.length >= length;
}

/**
 * Fold a written label toward a slot.
 *
 * Case-insensitive, and `-` and spaces fold to `_`, so `card:First Mes` and
 * `card:first-mes` both land on `first_mes`.
 */
export function normalizeSlotLabel(label: string): CardSlot | null {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!key) return null;
  if ((CARD_SLOTS as readonly string[]).includes(key)) return key as CardSlot;
  return SLOT_ALIASES[key] ?? null;
}

/** Split a reply into prose and labelled card blocks. */
export function parseCardBlocks(source: string): ParsedMessage {
  const parts: MessagePart[] = [];
  const blocks: CardBlock[] = [];
  if (!source) return { parts, blocks };

  const lines = source.match(/.*(?:\r\n|\n|\r|$)/g) ?? [];
  let offset = 0;
  // Where the current run of prose began. Prose is everything not inside a card block.
  let proseStart = 0;

  function pushProse(end: number): void {
    // Trimmed, so the blank line a model leaves around a fence does not become an indented
    // code block once the fence itself is gone.
    const text = source.slice(proseStart, end).trim();
    if (text) parts.push({ kind: 'prose', text });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineWithBreak = lines[index]!;
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/(?:\r\n|\n|\r)$/, '');

    const opener = line.match(CARD_OPENER);
    if (opener) {
      const run = opener[1]!;
      const label = opener[2]!.trim();
      pushProse(offset);

      // Content starts on the line after the opener.
      const contentStart = offset + lineWithBreak.length;
      let cursor = contentStart;
      let contentEnd = contentStart;
      let closed = false;
      index += 1;

      for (; index < lines.length; index += 1) {
        const bodyWithBreak = lines[index]!;
        if (!bodyWithBreak) continue;
        const body = bodyWithBreak.replace(/(?:\r\n|\n|\r)$/, '');
        if (closesFence(body, '`', run.length)) {
          closed = true;
          break;
        }
        cursor += bodyWithBreak.length;
        contentEnd = cursor;
      }

      // Trim the single line break before the closing fence so the filed text does not
      // carry one, while keeping `source.slice(start, end) === text` exact.
      const raw = source.slice(contentStart, contentEnd);
      const trimmed = raw.replace(/(?:\r\n|\n|\r)$/, '');
      const end = contentStart + trimmed.length;

      // An opener with nothing after it yet is noise, not content: there is nothing to file
      // and nothing to read, and a naked fence marker on screen is worse than no block at
      // all. It only ever occurs mid-stream or on a generation aborted before any content
      // arrived, so it is transient by construction.
      if (trimmed || closed) {
        const block: CardBlock = {
          slot: normalizeSlotLabel(label),
          label,
          text: trimmed,
          start: contentStart,
          end,
          closed,
        };
        blocks.push(block);
        parts.push({ kind: 'block', block });
      }

      // `index` sits on the closing fence (or past the last line); advance past it and
      // resume prose after it.
      offset = closed ? cursor + (lines[index]?.length ?? 0) : cursor;
      proseStart = offset;
      continue;
    }

    // A plain fence is left entirely alone — it is ordinary code the model wrote, and its
    // body must not be scanned, or a `card:` line quoted inside an example would be read
    // as a real opener.
    const plain = line.match(ANY_OPENER);
    if (plain) {
      const run = plain[1]!;
      const marker = run[0] as '`' | '~';
      offset += lineWithBreak.length;
      index += 1;
      for (; index < lines.length; index += 1) {
        const bodyWithBreak = lines[index]!;
        if (!bodyWithBreak) continue;
        offset += bodyWithBreak.length;
        if (closesFence(bodyWithBreak.replace(/(?:\r\n|\n|\r)$/, ''), marker, run.length)) break;
      }
      continue;
    }

    offset += lineWithBreak.length;
  }

  pushProse(source.length);
  return { parts, blocks };
}
