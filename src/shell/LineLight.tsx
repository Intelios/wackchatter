/**
 * The Line's light: the one line of light you write on, and everything it does.
 *
 *   rest       a short, dim pilot light that breathes slowly
 *   writing    stretches to full width and brightens; a bright spot follows your caret and
 *              every keystroke flares it a little
 *   sending    gathers to the centre and shoots up with the message
 *   waiting    a comet runs along it until the first words arrive
 *   thinking   the comet slows and dims while the model reasons
 *   speaking   the light hands over to the character's colour and ripples as words arrive
 *   settle     one soft flare when the reply is done
 *   failure    a brief flicker in the danger colour
 *
 * The moment-to-moment work (phases, ripples, flares) is written straight to the DOM and
 * the Web Animations API, never through React state: a reply streams dozens of updates a
 * second, and re-rendering the composer for each would undo the reason the stream lives
 * outside React in the first place. React only owns the steady states, as data attributes
 * on the form.
 */

import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import type { StreamStore } from '../features/chat/state/streamStore.ts';

export interface LineLightHandle {
  /** A keystroke: a small flare. */
  kick: () => void;
  /** A send: gather to the centre, then shoot up. */
  launch: () => void;
  /** Something went wrong: a flicker in the danger colour. */
  alarm: () => void;
  /** Move the bright spot under the caret, in px from the light's left edge; null hides it. */
  spark: (x: number | null) => void;
}

interface LineLightProps {
  busy: boolean;
  stream: StreamStore;
  /** The chat's current error. A new one sets off the alarm. */
  failed: string | null;
  ref?: Ref<LineLightHandle>;
}

const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** The fastest the light ripples for arriving words; faster reads as noise. */
const RIPPLE_EVERY_MS = 150;

function stillness(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function LineLight({ busy, stream, failed, ref }: LineLightProps) {
  const lightRef = useRef<HTMLDivElement>(null);
  const beamRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  const flareRef = useRef<HTMLDivElement>(null);
  const lastKick = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      kick() {
        const beam = beamRef.current;
        const now = performance.now();
        if (!beam || stillness() || now - lastKick.current < 60) return;
        lastKick.current = now;
        beam.animate([{ filter: 'brightness(1.55)' }, { filter: 'brightness(1)' }], {
          duration: 420,
          easing: 'ease-out',
        });
      },
      launch() {
        const beam = beamRef.current;
        const flare = flareRef.current;
        if (!beam || !flare || stillness()) return;
        beam.animate(
          [
            { transform: 'scaleX(1)', filter: 'brightness(1)' },
            { transform: 'scaleX(0.06)', filter: 'brightness(2.2)', offset: 0.4 },
            { transform: 'scaleX(1)', filter: 'brightness(1)' },
          ],
          { duration: 760, easing: SPRING },
        );
        flare.animate(
          [
            { opacity: 0, transform: 'translateY(0) scaleY(0.2)' },
            { opacity: 1, transform: 'translateY(-10px) scaleY(1)', offset: 0.38 },
            { opacity: 0, transform: 'translateY(-150px) scaleY(1.6)' },
          ],
          { duration: 820, delay: 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      },
      alarm() {
        flicker(lightRef.current, beamRef.current);
      },
      spark(x) {
        const light = lightRef.current;
        if (!light) return;
        if (x === null) delete light.dataset.spark;
        else {
          light.dataset.spark = '';
          light.style.setProperty('--w3-spark-x', `${Math.round(x)}px`);
        }
      },
    }),
    [],
  );

  // While something generates, follow the stream: which phase it is in, and a ripple for
  // arriving words. Subscribed only while busy.
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    if (!busy) {
      delete light.dataset.phase;
      return;
    }
    light.dataset.phase = 'waiting';
    let lastLength = 0;
    let lastRipple = 0;
    const update = () => {
      const snapshot = stream.getSnapshot();
      const phase = !snapshot.active
        ? 'waiting'
        : snapshot.text
          ? 'speaking'
          : snapshot.reasoning
            ? 'thinking'
            : 'waiting';
      light.dataset.phase = phase;
      if (phase !== 'speaking' || snapshot.text.length === lastLength) return;
      lastLength = snapshot.text.length;
      const now = performance.now();
      const ripple = rippleRef.current;
      if (!ripple || stillness() || now - lastRipple < RIPPLE_EVERY_MS) return;
      lastRipple = now;
      ripple.animate(
        [
          { opacity: 0.9, transform: 'scaleX(0.04)' },
          { opacity: 0, transform: 'scaleX(1)' },
        ],
        { duration: 900, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    };
    update();
    return stream.subscribe(update);
  }, [busy, stream]);

  // A reply that finished cleanly settles with one soft flare.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    const beam = beamRef.current;
    if (!finished || !beam || stillness()) return;
    beam.animate(
      [
        { filter: 'brightness(1.9)', transform: 'scaleX(1)' },
        { filter: 'brightness(1)', transform: 'scaleX(1)' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
  }, [busy]);

  // A new failure sets off the alarm once.
  const lastFailure = useRef(failed);
  useEffect(() => {
    if (failed && failed !== lastFailure.current) flicker(lightRef.current, beamRef.current);
    lastFailure.current = failed;
  }, [failed]);

  return (
    <div className="w3-light" ref={lightRef} aria-hidden="true">
      <div className="w3-light__glow" />
      <div className="w3-light__beam" ref={beamRef} />
      <div className="w3-light__ripple" ref={rippleRef} />
      <div className="w3-light__comet" />
      <div className="w3-light__spark" />
      <div className="w3-light__flare" ref={flareRef} />
    </div>
  );
}

/** The failure flicker: the light turns to the danger colour and stutters, then recovers. */
function flicker(light: HTMLElement | null, beam: HTMLElement | null) {
  if (!light) return;
  light.dataset.alarm = '';
  if (beam && !stillness()) {
    beam.animate(
      [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
      { duration: 520, easing: 'steps(5)' },
    );
  }
  setTimeout(() => delete light.dataset.alarm, 1400);
}

/**
 * Where the caret sits along the line, in viewport px, read from the ink mirror: the
 * mirror lays out the same text in the same box, so a range at the caret's offset in it
 * is the caret's position. Null when the offset cannot be found.
 */
export function caretLeft(ink: HTMLElement, offset: number): number | null {
  const walker = document.createTreeWalker(ink, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return rect.left || null;
    }
    remaining -= length;
  }
  return null;
}
