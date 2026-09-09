import { useEffect, useRef } from 'react';

interface Props {
  introActive: boolean;
  introProgress: number;
  motion: boolean;
  hidden: boolean;
}

interface Star {
  x: number;
  y: number;
  depth: number;
  phase: number;
  tint: number;
}

interface Spark {
  angle: number;
  reach: number;
  depth: number;
  delay: number;
  tint: number;
}

const TAU = Math.PI * 2;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Decorative light only: the SVG above this canvas remains the knowledge map. */
export function NexusCosmicCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  useEffect(() => {
    live.current = props;
  }, [props]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the scheduler when visibility or the motion setting changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const style = getComputedStyle(canvas);
    const colors = ['--wc-text', '--wc-series-2', '--wc-series-4', '--wc-accent'].map((token) =>
      style.getPropertyValue(token).trim(),
    );
    // Bake soft point lights once; hundreds of per-frame shadowBlur operations are costly.
    const lights = colors.map((color) => {
      const sprite = document.createElement('canvas');
      sprite.width = sprite.height = 64;
      const light = sprite.getContext('2d')!;
      const glow = light.createRadialGradient(32, 32, 0, 32, 32, 32);
      glow.addColorStop(0, colors[0]!);
      glow.addColorStop(0.06, colors[0]!);
      glow.addColorStop(0.16, color);
      glow.addColorStop(1, 'transparent');
      light.fillStyle = glow;
      light.fillRect(0, 0, 64, 64);
      return sprite;
    });
    const stars: Star[] = Array.from({ length: 260 }, () => ({
      x: Math.random(),
      y: Math.random(),
      depth: Math.random(),
      phase: Math.random() * TAU,
      tint: Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 3),
    }));
    const sparks: Spark[] = Array.from({ length: 620 }, (_, i) => ({
      angle: (i / 620) * TAU + (Math.random() - 0.5) * 0.06,
      reach: 0.12 + Math.random() ** 0.65 * 1.15,
      depth: Math.random(),
      delay: Math.random() * 0.16,
      tint: Math.random() < 0.58 ? 0 : 1 + Math.floor(Math.random() * 3),
    }));
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let last = performance.now();
    let clock = 0;
    let burstAt: number | null = null;
    let wasIntro = false;

    const point = (x: number, y: number, radius: number, tint: number, alpha: number) => {
      ctx.globalAlpha = clamp(alpha);
      ctx.drawImage(lights[tint]!, x - radius, y - radius, radius * 2, radius * 2);
    };
    const halo = (x: number, y: number, radius: number, tint: number, alpha: number) => {
      point(x, y, radius, tint, alpha);
    };

    const render = (now: number) => {
      raf = 0;
      const { introActive, introProgress, motion, hidden } = live.current;
      const animate = motion && !reduced.matches;
      const dt = Math.min(48, now - last);
      last = now;
      if (hidden || document.hidden) return;
      if (animate) clock += dt;
      if (introActive && !wasIntro) burstAt = null;
      wasIntro = introActive;
      if (!animate) burstAt = null;
      if (animate && introActive && introProgress >= 0.18 && burstAt === null) burstAt = clock;
      // Skipping the entrance also clears its light; natural completion keeps a soft afterglow.
      if (!introActive && burstAt !== null && clock - burstAt < 1500) burstAt = null;
      const age = burstAt === null ? -1 : (clock - burstAt) / 1000;
      const charging = animate && introActive && introProgress < 0.18;
      const charge = charging ? clamp(introProgress / 0.18) : 0;
      const cx = width / 2;
      const cy = height / 2;
      const span = Math.hypot(width, height) / 2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      // Broad, off-axis veils give the void depth without a visible circular gradient boundary.
      halo(cx - width * 0.2, cy + height * 0.12, span * 0.85, 1, 0.045);
      halo(cx + width * 0.25, cy - height * 0.24, span * 0.7, 2, 0.04);
      const arrival = age < 0 ? 0 : Math.exp(-age * 1.6);
      for (const star of stars) {
        const drift = animate ? clock * 0.0000015 * (0.2 + star.depth) : 0;
        let x = ((star.x + drift) % 1) * width;
        let y = star.y * height;
        const push = arrival * (0.015 + star.depth * 0.055);
        x += (x - cx) * push;
        y += (y - cy) * push;
        const twinkle = 0.8 + Math.sin(clock * 0.0006 + star.phase) * 0.2;
        const alpha = (0.15 + star.depth * 0.38) * twinkle * (1 - charge * 0.7);
        point(x, y, 1.3 + star.depth * 3.2, star.tint, alpha);
      }

      if (charging) {
        // A contracting corona and infalling dust create tension before the release.
        halo(cx, cy, span * (0.18 - charge * 0.12), 1, charge * 0.5);
        for (let i = 0; i < 64; i++) {
          const spark = sparks[i * 7]!;
          const r = span * (0.025 + (1 - charge) ** 2 * spark.reach * 0.28);
          point(
            cx + Math.cos(spark.angle) * r,
            cy + Math.sin(spark.angle) * r,
            1 + charge * 2,
            spark.tint,
            charge * 0.65,
          );
        }
        halo(cx, cy, 5 + charge ** 3 * 25, 3, charge);
      }

      if (age >= 0 && age < 4.5) {
        // A broad refractive wake plus a hairline leading edge, rather than neon hoops.
        for (let wave = 0; wave < 3; wave++) {
          const t = age - wave * 0.115;
          if (t <= 0) continue;
          const p = clamp(t / (1.45 + wave * 0.22));
          const radius = Math.max(1, span * 1.35 * (1 - (1 - p) ** 2));
          const alpha = (1 - p) ** 2 * (wave === 0 ? 0.55 : 0.24);
          if (alpha < 0.001) continue;
          ctx.save();
          ctx.translate(cx, cy);
          // One oblique echo suggests a volume, while the main shock stays spherical.
          if (wave === 2) {
            ctx.rotate(-0.22);
            ctx.scale(1, 0.46);
          }
          const wake = ctx.createRadialGradient(0, 0, radius * 0.78, 0, 0, radius * 1.025);
          wake.addColorStop(0, 'transparent');
          wake.addColorStop(0.72, colors[wave === 0 ? 1 : 2]!);
          wake.addColorStop(0.9, colors[0]!);
          wake.addColorStop(1, 'transparent');
          ctx.globalAlpha = alpha * 0.32;
          ctx.fillStyle = wake;
          ctx.beginPath();
          ctx.arc(0, 0, radius * 1.025, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = colors[wave === 0 ? 0 : 1]!;
          ctx.lineWidth = wave === 0 ? 1.1 : 0.65;
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }

        // Analytic flight is identical at 60/120Hz. Delayed layers keep the blast deep.
        for (const spark of sparks) {
          const t = age - spark.delay;
          if (t < 0) continue;
          const travel = (at: number) =>
            span * spark.reach * (1 - Math.exp(-at * (1.3 + spark.depth * 2)));
          const r = travel(t);
          const x = cx + Math.cos(spark.angle) * r;
          const y = cy + Math.sin(spark.angle) * r;
          if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue;
          const alpha = clamp(t * 18) * Math.exp(-t * (0.85 + spark.depth * 0.4));
          const size = 1.5 + spark.depth ** 3 * 6;
          const tail = Math.max(0, travel(Math.max(0, t - 0.035 - spark.depth * 0.075)));
          if (r - tail > 1.5 && spark.depth > 0.3) {
            const tx = cx + Math.cos(spark.angle) * tail;
            const ty = cy + Math.sin(spark.angle) * tail;
            const trail = ctx.createLinearGradient(tx, ty, x, y);
            trail.addColorStop(0, 'transparent');
            trail.addColorStop(0.7, colors[spark.tint]!);
            trail.addColorStop(1, colors[0]!);
            ctx.strokeStyle = trail;
            ctx.globalAlpha = alpha * 0.7;
            ctx.lineWidth = 0.35 + spark.depth ** 3 * 1.5;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          point(x, y, size, spark.tint, alpha);
          // Sparse diffraction glints, reserved for the nearest stars.
          if (spark.depth > 0.96) {
            ctx.globalAlpha = alpha * 0.42;
            ctx.strokeStyle = colors[0]!;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(x - size * 1.5, y);
            ctx.lineTo(x + size * 1.5, y);
            ctx.moveTo(x, y - size);
            ctx.lineTo(x, y + size);
            ctx.stroke();
          }
        }
        // Sustained light bloom with a narrow anamorphic flare at the moment of ignition.
        const flash = Math.exp(-age * 7);
        halo(cx, cy, span * (0.24 + age * 0.3), 1, flash * 0.65);
        halo(cx, cy, span * 0.18, 2, Math.exp(-age * 2.5) * 0.22);
        halo(cx, cy, 26 + age * 40, 3, flash);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.018);
        halo(0, 0, span * 0.9, 1, flash * 0.6);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (animate) raf = requestAnimationFrame(render);
    };

    const wake = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      render(last);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      wake();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    reduced.addEventListener('change', wake);
    document.addEventListener('visibilitychange', wake);
    resize();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      reduced.removeEventListener('change', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [props.motion, props.hidden]);

  return <canvas ref={canvasRef} className="nexus-cosmic-canvas" />;
}
