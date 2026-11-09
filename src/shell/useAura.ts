/**
 * Applies the character's and the persona's colours to the shell root as Aura numbers.
 *
 * Written straight to the element's style rather than through React state. Surfaces take
 * their new hue immediately; only the flat ambient layer transitions its registered
 * properties. Each hue is unwrapped against the last value, so pink to red takes a short
 * step rather than a lap of the wheel.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';
import { type AuraInput, auraPalette, NEUTRAL_AURA, nearestHue } from './aura.ts';

/** The persona hue the stylesheet starts from (`--w3-ph`'s initial value in shell.css). */
const PERSONA_START_HUE = 160;

export function useAura(
  root: RefObject<HTMLElement | null>,
  wash: RefObject<HTMLElement | null>,
  characterColor: AuraInput,
  personaColor: AuraInput,
  /** Who the colour belongs to: a change of character sends a wash, a recolour does not. */
  characterKey: string | null,
) {
  const hue = useRef<number[]>([]);
  const personaHue = useRef<number[]>([]);
  const lastKey = useRef<string | null>(null);
  // Arrays returned by the resolver can be new references with the same palette.
  const characterKeyColors =
    typeof characterColor === 'string' ? characterColor : (characterColor?.join(',') ?? '');
  const personaKeyColors =
    typeof personaColor === 'string' ? personaColor : (personaColor?.join(',') ?? '');

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const palette = auraPalette(characterKeyColors ? characterKeyColors.split(',') : null);
    const aura = palette[0];
    // Even the first colour steps from where the stylesheet starts, so it never laps the wheel.
    palette.forEach((color, index) => {
      const suffix = index ? String(index + 1) : '';
      const next = nearestHue(hue.current[index] ?? NEUTRAL_AURA.hue, color.hue);
      hue.current[index] = next;
      element.style.setProperty(`--w3-h${suffix}`, String(next));
      element.style.setProperty(`--w3-c${suffix}`, String(color.chroma));
    });

    const switched = lastKey.current !== null && characterKey !== lastKey.current;
    lastKey.current = characterKey;
    const washEl = wash.current;
    if (switched && washEl) {
      washEl.style.setProperty('--w3-wh', String(aura.hue));
      washEl.style.setProperty('--w3-wc', String(aura.chroma));
      delete washEl.dataset.go;
      // Restart the animation: a removed attribute has to be seen before it is re-added.
      void washEl.offsetWidth;
      washEl.dataset.go = '';
    }
  }, [root, wash, characterKeyColors, characterKey]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const colors = personaKeyColors ? personaKeyColors.split(',') : [];
    auraPalette(colors).forEach((color, index) => {
      const suffix = index ? String(index + 1) : '';
      const next = nearestHue(personaHue.current[index] ?? PERSONA_START_HUE, color.hue);
      personaHue.current[index] = next;
      element.style.setProperty(`--w3-ph${suffix}`, String(next));
      element.style.setProperty(`--w3-pc${suffix}`, String(color.chroma));
    });
    element.toggleAttribute('data-persona-gradient', colors.length > 1);
  }, [root, personaKeyColors]);
}

/**
 * The Aura as inline style for a shell's first render, so the very first style the browser
 * computes is already the character's colour. Set later, the colour would animate in from
 * the stylesheet's default the moment anything measured the page. Read once: `useAura`
 * owns every change after that.
 */
export function initialAuraStyle(
  characterColor: AuraInput,
  personaColor: AuraInput,
): Record<string, string> {
  const style: Record<string, string> = {};
  for (const [input, prefix, start] of [
    [characterColor, '--w3-', NEUTRAL_AURA.hue],
    [personaColor, '--w3-p', PERSONA_START_HUE],
  ] as const) {
    auraPalette(input).forEach((color, index) => {
      const suffix = index ? String(index + 1) : '';
      style[`${prefix}h${suffix}`] = String(nearestHue(start, color.hue));
      style[`${prefix}c${suffix}`] = String(color.chroma);
    });
  }
  return style;
}

/** Replays a one-shot `data-go` animation on an element. */
export function replay(element: HTMLElement | null) {
  if (!element) return;
  delete element.dataset.go;
  void element.offsetWidth;
  element.dataset.go = '';
}
