"use client";

import { useEffect, useState } from "react";

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

interface Props {
  slices: DonutSlice[];
  centerValue: string | number;
  centerLabel: string;
  ariaLabel: string;
  /** Text shown in the legend next to each value, e.g. "Applications". Optional. */
  size?: number;
}

const R = 70;
const C = 2 * Math.PI * R;

/** Animated donut with a legend. Hover or focus a slice (or its legend row) to see its details. */
export function DonutChart({ slices, centerValue, centerLabel, ariaLabel, size = 150 }: Props) {
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  let offset = 0;
  const shown = active !== null ? slices[active] : null;
  const summary = `${ariaLabel}: ${total === 0 ? "no data" : slices.filter((s) => s.value > 0).map((s) => `${s.label} ${s.value}`).join(", ")}`;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={summary} className="-rotate-90">
          <circle cx="100" cy="100" r={R} fill="none" stroke="#14214a" strokeWidth="28" />
          {total > 0 &&
            slices.map((s, i) => {
              const len = (s.value / total) * C;
              const el = (
                <circle
                  key={s.label}
                  cx="100"
                  cy="100"
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={active === i ? 32 : 28}
                  strokeDasharray={`${ready ? len : 0} ${C}`}
                  strokeDashoffset={-offset}
                  style={{ transition: "stroke-dasharray 900ms ease, stroke-width 150ms ease", opacity: active === null || active === i ? 1 : 0.45 }}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                >
                  <title>{`${s.label}: ${s.value}`}</title>
                </circle>
              );
              offset += len;
              return s.value > 0 ? el : null;
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-3xl font-bold leading-none">{shown ? shown.value : centerValue}</p>
            <p className="mt-1 max-w-[7rem] text-xs text-muted">{shown ? shown.label : centerLabel}</p>
          </div>
        </div>
      </div>

      <ul className="min-w-[8.5rem] flex-1 space-y-2 text-sm">
        {slices.map((s, i) => (
          <li
            key={s.label}
            tabIndex={0}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            className="flex items-center justify-between gap-3 rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-electric-soft"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tabular-nums text-ink/90">
              {s.value} <span className="text-muted">({total > 0 ? Math.round((s.value / total) * 100) : 0}%)</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
