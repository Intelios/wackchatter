import { useEffect, useRef } from 'react';

interface Props {
  introActive: boolean;
  introProgress: number; // 0 to 1
  motion: boolean;
  hidden: boolean;
}

interface Star {
  x: number;
  y: number;
  size: number;
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  color: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  decay: number;
  streak: boolean;
  drag: number;
}

const PALETTE = [
  '#c2ee4a', // series 1 (accent lime)
  '#51a0de', // series 2 (sky blue)
  '#e18a24', // series 3 (amber)
  '#a78bfa', // series 4 (purple)
  '#2dd4bf', // series 5 (teal)
  '#ff8fa3', // series 6 (rose)
  '#ffffff', // stellar white
];

export function NexusCosmicCanvas({ introActive, introProgress, motion, hidden }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<Star[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const shockwavesRef = useRef<
    Array<{
      radius: number;
      maxRadius: number;
      color: string;
      alpha: number;
      width: number;
      speed: number;
    }>
  >([]);
  const hasDetonated = useRef(false);
  const detonationTime = useRef(0);
  const prevProgress = useRef(0);

  // Reset detonation trigger when intro begins
  useEffect(() => {
    if (introActive && introProgress < 0.1) {
      hasDetonated.current = false;
      detonationTime.current = 0;
      particlesRef.current = [];
      shockwavesRef.current = [];
    }
  }, [introActive, introProgress]);

  // Main animation / render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();

    const initStars = (width: number, height: number) => {
      const count = Math.min(180, Math.floor((width * height) / 8000));
      const stars: Star[] = [];
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: Math.random() * 1.8 + 0.4,
          baseAlpha: Math.random() * 0.45 + 0.15,
          twinkleSpeed: Math.random() * 0.002 + 0.0008,
          twinklePhase: Math.random() * Math.PI * 2,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
        });
      }
      starsRef.current = stars;
    };

    const detonate = (cx: number, cy: number, maxDim: number, time: number) => {
      detonationTime.current = time;
      const burst: Particle[] = [];

      // Tier 1: 180 High-velocity shooting sparks (meteor streaks) that fly across the entire screen
      const highSpeedCount = 180;
      for (let i = 0; i < highSpeedCount; i++) {
        const angle = (i / highSpeedCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
        const speed = (Math.random() * 1.6 + 1.1) * (maxDim * 0.024);
        burst.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
          size: Math.random() * 2.5 + 1.2,
          alpha: 1.0,
          decay: Math.random() * 0.003 + 0.002,
          streak: true,
          drag: Math.random() * 0.007 + 0.982,
        });
      }

      // Tier 2: 140 Mid-range drifting stardust embers
      const midCount = 140;
      for (let i = 0; i < midCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = (Math.random() * 0.9 + 0.35) * (maxDim * 0.015);
        burst.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
          size: Math.random() * 3.2 + 1.4,
          alpha: 0.95,
          decay: Math.random() * 0.005 + 0.003,
          streak: false,
          drag: 0.974,
        });
      }

      // Tier 3: 60 Core constellation embers
      const coreCount = 60;
      for (let i = 0; i < coreCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = (Math.random() * 0.4 + 0.1) * (maxDim * 0.01);
        burst.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
          size: Math.random() * 2.2 + 1.0,
          alpha: 0.85,
          decay: 0.004,
          streak: false,
          drag: 0.95,
        });
      }

      particlesRef.current = burst;

      // Concentric expanding shockwave rings traveling all the way across screen
      shockwavesRef.current = [
        {
          radius: 0,
          maxRadius: maxDim * 1.15,
          color: '#ffffff',
          alpha: 0.95,
          width: 3.5,
          speed: 22,
        },
        {
          radius: 0,
          maxRadius: maxDim * 1.05,
          color: '#c2ee4a',
          alpha: 0.9,
          width: 5.5,
          speed: 17,
        },
        {
          radius: 0,
          maxRadius: maxDim * 0.95,
          color: '#2dd4bf',
          alpha: 0.75,
          width: 4.0,
          speed: 13,
        },
        {
          radius: 0,
          maxRadius: maxDim * 1.2,
          color: '#a78bfa',
          alpha: 0.6,
          width: 6.5,
          speed: 10,
        },
      ];
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        initStars(rect.width, rect.height);
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const render = (time: number) => {
      const dt = Math.min(64, time - lastTime);
      lastTime = time;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      if (width <= 0 || height <= 0) {
        if (!hidden && motion) animId = requestAnimationFrame(render);
        return;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const maxDim = Math.max(width, height);

      // Trigger detonation at introProgress >= 0.18 (around t = ~360ms)
      if (introActive && introProgress >= 0.18 && !hasDetonated.current) {
        detonate(cx, cy, maxDim, time);
        hasDetonated.current = true;
      }
      prevProgress.current = introProgress;

      // Subtle impact micro-tremor upon detonation (first 260ms)
      const detElapsed = hasDetonated.current ? time - detonationTime.current : -1;
      if (detElapsed >= 0 && detElapsed < 260) {
        const shakeP = 1 - detElapsed / 260;
        const mag = shakeP * 4.5;
        const shakeX = (Math.random() - 0.5) * mag * 2;
        const shakeY = (Math.random() - 0.5) * mag * 2;
        ctx.translate(shakeX, shakeY);
      }

      // 1. Deep Space Nebula Glow
      const nebGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxDim * 0.65);
      if (introActive && introProgress < 0.18) {
        // Pre-detonation void plunge: pinpoint glow at center
        const coreIntensity = introProgress / 0.18;
        nebGrad.addColorStop(0, `rgba(194, 238, 74, ${0.12 + coreIntensity * 0.25})`);
        nebGrad.addColorStop(0.2, `rgba(167, 139, 250, ${0.04 + coreIntensity * 0.08})`);
        nebGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        // Living ambient nebula breathing
        const breathe = Math.sin(time * 0.001) * 0.03;
        nebGrad.addColorStop(0, `rgba(194, 238, 74, ${0.08 + breathe})`);
        nebGrad.addColorStop(0.35, `rgba(81, 160, 222, ${0.04 + breathe * 0.5})`);
        nebGrad.addColorStop(0.7, `rgba(167, 139, 250, ${0.025})`);
        nebGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      }
      ctx.fillStyle = nebGrad;
      ctx.fillRect(0, 0, width, height);

      // 2. Detonation Radiant Impact Flash (first 450ms)
      if (detElapsed >= 0 && detElapsed < 450) {
        const flashP = detElapsed / 450;
        const flashAlpha = (1 - flashP) ** 2 * 0.6;
        const flashRad = Math.max(1, maxDim * (0.15 + flashP * 0.85));
        const flashGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, flashRad);
        flashGrad.addColorStop(0, `rgba(255, 255, 255, ${flashAlpha * 0.95})`);
        flashGrad.addColorStop(0.25, `rgba(194, 238, 74, ${flashAlpha * 0.75})`);
        flashGrad.addColorStop(0.5, `rgba(81, 160, 222, ${flashAlpha * 0.4})`);
        flashGrad.addColorStop(0.8, `rgba(167, 139, 250, ${flashAlpha * 0.2})`);
        flashGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = flashGrad;
        ctx.fillRect(0, 0, width, height);
      }

      // 3. Expanding Shockwaves (during detonation)
      if (shockwavesRef.current.length > 0) {
        for (const sw of shockwavesRef.current) {
          if (sw.alpha <= 0.01) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(0, sw.radius), 0, Math.PI * 2);
          ctx.strokeStyle = sw.color;
          ctx.lineWidth = sw.width;
          ctx.globalAlpha = sw.alpha;
          ctx.shadowBlur = 22;
          ctx.shadowColor = sw.color;
          ctx.stroke();

          // Advance shockwave smoothly outward across entire screen
          sw.radius += sw.speed * (dt / 16);
          sw.speed = Math.max(2.5, sw.speed * 0.985);
          sw.alpha *= 0.978;
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;
      }

      // 4. Central Singularity Pre-burst flare
      if (introActive && introProgress < 0.28) {
        const p = introProgress / 0.28;
        const flareAlpha = p < 0.65 ? p / 0.65 : 1 - (p - 0.65) / 0.35;
        const flareRad = Math.max(1, p < 0.65 ? p * 12 : 12 + (p - 0.65) * 45);
        const flare = ctx.createRadialGradient(cx, cy, 0, cx, cy, flareRad);
        flare.addColorStop(0, '#ffffff');
        flare.addColorStop(0.4, 'rgba(194, 238, 74, 0.9)');
        flare.addColorStop(1, 'rgba(194, 238, 74, 0)');
        ctx.fillStyle = flare;
        ctx.globalAlpha = flareAlpha;
        ctx.beginPath();
        ctx.arc(cx, cy, flareRad, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      // 5. Stardust Particles (high-velocity streaks and embers)
      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;

        if (p.streak) {
          const speed = Math.hypot(p.vx, p.vy);
          const tailLen = Math.min(50, speed * 2.5);
          const angle = Math.atan2(p.vy, p.vx);
          ctx.beginPath();
          ctx.moveTo(p.x - Math.cos(angle) * tailLen, p.y - Math.sin(angle) * tailLen);
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = p.size;
          ctx.globalAlpha = p.alpha;
          ctx.shadowBlur = 10;
          ctx.shadowColor = p.color;
          ctx.stroke();

          // Spark head
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 0.85, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.alpha;
          ctx.shadowBlur = 6;
          ctx.shadowColor = p.color;
          ctx.fill();
        }

        // Update physics
        p.x += p.vx * (dt / 16);
        p.y += p.vy * (dt / 16);
        p.vx *= p.drag;
        p.vy *= p.drag;

        // Transition smoothly into living ambient stars or fade out
        if (introActive) {
          p.alpha = Math.max(0.18, p.alpha - p.decay * (dt / 16));
        } else {
          p.alpha -= p.decay * (dt / 16);
          if (p.alpha <= 0.02) {
            particles.splice(i, 1);
          }
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1.0;

      // 6. Living Ambient Starfield
      const stars = starsRef.current;
      for (const s of stars) {
        // Slow celestial drift
        if (motion) {
          s.x = (s.x + 0.04 * (dt / 16) + width) % width;
          s.twinklePhase += s.twinkleSpeed * dt;
        }
        const twinkle = Math.sin(s.twinklePhase);
        const alpha = Math.max(0.08, Math.min(1, s.baseAlpha + twinkle * 0.22));

        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.globalAlpha = alpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;

      ctx.restore();

      // Continue render loop if tab is visible and motion is on
      if (!hidden && motion) {
        animId = requestAnimationFrame(render);
      }
    };

    // If motion is disabled, draw one static peaceful starfield frame
    if (!motion) {
      render(performance.now());
      return () => observer.disconnect();
    }

    if (!hidden) {
      animId = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(animId);
      observer.disconnect();
    };
  }, [introActive, introProgress, motion, hidden]);

  return <canvas ref={canvasRef} className="nexus-cosmic-canvas" />;
}
