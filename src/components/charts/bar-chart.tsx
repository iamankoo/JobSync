"use client";

import { useState } from "react";
import { niceMax } from "./colors";

export interface Bar {
  label: string;
  value: number;
  color: string;
}

/** Vertical bar chart. Hovering or focusing a bar highlights it; each bar has a text alternative. */
export function BarChart({ bars, ariaLabel, height = 200 }: { bars: Bar[]; ariaLabel: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 340;
  const L = 34;
  const B = 28;
  const T = 22;
  const max = niceMax(Math.max(...bars.map((b) => b.value), 0));
  const ticks = 4;
  const plotH = height - B - T;
  const slot = (W - L - 8) / Math.max(bars.length, 1);
  const barW = Math.min(46, slot * 0.6);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${ariaLabel}: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}`} className="w-full">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const y = T + plotH - (i / ticks) * plotH;
        return (
          <g key={i}>
            <line x1={L} x2={W - 8} y1={y} y2={y} stroke="#1c2b57" strokeDasharray="3 4" />
            <text x={L - 8} y={y + 4} textAnchor="end" fontSize="12" fill="#a3b0d4">
              {Math.round((i / ticks) * max * 10) / 10}
            </text>
          </g>
        );
      })}
      {bars.map((b, i) => {
        const h = (b.value / max) * plotH;
        const x = L + slot * i + (slot - barW) / 2;
        const y = T + plotH - h;
        return (
          <g
            key={b.label}
            tabIndex={0}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            style={{ outline: "none", opacity: active === null || active === i ? 1 : 0.55, transition: "opacity 150ms" }}
          >
            <title>{`${b.label}: ${b.value}`}</title>
            <rect x={x} y={y} width={barW} height={Math.max(h, 0)} rx="5" fill={b.color} />
            {active === i && <rect x={x - 3} y={y - 3} width={barW + 6} height={h + 3} rx="7" fill="none" stroke={b.color} strokeWidth="1.5" opacity="0.6" />}
            <text x={x + barW / 2} y={Math.max(y - 6, 12)} textAnchor="middle" fontSize="13" fontWeight="600" fill="#f2f5ff">
              {b.value}
            </text>
            <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize="12" fill="#a3b0d4">
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
