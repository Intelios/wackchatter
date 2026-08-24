import { useEffect, useRef, useState } from 'react';
import { type EffectId, getEffect, type MotesSpec } from './effects.ts';
import {
  createEffectState,
  type EffectState,
  rainSlant,
  resizeEffect,
  stepEffect,
} from './engine.ts';
import './ParticleLayer.css';

/**
 * The ambient-effect layer, shared by every shell that shows a background. One canvas
 * per shell — never per panel or bubble — `pointer-events: none`, so its cost is one
 * composite per frame and nothing else.
 *
 * Performance contract (battery is a feature, see AGENTS.md):
 * - The loop caps itself at the spec's `frameIntervalMs`; rain runs at display rate,
 *   everything slower steps at 30fps or less.
 * - `document.hidden` pauses the loop outright — rAF throttling alone still burns a
 *   frame waking up, and a throttled cadence would smear the physics.
 * - A stalled interval is clamped, so recovering from a stall replays in slow motion
 *   rather than teleporting the field.
 * - No `shadowBlur` and no canvas filters: a mote's glow and a rain streak's
 *   motion-blur taper are pre-rendered sprites drawn with `drawImage`, the one cheap
 *   way to do either.
 *
 * Reduced motion is checked here rather than left to CSS — the token overrides zero
 * out *durations*, they cannot stop a rAF loop. The layer also unmounts entirely when
 * the resolved effect is null, so a pairing that is turned off costs nothing.
 */

/** A stalled clock reads as elapsed 0 — the caller's timestamps only ever advance. */
const MAX_STEP_MS = 100;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function makeGlowSprite(color: string): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const sctx = sprite.getContext('2d');
  if (!sctx) return sprite;
  const gradient = sctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, 'transparent');
  sctx.fillStyle = gradient;
  sctx.fillRect(0, 0, size, size);
  return sprite;
}

/**
 * One rain streak, tail up head down: a tapered sliver filled with a gradient that
 * fades in over the upper half. Stretched per drop, this is the motion-blur look a
 * flat 1px stroke cannot have — the streak dissolves into its own tail instead of
 * ending at a hard edge.
 */
function makeStreakSprite(color: string): HTMLCanvasElement {
  const width = 16;
  const height = 256;
  const sprite = document.createElement('canvas');
  sprite.width = width;
  sprite.height = height;
  const sctx = sprite.getContext('2d');
  if (!sctx) return sprite;
  const gradient = sctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'transparent');
  gradient.addColorStop(0.5, color);
  gradient.addColorStop(1, color);
  sctx.fillStyle = gradient;
  sctx.beginPath();
  sctx.moveTo(width / 2 - 1.5, 0);
  sctx.lineTo(width / 2 + 1.5, 0);
  sctx.lineTo(width / 2 + 7, height);
  sctx.lineTo(width / 2 - 7, height);
  sctx.closePath();
  sctx.fill();
  return sprite;
}

/** Total on purpose: the catalogs are non-empty by construction, and a colour must exist. */
function colorAt(colors: readonly string[], index: number): string {
  return colors[index] ?? colors[0] ?? '#ffffff';
}

export interface ParticleLayerProps {
  effect: EffectId | null;
  /** Behind = the z-0 band above the scrim; front = over the content, under popups. */
  layer: 'behind' | 'front';
}

