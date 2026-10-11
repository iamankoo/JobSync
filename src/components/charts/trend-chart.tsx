"use client";

import { useId, useMemo, useState } from "react";
import { niceMax } from "./colors";

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface Props {
  labels: string[];
  series: TrendSeries[];
  ariaLabel: string;
}

const W = 480;
const H = 250;
const L = 36;
const R = 14;
const T = 12;
const B = 28;

/**
 * Multi-series trend chart. Legend buttons show/hide series; hover (or Left/Right arrow keys while
 * the chart is focused) shows the values for one day.
 */
export function TrendChart({ labels, series, ariaLabel }: Props) {
  const gradId = useId();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const visible = series.filter((s) => !hidden.has(s.key));
  const max = useMemo(() => niceMax(Math.max(0, ...visible.flatMap((s) => s.values))), [visible]);
  const n = labels.length;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const x = (i: number) => L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => T + plotH - (v / max) * plotH;
  const xLabelEvery = Math.max(1, Math.ceil(n / 5));

  function indexFromPointer(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    return Math.min(n - 1, Math.max(0, Math.round(((px - L) / plotW) * (n - 1))));
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  }

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <div className="mb-2 flex flex-wrap justify-end gap-x-4 gap-y-1 text-sm">
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={!hidden.has(s.key)}
            onClick={() => toggle(s.key)}
            className={`flex items-center gap-2 rounded px-1 transition ${hidden.has(s.key) ? "opacity-40" : ""}`}
          >
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="group"
          aria-label={`${ariaLabel}. Use the left and right arrow keys to read each day.`}
          tabIndex={0}
          className="w-full rounded outline-none focus-visible:ring-2 focus-visible:ring-electric-soft"
          onPointerMove={(e) => setHover(indexFromPointer(e))}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <defs>
            {visible.map((s) => (
              <linearGradient key={s.key} id={`${gradId}-${s.key.replace(/\s/g, "")}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {Array.from({ length: 5 }, (_, i) => {
            const v = (i / 4) * max;
            return (
              <g key={i}>
                <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#1c2b57" strokeDasharray="3 4" />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="12" fill="#a3b0d4">
                  {Math.round(v * 10) / 10}
                </text>
              </g>
            );
          })}
          {labels.map((label, i) =>
            i % xLabelEvery === 0 || i === n - 1 ? (
              <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="12" fill="#a3b0d4">
                {label}
              </text>
            ) : null,
          )}
          {visible.map((s) => {
            const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
            const area = `${x(0).toFixed(1)},${y(0)} ${pts} ${x(n - 1).toFixed(1)},${y(0)}`;
            return (
              <g key={s.key}>
                {n > 1 && <polygon points={area} fill={`url(#${gradId}-${s.key.replace(/\s/g, "")})`} />}
                <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + plotH} stroke="#6f8dff" strokeDasharray="4 4" />
              {visible.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r="4.5" fill={s.color} stroke="#050b1f" strokeWidth="1.5" />
              ))}
            </g>
          )}
        </svg>

        {hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-[8.5rem] rounded-lg border border-line bg-navy-800/95 px-3 py-2 text-xs shadow-xl"
            style={{ left: `${Math.min(Math.max((x(hover) / W) * 100, 12), 78)}%` }}
          >
            <p className="mb-1 font-semibold">{labels[hover]}</p>
            {visible.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="tabular-nums">{s.values[hover]}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
