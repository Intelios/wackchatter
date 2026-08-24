import { describe, expect, test } from 'bun:test';
import { EFFECTS, getEffect } from './effects.ts';
import { createEffectState, OVERSCAN, rainSlant, resizeEffect, stepEffect } from './engine.ts';

/** Deterministic LCG, so respawn and clamp assertions are about the physics, not luck. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** noUncheckedIndexedAccess makes indexing look optional; a test wants it to throw. */
function particleAt(state: ReturnType<typeof createEffectState>, index: number) {
  const particle = state.particles[index];
  if (!particle) throw new Error(`particle ${index} missing`);
  return particle;
}

describe('createEffectState', () => {
  test('every effect produces exactly its spec count, within the extended bounds', () => {
    for (const entry of EFFECTS) {
      const state = createEffectState(entry.spec, 800, 600, lcg(1));
      expect(state.particles, entry.id).toHaveLength(entry.spec.count);
      for (const particle of state.particles) {
        expect(particle.x).toBeGreaterThanOrEqual(-OVERSCAN);
        expect(particle.x).toBeLessThan(800 + OVERSCAN);
        expect(particle.y).toBeGreaterThanOrEqual(0);
        expect(particle.y).toBeLessThanOrEqual(600);
      }
    }
  });
});

describe('stepEffect', () => {
  test('rain moves down-slanted and respawns above the top after fully leaving', () => {
    const spec = getEffect('rain')?.spec;
    if (spec?.family !== 'rain') throw new Error('rain spec missing');
    const state = createEffectState(spec, 400, 300, lcg(7));
    // Parked far below the bounds: the streak has fully exited, so the next step must
    // respawn it above the top with a fresh speed.
    particleAt(state, 0).y = 1200;
    stepEffect(state, 1 / 60, 400, 300, lcg(9));

    expect(state.particles).toHaveLength(spec.count);
    const first = particleAt(state, 0);
    expect(first.y).toBeLessThanOrEqual(0);
    expect(first.y).toBeGreaterThanOrEqual(-spec.speedMax * spec.lengthFactor - 300 * 0.15 - 1);
    // Falling means y grows; the slant means x moves the same sign as the slant.
    for (const particle of state.particles.slice(1)) {
      expect(particle.y).toBeGreaterThan(0);
    }
  });

  test('fall particles respawn above the top with fresh tuning', () => {
    const spec = getEffect('leaves')?.spec;
    if (spec?.family !== 'fall') throw new Error('leaves spec missing');
    const state = createEffectState(spec, 400, 300, lcg(3));
    particleAt(state, 0).y = 500;
    stepEffect(state, 1 / 30, 400, 300, lcg(11));

    const first = particleAt(state, 0);
    expect(first.y).toBeLessThan(0);
    expect(first.size).toBeGreaterThanOrEqual(spec.sizeMin);
    expect(first.size).toBeLessThanOrEqual(spec.sizeMax);
    expect(first.colorIndex).toBeLessThan(spec.colors.length);
  });

  test('motes never exceed their drift speed and stay within the wrapped bounds', () => {
    const spec = getEffect('embers')?.spec;
    if (spec?.family !== 'motes') throw new Error('embers spec missing');
    const state = createEffectState(spec, 400, 300, lcg(5));
    for (let i = 0; i < 500; i++) {
      stepEffect(state, 0.05, 400, 300, lcg(100 + i));
    }
    for (const particle of state.particles) {
      expect(Math.hypot(particle.vx, particle.vy)).toBeLessThanOrEqual(spec.drift + 1e-9);
      expect(particle.x).toBeGreaterThanOrEqual(-OVERSCAN);
      expect(particle.x).toBeLessThan(400 + OVERSCAN);
      expect(particle.y).toBeGreaterThanOrEqual(-OVERSCAN);
      expect(particle.y).toBeLessThan(300 + OVERSCAN);
    }
  });

  test('two half steps match one full step when nothing respawns or wraps', () => {
    const spec = getEffect('rain')?.spec;
    if (spec?.family !== 'rain') throw new Error('rain spec missing');
    // Gust off: with it, slant varies with time and midpoint sampling is legitimately
    // a different integral — that is physics, not a scheduling bug.
    const still = { ...spec, gustAmplitude: 0 };
    // Roomy bounds and a short window: no streak reaches an edge, so the motion is
    // linear and the two schedules must agree exactly.
    const one = createEffectState(still, 4000, 4000, lcg(21));
    const two = createEffectState(still, 4000, 4000, lcg(21));
    stepEffect(one, 0.02, 4000, 4000, lcg(0));
    stepEffect(two, 0.01, 4000, 4000, lcg(0));
    stepEffect(two, 0.01, 4000, 4000, lcg(0));

    for (let i = 0; i < one.particles.length; i++) {
      expect(particleAt(two, i).x).toBeCloseTo(particleAt(one, i).x, 9);
      expect(particleAt(two, i).y).toBeCloseTo(particleAt(one, i).y, 9);
    }
  });

  test('rain depth correlates speed, width, alpha and colour — nearer is all four at once', () => {
    const spec = getEffect('rain')?.spec;
    if (spec?.family !== 'rain') throw new Error('rain spec missing');
    const state = createEffectState(spec, 400, 300, lcg(31));
    // Run the field through many respawns, so the check covers re-tuned drops too.
    for (let i = 0; i < 300; i++) stepEffect(state, 0.5, 400, 300, lcg(40 + i));

    for (const particle of state.particles) {
      expect(particle.speed).toBeGreaterThanOrEqual(spec.speedMin);
      expect(particle.speed).toBeLessThanOrEqual(spec.speedMax);
      expect(particle.size).toBeGreaterThanOrEqual(spec.widthMin);
      expect(particle.size).toBeLessThanOrEqual(spec.widthMax);
      expect(particle.alpha).toBeGreaterThanOrEqual(spec.alphaMin);
      expect(particle.alpha).toBeLessThanOrEqual(spec.alphaMax);
      expect(particle.colorIndex).toBeLessThan(spec.colors.length);
    }
    // Pairwise monotonicity is the actual rule: no drop may be faster yet dimmer,
    // thinner or cooler-coloured than a slower one — that mixture is the uniform dash
    // pattern the depth model exists to prevent.
    for (let i = 0; i < state.particles.length; i++) {
      for (let j = i + 1; j < state.particles.length; j++) {
        const a = particleAt(state, i);
        const b = particleAt(state, j);
        if (a.speed < b.speed) {
          expect(a.alpha).toBeLessThanOrEqual(b.alpha);
          expect(a.size).toBeLessThanOrEqual(b.size);
          expect(a.colorIndex).toBeLessThanOrEqual(b.colorIndex);
        }
      }
    }
  });

  test('the gust stays within its amplitude and drives the horizontal drift', () => {
    const spec = getEffect('rain')?.spec;
    if (spec?.family !== 'rain') throw new Error('rain spec missing');
    expect(rainSlant(spec, 0)).toBe(spec.slant);
    for (let t = 0; t < 25; t += 0.37) {
      expect(Math.abs(rainSlant(spec, t) - spec.slant)).toBeLessThanOrEqual(
        spec.gustAmplitude + 1e-9,
      );
    }

    // The step advances the clock first and integrates with the slant at its end
    // time — the same value the draw that follows reads, so the streak angle and the
    // motion can never disagree by a frame.
    const gusty = { ...spec, gustAmplitude: 0.5, gustSpeed: 2 };
    const state = createEffectState(gusty, 4000, 4000, lcg(3));
    const particle = particleAt(state, 0);
    const xBefore = particle.x;
    const speed = particle.speed;
    stepEffect(state, 0.1, 4000, 4000, lcg(4));
    expect(particle.x - xBefore).toBeCloseTo(speed * rainSlant(gusty, 0.1) * 0.1, 9);
    expect(state.time).toBeCloseTo(0.1, 9);
  });
});

