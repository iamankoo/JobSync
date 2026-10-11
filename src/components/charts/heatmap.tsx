"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { HeatCell } from "@/lib/analytics/activity";

const LEVEL_BG = ["#101c42", "rgba(59,130,246,0.30)", "rgba(59,130,246,0.55)", "rgba(59,130,246,0.80)", "#60a5fa"];
const LEVEL_LABELS = ["0", "1–2", "3–5", "6–8", "9+"];
const DAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const CELL = 17;
const GAP = 4;
const MARGIN = 8; // minimum distance between the tooltip and the viewport edge

interface Active {
  cell: HeatCell;
  /** Bounding box of the day square, in viewport coordinates. */
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * Calendar-style activity grid (columns = weeks, rows = Mon..Sun). Intensity = meaningful actions
 * that day. A day with only a visit (no actions) is outlined, so presence is visible but never
 * mistaken for work.
 *
 * Every day square opens a compact tooltip with its date, Job Added, Job Applied and work
 * streak:
 *  - mouse: on hover;  keyboard: on focus (Escape closes);  touch: tap a day, tap elsewhere to close.
 * The tooltip is fixed-positioned and clamped to the viewport, so neither the scrolling heatmap
 * container nor the screen edge can clip it. Each square also has a full text label.
 */
export function Heatmap({
  weeks, monthLabels, totalActions, periodLabel,
}: {
  weeks: (HeatCell | null)[][];
  monthLabels: { column: number; label: string }[];
  totalActions: number;
  /** e.g. "Oct–Dec 2026" */
  periodLabel: string;
}) {
  const tipId = useId();
  const [active, setActive] = useState<Active | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = useCallback((cell: HeatCell, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setActive({ cell, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
  }, []);
  const hide = useCallback(() => {
    setActive(null);
    setPos(null);
  }, []);

  // Place the tooltip above the square (below it when there is no room), clamped inside the viewport.
  useLayoutEffect(() => {
    if (!active || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const { rect } = active;
    let left = rect.left + rect.width / 2 - tip.width / 2;
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - tip.width - MARGIN));
    let top = rect.top - tip.height - 8;
    if (top < MARGIN) top = Math.min(rect.top + rect.height + 8, Math.max(MARGIN, vh - tip.height - MARGIN));
    setPos({ left, top });
  }, [active]);

  // Close on Escape, on scroll/resize (the square moves), and on a tap/click outside any day square.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    // Only a scroll that actually moved the square dismisses the tooltip (it is fixed-positioned).
    const onScroll = () => {
      const el = document.querySelector<HTMLElement>(`[data-heat-cell][data-date="${active.cell.date}"]`);
      const r = el?.getBoundingClientRect();
      if (!r || Math.abs(r.top - active.rect.top) > 1 || Math.abs(r.left - active.rect.left) > 1) hide();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-heat-cell]")) hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [active, hide]);

  return (
    <figure aria-label={`Activity for ${periodLabel}: ${totalActions} meaningful action${totalActions === 1 ? "" : "s"} so far`} className="m-0">
      <div className="relative flex gap-3 overflow-x-auto pb-2">
        <div className="flex flex-col text-xs text-muted" style={{ paddingTop: 20, gap: GAP }} aria-hidden>
          {DAYS.map((d, i) => (
            <span key={i} style={{ height: CELL, lineHeight: `${CELL}px` }}>{d}</span>
          ))}
        </div>
        <div>
          <div className="relative h-5 text-xs text-muted" aria-hidden>
            {monthLabels.map((m) => (
              <span key={m.column} className="absolute" style={{ left: m.column * (CELL + GAP) }}>{m.label}</span>
            ))}
          </div>
          <div className="flex" style={{ gap: GAP }}>
            {weeks.map((week, w) => (
              <div key={w} className="flex flex-col" style={{ gap: GAP }}>
                {week.map((cell, d) =>
                  cell ? (
                    <span
                      key={d}
                      role="img"
                      tabIndex={0}
                      data-heat-cell=""
                      data-date={cell.date}
                      data-level={cell.level}
                      aria-label={cell.label}
                      aria-describedby={active?.cell.date === cell.date ? tipId : undefined}
                      // Hover is for a real mouse only; touch (tap) and keyboard use click/focus below.
                      onPointerEnter={(e) => e.pointerType === "mouse" && show(cell, e.currentTarget)}
                      onPointerLeave={(e) => e.pointerType === "mouse" && hide()}
                      onFocus={(e) => show(cell, e.currentTarget)}
                      onBlur={hide}
                      onClick={(e) => show(cell, e.currentTarget)}
                      className="rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-electric-soft"
                      style={{
                        width: CELL,
                        height: CELL,
                        background: cell.future ? "transparent" : LEVEL_BG[cell.level],
                        boxShadow: cell.future
                          ? "inset 0 0 0 1px rgba(60,80,140,0.55)"
                          : cell.count === 0 && cell.visits > 0
                            ? "inset 0 0 0 1.5px rgba(147,197,253,0.75)"
                            : undefined,
                        opacity: cell.future ? 0.6 : 1,
                        outline: active?.cell.date === cell.date ? "2px solid #93c5fd" : undefined,
                        outlineOffset: 1,
                      }}
                    />
                  ) : (
                    <span key={d} aria-hidden style={{ width: CELL, height: CELL }} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
        <ul className="ml-2 flex shrink-0 flex-col justify-center gap-1.5 text-xs text-muted" aria-label="Legend: meaningful actions per day">
          {LEVEL_LABELS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span aria-hidden className="h-3.5 w-3.5 rounded" style={{ background: LEVEL_BG[i] }} />
              {label}
            </li>
          ))}
          <li className="mt-1 flex items-center gap-2">
            <span aria-hidden className="h-3.5 w-3.5 rounded" style={{ background: LEVEL_BG[0], boxShadow: "inset 0 0 0 1.5px rgba(147,197,253,0.75)" }} />
            visit only
          </li>
        </ul>
      </div>

      {active && (
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden", maxWidth: "calc(100vw - 16px)" }}
          className="pointer-events-none z-50 rounded-lg border border-line bg-navy-800 px-3 py-2 text-xs leading-relaxed text-ink shadow-xl"
        >
          <p>
            <span className="text-muted">Date: </span>
            <span className="font-semibold">{active.cell.dateLabel}</span>
          </p>
          {active.cell.future ? (
            <p className="text-muted">Upcoming day</p>
          ) : (
            <>
              <p>
                <span className="text-muted">Job Added: </span>
                <span className="font-semibold tabular-nums">{active.cell.added}</span>
              </p>
              <p>
                <span className="text-muted">Job Applied: </span>
                <span className="font-semibold tabular-nums">{active.cell.submitted}</span>
              </p>
              <p>
                <span className="text-muted">Streak: </span>
                <span className="font-semibold tabular-nums">
                  {active.cell.streak} {active.cell.streak === 1 ? "day" : "days"}
                </span>
              </p>
            </>
          )}
        </div>
      )}
    </figure>
  );
}
