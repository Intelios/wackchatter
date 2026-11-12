/**
 * Streaming off in Settings: the reply streams out of sight, and a nib writes its shape.
 *
 * The scribbles are the hidden reply's own words (`ghostDraft.ts`): one loop per word, bold
 * for speech, slanted for action, wrapping and breaking where the text will. The nib is a
 * small performer over them — it flicks at a sentence end, doodles while the model thinks,
 * and takes turns dipping, tapping and crossing a word out when the stream stalls. Every
 * cycle starts and ends in one rest pose and the nib follows its goal softly, so any cycle
 * joins any other.
 *
 * Nothing here enters React state: the engine reads the stream store each frame and paints
 * one flat canvas. No blurred or see-through layers — Helium flashes those.
 */

import { useEffect, useRef, useState } from 'react';
import type { StreamStore } from '../features/chat/state/streamStore.ts';
import {
  type GhostIdle,
  type GhostMetrics,
  type GhostWord,
  ghostLayout,
  ghostTokens,
  nextIdle,
  scribblePoints,
} from './ghostDraft.ts';

type Phase = 'thinking' | 'writing';

interface GhostDraftProps {
  stream: StreamStore;
  /** The reply has landed: straighten, fade over the text, then call `onGone`. */
  leaving: boolean;
  onGone: () => void;
}

export function GhostDraft({ stream, leaving, onGone }: GhostDraftProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GhostEngine | null>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const [phase, setPhase] = useState<Phase>('writing');

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const engine = startGhost(host, canvas, stream, setPhase, () => goneRef.current());
    engineRef.current = engine;
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [stream]);

  useEffect(() => {
    if (leaving) engineRef.current?.leave();
  }, [leaving]);

  return (
    <div className="w3-ghost" ref={hostRef} data-leaving={leaving || undefined}>
      <canvas ref={canvasRef} />
      {leaving ? null : (
        <span className="wc-visually-hidden" role="status">
          {phase === 'thinking' ? 'Thinking…' : 'Writing…'}
        </span>
      )}
    </div>
  );
}

/* ---------- the engine ---------- */

interface GhostEngine {
  leave(): void;
  stop(): void;
}

type CycleName = 'flick' | GhostIdle;
interface Cycle {
  name: CycleName;
  t: number;
  duration: number;
  /** The word a cross-out strikes and rewrites. */
  index: number;
  redrawn: boolean;
}

const DURATION: Record<CycleName, number> = { flick: 0.42, tap: 0.7, dip: 1.7, cross: 1.9 };
/** Room around the text for the nib: it leans up and to the right of the line it writes. */
const PAD = { top: 60, right: 32, bottom: 16, left: 44 };
const LEAVE_SECONDS = 0.6;
const STALL_SECONDS = 0.9;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

type Point = [number, number];

/** Doodles for the thinking cycle, in a 34 by 20 box over the baseline. Each draws itself, then unwinds. */
const DOODLES: ((k: number) => Point)[] = [
  (k) => {
    const angle = k * 5 * Math.PI;
    const r = 0.75 * angle;
    return [17 + r * Math.cos(angle), -9 + r * Math.sin(angle) * 0.8];
  },
  (k) => {
    const corner = (m: number): Point => {
      const angle = -Math.PI / 2 + (m * 4 * Math.PI) / 5;
      return [17 + 11 * Math.cos(angle), -9 + 10 * Math.sin(angle)];
    };
    const i = Math.min(4, Math.floor(k * 5));
    const f = k * 5 - i;
    const a = corner(i);
    const b = corner(i + 1);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  },
  (k) => {
    const t = k * 2 * Math.PI;
    const s = Math.sin(t);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return [17 + 11 * s * s * s, -10 - 0.7 * y];
  },
  (k) => {
    const angle = k * 8 * Math.PI;
    return [3 + k * 28 - 3.4 * Math.sin(angle), -4 - 5 * (1 - Math.cos(angle))];
  },
];
const DOODLE_SECONDS = 3.4;
const DOODLE_STEPS = 70;

