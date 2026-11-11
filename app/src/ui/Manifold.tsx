import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

type Point = readonly [number, number];

/** Milliseconds between two frames. */
const FRAME = 100;

/**
 * The brand's folded surface, drawn as faint lines behind the top of the lab page. It moves slowly and carries no
 * information. It draws about ten frames a second while it is on screen. When the system asks for reduced
 * motion, it draws one frame and stops.
 */
export function Manifold(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let width = 0;
    let height = 0;
    const size = (): void => {
      const box = canvas.getBoundingClientRect();
      const density = window.devicePixelRatio || 1;
      width = box.width;
      height = box.height;
      canvas.width = width * density;
      canvas.height = height * density;
      context.setTransform(density, 0, 0, density, 0, 0);
    };
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A sheet with one soft fold that drifts, tilted toward the viewer.
    const point = (u: number, v: number, t: number): Point => {
      const fold = Math.tanh((u - 0.5 - 0.18 * Math.sin(t * 0.15 + v * 2.2)) * 5);
      const z = 0.22 * fold + 0.05 * Math.sin(u * 7 + t * 0.4) * Math.cos(v * 5 - t * 0.3);
      const x = (u - 0.5) * 1.5;
      const y = v - 0.5;
      const scale = 1 / (1.9 + y * 0.6 + z * 0.8);
      return [
        width * 0.66 + x * scale * width * 0.9,
        height * 0.46 + (y * 0.8 - z * 0.6) * scale * height * 1.9,
      ];
    };
    const line = (steps: number, at: (k: number) => Point, alpha: number): void => {
      context.beginPath();
      for (let k = 0; k <= steps; k++) {
        const [x, y] = at(k / steps);
        if (k) context.lineTo(x, y);
        else context.moveTo(x, y);
      }
      context.strokeStyle = `rgba(139, 92, 246, ${alpha})`;
      context.stroke();
    };
    const draw = (ms: number): void => {
      const t = ms / 1000;
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1;
      for (let i = 0; i <= 34; i++) {
        line(64, (u) => point(u, i / 34, t), 0.08 + 0.16 * Math.sin((Math.PI * i) / 34));
      }
      for (let j = 0; j <= 22; j++) line(34, (v) => point(j / 22, v, t), 0.06);
    };
    const now = (): void => {
      draw(performance.now());
    };
    const resize = (): void => {
      size();
      now();
    };
    // The surface drifts slowly, so about ten frames a second are enough, and none while it is off screen.
    const watcher = new IntersectionObserver((entries) => {
      clearInterval(timer);
      timer = undefined;
      if (!entries.at(-1)?.isIntersecting) return;
      now();
      if (!still) timer = setInterval(now, FRAME);
    });
    size();
    watcher.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      watcher.disconnect();
      clearInterval(timer);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas ref={ref} className="f-manifold" aria-hidden="true" />;
}