export function ParticleLayer({ effect, layer }: ParticleLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Live, not read-once: flipping the OS switch should still the field without a reload.
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!effect || reducedMotion) return;
    const entry = getEffect(effect);
    const maybeCanvas = canvasRef.current;
    if (!entry || !maybeCanvas) return;
    // Narrowing does not follow a captured variable into the closures below, so the
    // non-null types are what get captured.
    const canvas: HTMLCanvasElement = maybeCanvas;
    const maybeCtx = canvas.getContext('2d');
    if (!maybeCtx) return;
    const ctx: CanvasRenderingContext2D = maybeCtx;

    const { spec } = entry;
    const glowSprites =
      spec.family === 'motes'
        ? new Map(spec.colors.map((color) => [color, makeGlowSprite(color)]))
        : null;
    const streakSprites =
      spec.family === 'rain'
        ? new Map(spec.colors.map((color) => [color, makeStreakSprite(color)]))
        : null;

    let state: EffectState | null = null;
    let width = 0;
    let height = 0;
    let dpr = 1;

    function drawRain(target: EffectState): void {
      if (spec.family !== 'rain' || !streakSprites) return;
      // The streak must trail the drop's motion, so the sprite's rotation reads the
      // same gust the physics just stepped through.
      const slant = rainSlant(spec, target.time);
      const angle = -Math.atan(slant);
      const cos = Math.cos(angle) * dpr;
      const sin = Math.sin(angle) * dpr;
      for (const particle of target.particles) {
        const sprite = streakSprites.get(colorAt(spec.colors, particle.colorIndex));
        if (!sprite) continue;
        const length = particle.speed * spec.lengthFactor;
        ctx.globalAlpha = particle.alpha;
        // The per-drop transform folds the base DPR in by hand; setTransform replaces
        // rather than composes, and save/restore around 150 draws costs more.
        ctx.setTransform(cos, sin, -sin, cos, particle.x * dpr, particle.y * dpr);
        ctx.drawImage(sprite, -particle.size / 2, -length, particle.size, length);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawFall(target: EffectState): void {
      if (spec.family !== 'fall') return;
      ctx.globalAlpha = spec.alpha;
      for (const particle of target.particles) {
        ctx.fillStyle = colorAt(spec.colors, particle.colorIndex);
        if (spec.shape === 'flake') {
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rot);
        ctx.beginPath();
        ctx.ellipse(
          0,
          0,
          particle.size,
          particle.size * (spec.shape === 'leaf' ? 0.45 : 0.35),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    function drawMotes(target: EffectState): void {
      if (spec.family !== 'motes' || !glowSprites) return;
      const motes = spec as MotesSpec;
      for (const particle of target.particles) {
        const pulse = 0.5 + 0.5 * Math.sin(particle.phase);
        const alpha = motes.alphaMin + (motes.alphaMax - motes.alphaMin) * pulse;
        if (alpha <= 0.02) continue;
        const color = colorAt(motes.colors, particle.colorIndex);
        const sprite = glowSprites.get(color);
        if (sprite) {
          const glowSize = particle.size * 8;
          ctx.globalAlpha = alpha * 0.5;
          ctx.drawImage(
            sprite,
            particle.x - glowSize / 2,
            particle.y - glowSize / 2,
            glowSize,
            glowSize,
          );
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function draw(): void {
      if (!state) return;
      ctx.clearRect(0, 0, width, height);
      if (spec.family === 'rain') drawRain(state);
      else if (spec.family === 'fall') drawFall(state);
      else drawMotes(state);
    }

    function measure(): void {
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(rect.width));
      const nextHeight = Math.max(1, Math.round(rect.height));
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
      width = nextWidth;
      height = nextHeight;
      dpr = nextDpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (state) resizeEffect(state, width, height);
      else state = createEffectState(spec, width, height, Math.random);
    }

    let raf = 0;
    let running = false;
    let last = performance.now();
    let acc = 0;

    function tick(now: number): void {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const elapsed = Math.min(now - last, MAX_STEP_MS);
      last = now;
      if (!state || width === 0) return;
      if (spec.frameIntervalMs > 0) {
        acc += elapsed;
        if (acc < spec.frameIntervalMs) return;
        stepEffect(state, acc / 1000, width, height, Math.random);
        acc = 0;
      } else {
        stepEffect(state, elapsed / 1000, width, height, Math.random);
      }
      draw();
    }

    function start(): void {
      if (running) return;
      running = true;
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(tick);
    }

    function stop(): void {
      running = false;
      cancelAnimationFrame(raf);
    }

    function onVisibility(): void {
      if (document.hidden) stop();
      else start();
    }

    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [effect, reducedMotion]);

  if (!effect || reducedMotion) return null;
  return (
    // The div carries aria-hidden rather than the canvas: Biome (rightly) refuses it on
    // a canvas, which some browsers make focusable. The canvas itself stays pure output.
    <div className="particle-layer" data-layer={layer} aria-hidden="true">
      <canvas ref={canvasRef} className="particle-layer__canvas" />
    </div>
  );
}
