// Small versions of three React Bits patterns (reactbits.dev: SplitText, CountUp, SpotlightCard),
// written with plain CSS and React so the app needs no animation library. All respect reduced motion.
import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Words rise in one after another. */
export function SplitText({ text, className = "", delay = 70 }: { text: string; className?: string; delay?: number }) {
  return (
    <span className={className} aria-label={text}>
      {text.split(" ").map((w, i) => (
        <span key={i} aria-hidden className="split-word" style={{ animationDelay: `${i * delay}ms` } as CSSProperties}>
          {w}&nbsp;
        </span>
      ))}
    </span>
  );
}

/** Counts from 0 to `to` the first time it scrolls into view. */
export function CountUp({ to, duration = 1400, className = "" }: { to: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(() => (reduced() ? to : 0));
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced()) return;
    let frame = 0;
    // Background tabs and screenshot tools pause animation frames; make sure the real number still shows.
    const settle = window.setTimeout(() => setValue(to), duration + 1500);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        setValue(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [to, duration]);
  return (
    <span ref={ref} className={className}>
      {value.toLocaleString("en-GB")}
    </span>
  );
}

/** A card with a soft carbon-green glow that follows the pointer. */
export function SpotlightCard({
  children,
  className = "",
  as: Tag = "div",
  label,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "figure" | "li";
  label?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  return (
    <Tag
      ref={ref as never}
      onPointerMove={(e: React.PointerEvent<HTMLElement>) => {
        const r = ref.current!.getBoundingClientRect();
        ref.current!.style.setProperty("--x", `${e.clientX - r.left}px`);
        ref.current!.style.setProperty("--y", `${e.clientY - r.top}px`);
      }}
      aria-label={label}
      className={`spotlight ${className}`}
    >
      {children}
    </Tag>
  );
}
