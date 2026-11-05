/**
 * Applies the character's and the persona's colours to the shell root as Aura numbers.
 *
 * Written straight to the element's style rather than through React state: the hue is a
 * registered custom property that transitions on its own, so all a change needs is the new
 * target, and every surface follows through `var()`. The hue is unwrapped against the last
 * one set, so going from pink to red is a short step rather than a lap of the wheel.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';
import { auraFromColor, nearestHue } from './aura.ts';

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
    const next = hue.current === null ? aura.hue : nearestHue(hue.current, aura.hue);
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
    const next = personaHue.current === null ? aura.hue : nearestHue(personaHue.current, aura.hue);
    personaHue.current = next;
    element.style.setProperty('--w3-ph', String(next));
    element.style.setProperty('--w3-pc', String(aura.chroma));
  }, [root, personaColor]);
}

/** Replays a one-shot `data-go` animation on an element. */
export function replay(element: HTMLElement | null) {
  if (!element) return;
  delete element.dataset.go;
  void element.offsetWidth;
  element.dataset.go = '';
}
