/**
 * The ambient-effect catalog: pure data, no DOM. Seven v1 effects as configs over
 * three engine families (`engine.ts` owns the physics):
 *
 * - `rain`   — fast slanted streaks, drawn as one batched stroke.
 * - `fall`   — snow / leaves / petals: slow descent with sinusoidal sway and optional
 *              rotation, drawn as filled shapes.
 * - `motes`  — dust / embers / fireflies: near-static wandering particles whose alpha
 *              pulses, drawn over a pre-rendered glow sprite.
 *
 * Tuning is deliberately conservative on particle counts — the effects sit behind (or
 * over) everything the user reads, so "clearly alive" beats "dense". Battery is a
 * feature here: every spec carries `frameIntervalMs` because rain needs smoothness but
 * nothing falling at leaf speed needs 60fps.
 */

export type EffectFamily = 'rain' | 'fall' | 'motes';

export type EffectId = 'rain' | 'snow' | 'leaves' | 'petals' | 'dust' | 'embers' | 'fireflies';

export interface RainSpec {
  family: 'rain';
  count: number;
  /** 0 = every frame; the fall/motes families cap below 60 to save battery. */
  frameIntervalMs: number;
  /** Fall speed in px/s. */
  speedMin: number;
  speedMax: number;
  /** Horizontal drift as a fraction of fall speed — the slant. */
  slant: number;
  /** Streak length as speed × this factor, so faster drops draw longer. */
  lengthFactor: number;
  alpha: number;
  color: string;
  lineWidth: number;
}

export type FallShape = 'flake' | 'leaf' | 'petal';

export interface FallSpec {
  family: 'fall';
  count: number;
  frameIntervalMs: number;
  sizeMin: number;
  sizeMax: number;
  /** Descent in px/s. */
  speedMin: number;
  speedMax: number;
  /** Horizontal sway amplitude in px; the phase walks a sine around it. */
  swayAmplitude: number;
  /** Sway angular speed in rad/s. */
  swaySpeed: number;
  rotate: boolean;
  shape: FallShape;
  /** Per-particle colour, picked at spawn. */
  colors: readonly string[];
  alpha: number;
}

export interface MotesSpec {
  family: 'motes';
  count: number;
  frameIntervalMs: number;
  sizeMin: number;
  sizeMax: number;
  /** Wander speed ceiling in px/s — velocity random-walks below it. */
  drift: number;
  /** Steady rise in px/s (embers climb; dust barely does). */
  rise: number;
  /** Alpha pulse angular speed in rad/s. */
  pulseSpeed: number;
  alphaMin: number;
  alphaMax: number;
  colors: readonly string[];
}

export type EffectSpec = RainSpec | FallSpec | MotesSpec;

export interface EffectEntry {
  id: EffectId;
  label: string;
  spec: EffectSpec;
}

export const EFFECTS: readonly EffectEntry[] = [
  {
    id: 'rain',
    label: 'Rain',
    spec: {
      family: 'rain',
      count: 110,
      frameIntervalMs: 0,
      speedMin: 700,
      speedMax: 1100,
      slant: 0.18,
      lengthFactor: 0.09,
      alpha: 0.32,
      color: '#cfd9e6',
      lineWidth: 1,
    },
  },
  {
    id: 'snow',
    label: 'Snow',
    spec: {
      family: 'fall',
      count: 80,
      frameIntervalMs: 33,
      sizeMin: 1.5,
      sizeMax: 3.5,
      speedMin: 25,
      speedMax: 55,
      swayAmplitude: 28,
      swaySpeed: 0.9,
      rotate: false,
      shape: 'flake',
      colors: ['#e6ecf5', '#d4dcea'],
      alpha: 0.7,
    },
  },
  {
    id: 'leaves',
    label: 'Leaves',
    spec: {
      family: 'fall',
      count: 22,
      frameIntervalMs: 33,
      sizeMin: 8,
      sizeMax: 14,
      speedMin: 40,
      speedMax: 90,
      swayAmplitude: 55,
      swaySpeed: 1.1,
      rotate: true,
      shape: 'leaf',
      colors: ['#b0642c', '#c07a35', '#8f9a3a', '#a3552e'],
      alpha: 0.85,
    },
  },
  {
    id: 'petals',
    label: 'Petals',
    spec: {
      family: 'fall',
      count: 36,
      frameIntervalMs: 33,
      sizeMin: 4,
      sizeMax: 8,
      speedMin: 30,
      speedMax: 70,
      swayAmplitude: 40,
      swaySpeed: 1.4,
      rotate: true,
      shape: 'petal',
      colors: ['#f2b8c6', '#f7ccd6', '#eaa0b4'],
      alpha: 0.85,
    },
  },
  {
    id: 'dust',
    label: 'Dust motes',
    spec: {
      family: 'motes',
      count: 40,
      frameIntervalMs: 42,
      sizeMin: 1,
      sizeMax: 2.5,
      drift: 6,
      rise: 2,
      pulseSpeed: 0.5,
      alphaMin: 0.05,
      alphaMax: 0.3,
      colors: ['#e8dcc8'],
    },
  },
  {
    id: 'embers',
    label: 'Embers',
    spec: {
      family: 'motes',
      count: 30,
      frameIntervalMs: 42,
      sizeMin: 1.5,
      sizeMax: 3,
      drift: 10,
      rise: 22,
      pulseSpeed: 1.6,
      alphaMin: 0.2,
      alphaMax: 0.7,
      colors: ['#ff9a3c', '#ff6b35', '#ffc46b'],
    },
  },
  {
    id: 'fireflies',
    label: 'Fireflies',
    spec: {
      family: 'motes',
      count: 18,
      frameIntervalMs: 42,
      sizeMin: 2,
      sizeMax: 3,
      drift: 14,
      rise: 0,
      pulseSpeed: 1.2,
      alphaMin: 0.05,
      alphaMax: 0.65,
      colors: ['#d7f5a0', '#b8e986'],
    },
  },
];

const EFFECTS_BY_ID = new Map<string, EffectEntry>(EFFECTS.map((entry) => [entry.id, entry]));

/** The one place an effect id becomes a spec. Unknown ids are not an error — see resolve. */
export function getEffect(id: string): EffectEntry | null {
  return EFFECTS_BY_ID.get(id) ?? null;
}
