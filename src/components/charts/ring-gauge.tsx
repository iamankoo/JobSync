"use client";

import { useEffect, useState } from "react";

const R = 78;
const C = 2 * Math.PI * R;

/** Animated ring showing a single percentage. `percent` null means "no data yet". */
export function RingGauge({ percent, label, caption, color = "#22c55e" }: { percent: number | null; label: string; caption: string; color?: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const value = percent ?? 0;
  return (
    <div className="relative mx-auto h-[210px] w-[210px]">
      <svg viewBox="0 0 200 200" width="210" height="210" role="img" aria-label={`${label}: ${percent === null ? "no data" : `${percent}%`}`} className="-rotate-90">
        <circle cx="100" cy="100" r={R} fill="none" stroke="#14214a" strokeWidth="14" />
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${ready ? (value / 100) * C : 0} ${C}`}
          style={{ transition: "stroke-dasharray 1000ms ease" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center px-8 text-center">
        <div>
          <p className="text-4xl font-bold leading-none">{percent === null ? "—" : `${percent}%`}</p>
          <p className="mt-1 text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs leading-snug text-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}
