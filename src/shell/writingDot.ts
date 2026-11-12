/**
 * The writing dot's tricks: what the dot does while a reply is written with Streaming off.
 *
 * Each trick is the dot's shape for t in 0..1, and at both ends it is exactly the plain round
 * dot, so any trick can follow any other without a seam. Nothing here knows about the reply.
 *
 * Pure geometry; `WritingDot.tsx` paints it.
 */

export const DOT_TRICKS = ['hop', 'twins', 'dash', 'trio', 'ring', 'pop', 'beat', 'jelly'] as const;
export type DotTrick = (typeof DOT_TRICKS)[number];

/** Seconds each trick takes. */
export const DOT_TRICK_SECONDS: Record<DotTrick, number> = {
  hop: 0.95,
  twins: 1.5,
  dash: 0.8,
  trio: 1.7,
  ring: 1.5,
  pop: 1.0,
  beat: 0.9,
  jelly: 1.0,
};

/** The pause between tricks, in seconds: playful, not non-stop. */
export const DOT_REST_SECONDS: [number, number] = [0.6, 1.3];

export type DotShape =
  | { kind: 'disc'; x: number; y: number; rx: number; ry: number }
  /** An open ring, stroked with round ends. */
  | { kind: 'arc'; radius: number; width: number; from: number; sweep: number }
  /** Six short sparks around the centre. */
  | { kind: 'rays'; from: number; length: number };

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};
/** Rises over the first `edge` of the trick, holds, and falls over the last. */
const plateau = (t: number, edge: number) =>
  t < edge ? smooth(t / edge) : t > 1 - edge ? smooth((1 - t) / edge) : 1;
const bump = (u: number) => (u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0);
const disc = (x: number, y: number, rx: number, ry: number): DotShape => ({
  kind: 'disc',
  x,
  y,
  rx,
  ry,
});

/** The dot at rest between tricks: a slow breath, `phase` in radians. */
export function restingDot(phase: number, r: number): DotShape[] {
  const scale = 1 - 0.22 * (0.5 - 0.5 * Math.cos(phase));
  return [disc(0, 0, r * scale, r * scale)];
}

/** One trick at `t` in 0..1, for a dot of radius `r` centred on the origin (y grows downward). */
export function dotTrick(trick: DotTrick, t: number, r: number): DotShape[] {
  const swing = Math.max(0, Math.sin(Math.PI * t));
  switch (trick) {
    case 'hop': {
      const y = -11 * Math.abs(Math.sin(2 * Math.PI * t)) * (t > 0.5 ? 0.55 : 1);
      const squash = 0.32 * Math.exp((-y * y) / 3) * Math.sqrt(swing);
      return [disc(0, y + r * squash, r * (1 + squash), r * (1 - squash))];
    }
    case 'twins': {
      const apart = 6.5 * swing;
      const angle = 3 * Math.PI * smooth(t);
      const size = r - r * 0.3 * Math.sqrt(swing);
      const x = apart * Math.cos(angle);
      const y = apart * Math.sin(angle) * 0.9;
      return [disc(x, y, size, size), disc(-x, -y, size, size)];
    }
    case 'dash': {
      const e = swing * swing;
      const rx = r + 8 * e;
      return [disc(rx - r, 0, rx, r - r * 0.35 * e)];
    }
    case 'trio': {
      const e = plateau(t, 0.25);
      const size = r - r * 0.35 * e;
      return [0, 1, 2].map((i) =>
        disc(i * 8 * e, -3.5 * Math.sin(2 * Math.PI * (2.5 * t - i * 0.16)) * e, size, size),
      );
    }
    case 'ring': {
      const e = plateau(t, 0.3);
      if (e < 0.02) return [disc(0, 0, r, r)];
      const from = 4 * Math.PI * smooth(t) - Math.PI / 2;
      return [
        {
          kind: 'arc',
          radius: r / 2 + 4 * e,
          width: r - (r - 1.9) * e,
          from,
          sweep: 2 * Math.PI - 1.7 * e,
        },
      ];
    }
    case 'pop': {
      const scale =
        t < 0.3
          ? 1 - smooth(t / 0.3)
          : t < 0.6
            ? 1.4 * smooth((t - 0.3) / 0.3)
            : 1.4 - 0.4 * smooth((t - 0.6) / 0.4);
      const shapes: DotShape[] = [disc(0, 0, r * scale, r * scale)];
      if (t > 0.3 && t < 0.75) {
        const u = (t - 0.3) / 0.45;
        shapes.push({ kind: 'rays', from: r + 3 + 6 * u, length: 3.5 * (1 - u) });
      }
      return shapes;
    }
    case 'beat': {
      const scale = 1 + 0.55 * bump(t / 0.35) + 0.38 * bump((t - 0.4) / 0.4);
      return [disc(0, 0, r * scale, r * scale)];
    }
    case 'jelly': {
      const wobble = 0.4 * Math.sin(6 * Math.PI * t) * (1 - t) * Math.min(1, t * 8);
      return [disc(0, 0, r * (1 + wobble), r * (1 - wobble))];
    }
  }
}

/** The next trick: any but the one just played. */
export function nextDotTrick(previous: DotTrick | null, random: () => number): DotTrick {
  const pool = DOT_TRICKS.filter((trick) => trick !== previous);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'hop';
}
