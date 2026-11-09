/**
 * The character sheet's rules, as pure functions so they are pinned by tests: which parts
 * of a card it lists, how card text reads outside a chat, and how dragging moves a crop.
 */

import type { CardDataV2 } from '@shared/types/card.ts';
import { AUTO_FACE_CROP } from '@shared/types/settings.ts';

export interface CardFold {
  id: string;
  label: string;
  text: string;
}

/**
 * The card's text, folded one section per field, in the order a card is written. Empty
 * fields are left out; alternate greetings are one section, numbered inside.
 */
export function cardFolds(data: CardDataV2): CardFold[] {
  const alternates = (data.alternate_greetings ?? []).filter((text) => text.trim());
  const folds: CardFold[] = [
    { id: 'description', label: 'Description', text: data.description },
    { id: 'personality', label: 'Personality', text: data.personality },
    { id: 'scenario', label: 'Scenario', text: data.scenario },
    { id: 'first_mes', label: 'First message', text: data.first_mes },
    {
      id: 'alternate_greetings',
      label:
        alternates.length === 1
          ? 'Alternate greeting'
          : `Alternate greetings · ${alternates.length}`,
      text:
        alternates.length === 1
          ? alternates[0]!
          : alternates.map((text, i) => `${i + 1}.\n${text}`).join('\n\n'),
    },
    { id: 'mes_example', label: 'Example dialogue', text: data.mes_example },
    { id: 'system_prompt', label: 'System prompt', text: data.system_prompt },
    {
      id: 'post_history_instructions',
      label: 'Post-history instructions',
      text: data.post_history_instructions,
    },
  ];
  return folds.filter((fold) => (fold.text ?? '').trim());
}

/**
 * Card text as it reads outside a chat: `{{char}}` and `{{user}}` become names. Every other
 * macro is left as written, because the sheet is for checking a card, and a dropped macro
 * would hide what the card actually says.
 */
export function readableCardText(text: string, names: { char: string; user: string }): string {
  return text
    .replace(/\{\{char\}\}/gi, names.char)
    .replace(/\{\{user\}\}/gi, names.user)
    .replace(/<(char|user)>/gi, (_, who: string) =>
      who.toLowerCase() === 'char' ? names.char : names.user,
    );
}

/** A crop clamped to the portrait and kept to one decimal, the way settings stores it. */
export function clampCrop(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * Where a crop lands after dragging the picture `dy` pixels. The picture follows the
 * pointer: pulling it down shows more of the top, so the crop moves up. `overflow` is how
 * much taller than the strip the fitted portrait is; with none there is nothing to move.
 */
export function cropAfterDrag(start: number, dy: number, overflow: number): number {
  if (overflow <= 0) return clampCrop(start);
  return clampCrop(start - (dy / overflow) * 100);
}

/**
 * How far a portrait drawn with `object-fit: cover` overflows its box vertically, in pixels.
 * Zero for a picture wider than the box's shape, which fits by height and cannot move up or down.
 */
export function coverOverflow(
  box: { width: number; height: number },
  image: { width: number; height: number },
): number {
  if (!image.width || !image.height) return 0;
  const scale = Math.max(box.width / image.width, box.height / image.height);
  return Math.max(0, image.height * scale - box.height);
}

/** A crop worth storing: the automatic one is the absence of an entry, not a copy of it. */
export function storedCrop(value: number): number | undefined {
  const clamped = clampCrop(value);
  return clamped === AUTO_FACE_CROP ? undefined : clamped;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

/**
 * Creator notes written as a web page (styled `<div>`s, comments, headers), read as text.
 * Notes are never rendered as raw HTML, so markup would otherwise show as code: this keeps
 * the words and the line breaks and drops the rest. Notes without markup pass through.
 */
export function readableNotes(text: string): string {
  if (!/<\/?[a-z!][^>]*>/i.test(text)) return text;
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|article|header|footer|blockquote)\s*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
      const point =
        code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : whole;
    })
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
