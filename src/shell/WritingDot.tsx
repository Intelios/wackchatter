/**
 * Streaming off in Settings: the reply streams out of sight, and a dot keeps you company.
 *
 * Just the dot — no words, no count. It breathes, and every second or so plays one of its
 * tricks (`writingDot.ts`), each of which starts and ends as the plain dot. It knows nothing
 * about the reply. One small flat canvas; under reduced motion the dot simply sits there.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import {
  DOT_REST_SECONDS,
  DOT_TRICK_SECONDS,
  type DotShape,
  type DotTrick,
  dotTrick,
  nextDotTrick,
  restingDot,
} from './writingDot.ts';

/** The canvas, and where the dot sits in it: room to hop, split and spark on every side. */
const WIDTH = 44;
const HEIGHT = 40;
const HOME_X = 15;
const HOME_Y = 20;
const RADIUS = 5;

export function WritingDot({ stream }: { stream: StreamStore }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Only the phase, for screen readers: a boolean, so the count of tokens never re-renders this.
  const thinking = useSyncExternalStore(stream.subscribe, () => {
    const snapshot = stream.getSnapshot();
    return !snapshot.text && Boolean(snapshot.reasoning);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const colour = getComputedStyle(canvas).color;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const paint = (shapes: DotShape[]) => {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(WIDTH * dpr)) {
        canvas.width = Math.round(WIDTH * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.translate(HOME_X, HOME_Y);
      ctx.fillStyle = colour;
      ctx.strokeStyle = colour;
      ctx.lineCap = 'round';
      for (const shape of shapes) {
        ctx.beginPath();
        if (shape.kind === 'disc') {
          ctx.ellipse(
            shape.x,
            shape.y,
            Math.max(0.01, shape.rx),
            Math.max(0.01, shape.ry),
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        } else if (shape.kind === 'arc') {
          ctx.lineWidth = shape.width;
          ctx.arc(0, 0, shape.radius, shape.from, shape.from + shape.sweep);
          ctx.stroke();
        } else {
          ctx.lineWidth = 1.5;
          for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI) / 3 + 0.5;
            const far = shape.from + shape.length;
            ctx.moveTo(shape.from * Math.cos(angle), shape.from * Math.sin(angle));
            ctx.lineTo(far * Math.cos(angle), far * Math.sin(angle));
          }
          ctx.stroke();
        }
      }
    };

    if (still) {
      paint(restingDot(0, RADIUS));
      return;
    }

    let raf = 0;
    let last = performance.now();
    let trick: { name: DotTrick; t: number } | null = null;
    let previous: DotTrick | null = null;
    let rest = 0.8;
    let breath = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (trick) {
        trick.t += dt / DOT_TRICK_SECONDS[trick.name];
        if (trick.t >= 1) {
          trick = null;
          const [least, most] = DOT_REST_SECONDS;
          rest = least + Math.random() * (most - least);
          breath = 0;
        }
      } else {
        rest -= dt;
        breath += dt * 4.5;
        if (rest <= 0) {
          previous = nextDotTrick(previous, Math.random);
          trick = { name: previous, t: 0 };
        }
      }
      paint(trick ? dotTrick(trick.name, trick.t, RADIUS) : restingDot(breath, RADIUS));
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="w3-writing" role="status">
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
      <span className="wc-visually-hidden">{thinking ? 'Thinking…' : 'Writing…'}</span>
    </div>
  );
}