describe('resizeEffect', () => {
  test('folds every particle into the new bounds without changing the count', () => {
    const spec = getEffect('snow')?.spec;
    if (!spec) throw new Error('snow spec missing');
    const state = createEffectState(spec, 1000, 800, lcg(13));
    particleAt(state, 0).x = 990;
    particleAt(state, 0).y = 790;
    resizeEffect(state, 600, 400);

    expect(state.particles).toHaveLength(spec.count);
    for (const particle of state.particles) {
      expect(particle.x).toBeGreaterThanOrEqual(-OVERSCAN);
      expect(particle.x).toBeLessThan(600 + OVERSCAN);
      expect(particle.y).toBeGreaterThanOrEqual(-OVERSCAN);
      expect(particle.y).toBeLessThan(400 + OVERSCAN);
    }
  });

  test('a zero dimension is ignored rather than collapsing the field', () => {
    const spec = getEffect('dust')?.spec;
    if (!spec) throw new Error('dust spec missing');
    const state = createEffectState(spec, 600, 400, lcg(17));
    const before = state.particles.map((particle) => ({ x: particle.x, y: particle.y }));
    resizeEffect(state, 0, 0);
    expect(state.particles.map((particle) => ({ x: particle.x, y: particle.y }))).toEqual(before);
  });
});
