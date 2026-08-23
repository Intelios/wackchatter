/**
 * The ambient-effect physics: pure functions over a plain particle array, no DOM, so
 * every invariant is testable without a canvas. `ParticleLayer.tsx` owns the loop and
 * the drawing; this file owns how things move.
 *
 * Conventions:
 * - Positions are in CSS pixels, y grows downward, time in seconds.
 * - `stepEffect` mutates the state in place — one array, allocated once per effect,
 *   never per frame. The particle count is an invariant of the state.
 * - Particles leaving the bounds re-enter rather than dying: rain and fall respawn
 *   above the top with fresh tuning, motes wrap toroidally on all four edges so a
 *   slow drift never pops.
 */

import type { EffectSpec, FallSpec, MotesSpec, RainSpec } from './effects.ts';

export interface Particle {
  x: number;
  y: number;
  /** Motes only: live wander velocity, random-walked every step. */
  vx: number;
  vy: number;
  /** Fall speed in px/s (rain and fall families). */
  speed: number;
  /** Radius-ish size in px (fall and motes families). */
  size: number;
  /** Sway (fall) / alpha-pulse (motes) phase in rad, walking at `phaseSpeed`. */
  phase: number;
  phaseSpeed: number;
  /** Rotation in rad and its speed — fall family, `rotate` specs only. */
  rot: number;
  rotSpeed: number;
  /** Index into the spec's colour list. */
  colorIndex: number;
}

export interface EffectState {
  spec: EffectSpec;
  particles: Particle[];
}

/** Injectable so tests are deterministic; the default is fine for a visual effect. */
export type Rand = () => number;

/** Horizontal overscan: rain slants and fall sways, so spawn beyond the edges. */
export const OVERSCAN = 48;

function spawnX(width: number, rand: Rand): number {
  return (width + OVERSCAN * 2) * rand() - OVERSCAN;
}

function range(rand: Rand, min: number, max: number): number {
  return min + (max - min) * rand();
}

function newParticle(rand: Rand): Particle {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    size: 0,
    phase: rand() * Math.PI * 2,
    phaseSpeed: 1,
    rot: rand() * Math.PI * 2,
    rotSpeed: 0,
    colorIndex: 0,
  };
}

function tuneRain(particle: Particle, spec: RainSpec, rand: Rand): void {
  particle.speed = range(rand, spec.speedMin, spec.speedMax);
}

function tuneFall(particle: Particle, spec: FallSpec, rand: Rand): void {
  particle.speed = range(rand, spec.speedMin, spec.speedMax);
  particle.size = range(rand, spec.sizeMin, spec.sizeMax);
  particle.phaseSpeed = spec.swaySpeed * range(rand, 0.7, 1.3);
  particle.rotSpeed = spec.rotate ? range(rand, -2.2, 2.2) : 0;
  particle.colorIndex = Math.floor(rand() * spec.colors.length) % spec.colors.length;
}

function tuneMotes(particle: Particle, spec: MotesSpec, rand: Rand): void {
  particle.size = range(rand, spec.sizeMin, spec.sizeMax);
  particle.phaseSpeed = spec.pulseSpeed * range(rand, 0.6, 1.4);
  particle.colorIndex = Math.floor(rand() * spec.colors.length) % spec.colors.length;
  const angle = rand() * Math.PI * 2;
  const magnitude = spec.drift * rand();
  particle.vx = Math.cos(angle) * magnitude;
  particle.vy = Math.sin(angle) * magnitude;
}

export function createEffectState(
  spec: EffectSpec,
  width: number,
  height: number,
  rand: Rand,
): EffectState {
  const particles: Particle[] = [];
  for (let i = 0; i < spec.count; i++) {
    const particle = newParticle(rand);
    particle.x = spawnX(width, rand);
    particle.y = rand() * height;
    switch (spec.family) {
      case 'rain':
        tuneRain(particle, spec, rand);
        break;
      case 'fall':
        tuneFall(particle, spec, rand);
        break;
      case 'motes':
        tuneMotes(particle, spec, rand);
        break;
    }
    particles.push(particle);
  }
  return { spec, particles };
}