/** Over to the inkwell, down into it, and back: `reach` is 0 at rest and 1 over the well. */
function dipPath(t: number): { reach: number; dy: number } {
  const reach = t < 0.3 ? smooth(t / 0.3) : t < 0.7 ? 1 : 1 - smooth((t - 0.7) / 0.3);
  const arc =
    t < 0.3 ? Math.sin((Math.PI * t) / 0.3) : t > 0.7 ? Math.sin((Math.PI * (t - 0.7)) / 0.3) : 0;
  const dunk = t > 0.3 && t < 0.7 ? Math.sin((Math.PI * (t - 0.3)) / 0.4) : 0;
  return { reach, dy: -16 * arc - 13 * reach + 9 * dunk };
}

function startGhost(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  stream: StreamStore,
  onPhase: (phase: Phase) => void,
  onGone: () => void,
): GhostEngine {
  const ctx = canvas.getContext('2d');
  const measurer = document.createElement('canvas').getContext('2d');
  if (!ctx || !measurer) {
    return { leave: onGone, stop: () => {} };
  }

  // The text this stands in for: its font, its line, its colours.
  const textStyle = getComputedStyle(host.parentElement ?? host);
  const fontSize = Number.parseFloat(textStyle.fontSize) || 16;
  const lineHeight = Number.parseFloat(textStyle.lineHeight) || fontSize * 1.6;
  const k = fontSize / 16;
  const baseline = lineHeight / 2 + fontSize * 0.35;
  const ink = getComputedStyle(host).color;
  const pale = textStyle.color;
  measurer.font = `${textStyle.fontWeight} ${fontSize}px ${textStyle.fontFamily}`;
  const widths = new Map<string, number>();
  const metrics: GhostMetrics = {
    lineHeight,
    paragraphGap: Number.parseFloat(textStyle.getPropertyValue('--wc-space-3')) || fontSize * 0.75,
    space: measurer.measureText(' ').width || fontSize * 0.27,
    measure(text) {
      let w = widths.get(text);
      if (w === undefined) {
        w = measurer.measureText(text).width;
        widths.set(text, w);
      }
      return w;
    },
  };
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let width = host.clientWidth;
  const resize = new ResizeObserver(() => {
    width = host.clientWidth;
    stale = true;
  });
  resize.observe(host);

  let raf = 0;
  let last = performance.now();
  let text = '';
  let stale = true;
  let primed = false;
  let blind = false;
  let words: GhostWord[] = [];
  let height = lineHeight;
  let shownHeight = -1;
  let inked = 0;
  let sinceInk = 0;
  let idleGap = 0;
  let lastIdle: GhostIdle | null = null;
  let cycle: Cycle | null = null;
  let activity = 0;
  let phase: Phase = 'writing';
  let leaving = false;
  let leave = 0;
  // Thinking: the doodle in hand, and how much of the last one is left to fade once writing starts.
  let thinkClock = 0;
  let doodle: Point[] = [];
  let doodleFade = 1;
  // A reply that is not streamed tells us nothing, so the nib writes an unmapped line of its own.
  const blindWords: { text: string; width: number; end: boolean }[] = [];
  let blindClock = 0;
  let blindOwed = 0;
  // The nib, following its goal.
  const nib = { x: 0, y: baseline, rot: 0, lift: 0 };
  const redraws = new Map<number, number>();
  const cache: ({ key: string; points: Point[] } | undefined)[] = [];

  const pointsOf = (word: GhostWord, i: number): Point[] => {
    const key = `${redraws.get(i) ?? 0}:${word.width}:${word.text.length}`;
    const hit = cache[i];
    if (hit && hit.key === key) return hit.points;
    const seed = i * 7919 + (redraws.get(i) ?? 0) * 131 + 17;
    const points = scribblePoints(word.text.length, word.width / k, seed);
    cache[i] = { key, points };
    return points;
  };

  /** Ink one word, whole or in part. Returns where the ink stops. */
  const drawWord = (
    word: GhostWord,
    i: number,
    part: number,
    alpha: number,
    flat: number,
  ): Point => {
    const points = pointsOf(word, i);
    const count = Math.max(1, Math.ceil(part * points.length));
    const slant = word.voice === 'action' ? 0.32 : 0;
    let x = word.x;
    let y = word.y + baseline;
    ctx.beginPath();
    for (let p = 0; p < count; p++) {
      const [px, py] = points[p] ?? [0, 0];
      x = word.x + (px - py * slant) * k;
      y = word.y + baseline + (-4 + (py + 4) * flat) * k;
      if (p) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.lineWidth =
      1.45 * k * (word.voice === 'speech' ? 1.55 : word.voice === 'action' ? 0.85 : 1);
    ctx.globalAlpha = alpha * (word.voice === 'speech' ? 1 : word.voice === 'action' ? 0.58 : 0.74);
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.globalAlpha = 1;
    return [x, y];
  };

  const drawWell = (x: number, y: number, scale: number) => {
    if (scale <= 0.01) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale * k, scale * k);
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(9, 0);
    ctx.lineTo(7, -11);
    ctx.lineTo(4, -11);
    ctx.lineTo(4, -15);
    ctx.lineTo(-4, -15);
    ctx.lineTo(-4, -11);
    ctx.lineTo(-7, -11);
    ctx.closePath();
    // Cleared first, so the dunked nib is hidden behind the well rather than seen through it.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillRect(-4, -15, 8, 2);
    ctx.restore();
  };

  const drawNib = (x: number, y: number, rot: number, scale: number) => {
    if (scale <= 0.01) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.62 + rot);
    ctx.scale(scale * k, scale * k);
    // Clear what is under the pen, so scribbles never show through its barrel.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.roundRect(-5, -47, 10, 26, 3);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.roundRect(-4.5, -47, 9, 21, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pale;
    ctx.fillRect(-5, -27, 10, 5);
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-6.5, -7, -6, -14);
    ctx.lineTo(-5, -22);
    ctx.lineTo(5, -22);
    ctx.lineTo(6, -14);
    ctx.quadraticCurveTo(6.5, -7, 0, 0);
    ctx.fill();
    // The slit and the breather hole are cut out, not painted.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0, -1.5);
    ctx.lineTo(0, -12);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -13.5, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const begin = (name: CycleName) => {
    cycle = { name, t: 0, duration: DURATION[name], index: Math.floor(inked) - 1, redrawn: false };
  };

  const finish = () => {
    cancelAnimationFrame(raf);
    resize.disconnect();
    onGone();
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // What has arrived. Once the reply lands the store empties, so nothing is read after that.
    if (!leaving) {
      const snapshot = stream.getSnapshot();
      if (snapshot.active && !snapshot.incremental) blind = true;
      if (blind) {
        blindClock += dt;
        if (blindClock % 7.4 < 5) blindOwed += dt * 3.4;
        while (blindOwed >= 1) {
          blindOwed -= 1;
          const length = 2 + Math.floor(Math.random() * 8);
          blindWords.push({
            text: 'x'.repeat(length),
            width: length * 7.7 * k,
            end: blindWords.length % 11 === 10,
          });
          stale = true;
        }
      } else if (snapshot.text !== text) {
        text = snapshot.text;
        stale = true;
      }
      if (stale) {
        stale = false;
        if (blind) {
          const fixed: GhostMetrics = {
            ...metrics,
            measure: (word) => word.length * 7.7 * k,
          };
          const laid = ghostLayout(
            blindWords.map((w) => ({
              text: w.text,
              voice: 'plain' as const,
              sentenceEnd: w.end,
              breakBefore: 'none' as const,
            })),
            width,
            fixed,
          );
          words = laid.words;
          height = laid.height;
        } else {
          const laid = ghostLayout(ghostTokens(text, false), width, metrics);
          words = laid.words;
          height = laid.height;
          // A continued reply starts with its old text: that is already written, not news.
          if (!primed && snapshot.active) {
            primed = true;
            inked = words.length;
          }
        }
      }
      const next: Phase = !words.length && snapshot.reasoning ? 'thinking' : 'writing';
      if (next !== phase) {
        phase = next;
        onPhase(next);
      }
    }
    const count = words.length;
    const waiting = !leaving && count === 0;

    // Ink chases the stream: a word or two behind, faster the further it falls back.
    let inking = false;
    if (still || leaving) {
      inked = count;
      cycle = null;
    } else if (cycle) {
      const hurry = count - inked > 6 && cycle.name !== 'flick' ? 2.5 : 1;
      cycle.t += (dt / cycle.duration) * hurry;
      if (cycle.name === 'cross' && cycle.t >= 0.45 && !cycle.redrawn) {
        cycle.redrawn = true;
        redraws.set(cycle.index, (redraws.get(cycle.index) ?? 0) + 1);
      }
      if (cycle.t >= 1) {
        cycle = null;
        idleGap = 0.5;
        sinceInk = 0.4;
      }
    } else if (inked < count) {
      const behind = count - inked;
      const before = Math.floor(inked);
      inked = Math.min(count, inked + clamp(behind * 2.6, 3.2, 40) * dt);
      sinceInk = 0;
      inking = true;
      if (Math.floor(inked) > before && words[before]?.sentenceEnd && behind < 25) {
        inked = before + 1;
        begin('flick');
      }
    } else if (count > 0) {
      sinceInk += dt;
      idleGap -= dt;
      if (sinceInk > STALL_SECONDS && idleGap <= 0) {
        lastIdle = nextIdle(lastIdle, Math.random);
        begin(lastIdle);
      }
    }
    activity += ((inking ? 1 : 0) - activity) * (1 - Math.exp(-dt * 10));

    // Nothing to write yet: doodle, each one drawn and then unwound.
    if (waiting && !still) {
      thinkClock += dt;
      doodleFade = 1;
      const t = (thinkClock % DOODLE_SECONDS) / DOODLE_SECONDS;
      const shape = DOODLES[Math.floor(thinkClock / DOODLE_SECONDS) % DOODLES.length];
      const grown = t < 0.45 ? smooth(t / 0.45) : t < 0.55 ? 1 : 1 - smooth((t - 0.55) / 0.45);
      const steps = Math.max(1, Math.round(grown * DOODLE_STEPS));
      doodle = [];
      if (shape) {
        for (let s = 0; s <= steps; s++) {
          const [px, py] = shape(s / DOODLE_STEPS);
          doodle.push([px * k, baseline + py * k]);
        }
      }
    } else {
      doodleFade = Math.max(0, doodleFade - dt * 4);
    }

    // The reply has landed: the loops straighten and fade while the text fades in over them.
    let flat = 1;
    let fade = 1;
    if (leaving) {
      leave = Math.min(1, leave + dt / (still ? 0.2 : LEAVE_SECONDS));
      const e = smooth(leave);
      flat = 1 - 0.85 * e;
      fade = 1 - e;
    } else if (height !== shownHeight) {
      shownHeight = height;
      host.style.height = `${height}px`;
    }

    const dpr = window.devicePixelRatio || 1;
    const cw = width + PAD.left + PAD.right;
    const ch = height + PAD.top + PAD.bottom;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.translate(PAD.left, PAD.top);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let tip: Point = [0, baseline];
    const full = Math.floor(inked);
    const part = inked - full;
    for (let i = 0; i < count && i <= full; i++) {
      const word = words[i];
      const amount = i < full ? 1 : part;
      if (!word || amount <= 0) break;
      if (cycle?.name === 'cross' && i === cycle.index) {
        // Struck through, faded, then written again a little differently.
        const mid = word.y + baseline - 4 * k;
        if (cycle.t < 0.45) {
          const alpha = cycle.t < 0.25 ? 1 : 1 - (cycle.t - 0.25) / 0.2;
          const end = word.x - 2 + (word.width + 4) * Math.min(1, cycle.t / 0.25);
          drawWord(word, i, 1, alpha, 1);
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = pale;
          ctx.lineWidth = 1.5 * k;
          ctx.beginPath();
          ctx.moveTo(word.x - 2, mid + 1);
          ctx.lineTo(end, mid - 1);
          ctx.stroke();
          ctx.globalAlpha = 1;
          tip = cycle.t < 0.25 ? [end, mid] : [word.x, word.y + baseline];
        } else {
          tip = drawWord(word, i, (cycle.t - 0.45) / 0.55, 1, 1);
        }
        continue;
      }
      tip = drawWord(word, i, amount, fade, flat);
    }

    if (still) {
      // No nib and no cycles: while nothing has arrived, one finished doodle holds the line.
      if (waiting) {
        ctx.globalAlpha = 0.74;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        for (let s = 0; s <= DOODLE_STEPS; s++) {
          const [px, py] = DOODLES[0]?.(s / DOODLE_STEPS) ?? [0, 0];
          if (s) ctx.lineTo(px * k, baseline + py * k);
          else ctx.moveTo(px * k, baseline + py * k);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (leaving && leave >= 1) finish();
      return;
    }

    if (doodleFade > 0 && doodle.length > 1) {
      ctx.globalAlpha = 0.74 * doodleFade;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.4 * k;
      ctx.beginPath();
      for (const [s, point] of doodle.entries()) {
        if (s) ctx.lineTo(point[0], point[1]);
        else ctx.moveTo(point[0], point[1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Where the nib wants to be, then a soft follow so every cycle joins the next.
    let gx = tip[0];
    let gy = tip[1];
    let grot = 0.09 * Math.sin(inked * 9) * activity;
    let scale = 1;
    let well = 0;
    if (waiting) {
      const end = doodle[doodle.length - 1];
      if (end) {
        gx = end[0];
        gy = end[1];
      }
      grot = 0.1 * Math.sin(thinkClock * 5);
    } else if (leaving) {
      const e = smooth(leave);
      gy -= 18 * k * Math.sin(Math.PI * leave);
      grot = 0.5 * e;
      scale = 1 - e;
    } else if (cycle && cycle.name !== 'cross') {
      const t = cycle.t;
      const swing = Math.sin(Math.PI * t);
      if (cycle.name === 'flick') {
        gx += 6 * k * swing;
        gy -= 13 * k * swing;
        grot += 0.5 * swing;
      } else if (cycle.name === 'tap') {
        gy -= 9 * k * Math.abs(Math.sin(2 * Math.PI * t));
        grot += 0.15 * Math.sin(2 * Math.PI * t);
      } else {
        const path = dipPath(t);
        gx += 24 * k * path.reach;
        gy += path.dy * k;
        well = path.reach;
      }
    }
    const follow = 1 - Math.exp(-dt * 20);
    const far = Math.hypot(gx - nib.x, gy - nib.y);
    nib.x += (gx - nib.x) * follow;
    nib.y += (gy - nib.y) * follow;
    nib.rot += (grot - nib.rot) * follow;
    // A long way to go (the next line, a new paragraph) lifts the pen off the page.
    nib.lift += (clamp((far - 30) * 0.22, 0, 16) * k - nib.lift) * follow;

    drawNib(nib.x, nib.y - nib.lift, nib.rot, scale);
    if (well) drawWell(tip[0] + 24 * k, tip[1], well);

    if (leaving && leave >= 1) finish();
  };
  raf = requestAnimationFrame(frame);

  return {
    leave() {
      leaving = true;
    },
    stop() {
      cancelAnimationFrame(raf);
      resize.disconnect();
    },
  };
}
