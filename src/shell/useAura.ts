/**
 * Applies the character's and the persona's colours to the shell root as Aura numbers.
 *
 * Written straight to the element's style rather than through React state: the hue is a
 * registered custom property that transitions on its own, so all a change needs is the new
 * target, and every surface follows through `var()`. The hue is unwrapped against the last
 * one set, so going from pink to red is a short step rather than a lap of the wheel.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';
import { auraFromColor, NEUTRAL_AURA, nearestHue } from './aura.ts';

/** The persona hue the stylesheet starts from (`--w3-ph`'s initial value in shell.css). */
const PERSONA_START_HUE = 160;

export function useAura(
  root: RefObject<HTMLElement | null>,
  wash: RefObject<HTMLElement | null>,
  characterColor: string | null,
  personaColor: string | null,
  /** Who the colour belongs to: a change of character sends a wash, a recolour does not. */
  characterKey: string | null,
) {
  const hue = useRef<number | null>(null);
  const personaHue = useRef<number | null>(null);
  const lastKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const aura = auraFromColor(characterColor);
    // Even the first colour steps from where the stylesheet starts, so it never laps the wheel.
    const next = nearestHue(hue.current ?? NEUTRAL_AURA.hue, aura.hue);
    hue.current = next;
    element.style.setProperty('--w3-h', String(next));
    element.style.setProperty('--w3-c', String(aura.chroma));

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
  }, [root, wash, characterColor, characterKey]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const aura = auraFromColor(personaColor);
    const next = nearestHue(personaHue.current ?? PERSONA_START_HUE, aura.hue);
    personaHue.current = next;
    element.style.setProperty('--w3-ph', String(next));
    element.style.setProperty('--w3-pc', String(aura.chroma));
  }, [root, personaColor]);
}

/**
 * The Aura as inline style for a shell's first render, so the very first style the browser
 * computes is already the character's colour. Set later, the colour would animate in from
 * the stylesheet's default the moment anything measured the page. Read once: `useAura`
 * owns every change after that.
 */
export function initialAuraStyle(
  characterColor: string | null,
  personaColor: string | null,
): Record<string, string> {
  const aura = auraFromColor(characterColor);
  const persona = auraFromColor(personaColor);
  return {
    '--w3-h': String(nearestHue(NEUTRAL_AURA.hue, aura.hue)),
    '--w3-c': String(aura.chroma),
    '--w3-ph': String(nearestHue(PERSONA_START_HUE, persona.hue)),
    '--w3-pc': String(persona.chroma),
  };
}

/** Replays a one-shot `data-go` animation on an element. */
export function replay(element: HTMLElement | null) {
  if (!element) return;
  delete element.dataset.go;
  void element.offsetWidth;
  element.dataset.go = '';
}