/** Wrap into [0, bound) without a jump for values already inside. */
function wrap(value: number, bound: number): number {
  return ((value % bound) + bound) % bound;
}

function stepRain(
  state: EffectState,
  spec: RainSpec,
  dt: number,
  width: number,
  height: number,
  rand: Rand,
): void {
  for (const particle of state.particles) {
    particle.x += particle.speed * spec.slant * dt;
    particle.y += particle.speed * dt;
    const length = particle.speed * spec.lengthFactor;
    if (particle.y - length > height + OVERSCAN) {
      // Respawned drops re-roll their speed, so a burst of identical streaks never
      // marches in lockstep.
      tuneRain(particle, spec, rand);
      particle.x = spawnX(width, rand);
      particle.y = -particle.speed * spec.lengthFactor - rand() * height * 0.15;
    } else {
      particle.x = wrap(particle.x + OVERSCAN, width + OVERSCAN * 2) - OVERSCAN;
    }
  }
}

function stepFall(
  state: EffectState,
  spec: FallSpec,
  dt: number,
  width: number,
  height: number,
  rand: Rand,
): void {
  for (const particle of state.particles) {
    particle.phase += particle.phaseSpeed * dt;
    // The derivative of amplitude·sin(phase): a sway that eases at the turns instead
    // of teleporting between edges.
    particle.x += Math.cos(particle.phase) * spec.swayAmplitude * particle.phaseSpeed * dt;
    particle.y += particle.speed * dt;
    particle.rot += particle.rotSpeed * dt;
    if (particle.y - particle.size > height + OVERSCAN) {
      tuneFall(particle, spec, rand);
      particle.x = spawnX(width, rand);
      particle.y = -particle.size * 2 - rand() * height * 0.1;
    } else {
      particle.x = wrap(particle.x + OVERSCAN, width + OVERSCAN * 2) - OVERSCAN;
    }
  }
}

function stepMotes(
  state: EffectState,
  spec: MotesSpec,
  dt: number,
  width: number,
  height: number,
  rand: Rand,
): void {
  for (const particle of state.particles) {
    particle.phase += particle.phaseSpeed * dt;
    // Random walk on velocity, clamped to the drift ceiling — motes wander without
    // ever deciding to leave.
    particle.vx += (rand() * 2 - 1) * spec.drift * dt * 2;
    particle.vy += (rand() * 2 - 1) * spec.drift * dt * 2;
    const magnitude = Math.hypot(particle.vx, particle.vy);
    if (magnitude > spec.drift) {
      const scale = spec.drift / magnitude;
      particle.vx *= scale;
      particle.vy *= scale;
    }
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt - spec.rise * dt;
    particle.x = wrap(particle.x + OVERSCAN, width + OVERSCAN * 2) - OVERSCAN;
    particle.y = wrap(particle.y + OVERSCAN, height + OVERSCAN * 2) - OVERSCAN;
  }
}

/** Advance the simulation. `dt` is seconds; the caller clamps it (a backgrounded tab). */
export function stepEffect(
  state: EffectState,
  dt: number,
  width: number,
  height: number,
  rand: Rand,
): void {
  const { spec } = state;
  switch (spec.family) {
    case 'rain':
      stepRain(state, spec, dt, width, height, rand);
      break;
    case 'fall':
      stepFall(state, spec, dt, width, height, rand);
      break;
    case 'motes':
      stepMotes(state, spec, dt, width, height, rand);
      break;
  }
}

/**
 * Fold the state into new bounds on a window resize. Wrapping rather than rescattering
 * keeps the field continuous — a resize is not a wind gust.
 */
export function resizeEffect(state: EffectState, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  for (const particle of state.particles) {
    particle.x = wrap(particle.x + OVERSCAN, width + OVERSCAN * 2) - OVERSCAN;
    particle.y = wrap(particle.y + OVERSCAN, height + OVERSCAN * 2) - OVERSCAN;
  }
}
