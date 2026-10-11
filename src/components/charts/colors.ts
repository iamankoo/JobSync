import type { ApplicationStatus } from "@/types/domain";

/** Chart colours (all clearly visible on the dark navy surfaces). */
export const STATUS_COLORS: Record<Exclude<ApplicationStatus, "Not Applied">, string> = {
  Applied: "#3b82f6",
  "In Progress": "#f59e0b",
  Interview: "#22c55e",
  Offer: "#a78bfa",
  Rejected: "#ef4444",
};

export const PALETTE = ["#3b82f6", "#8b5cf6", "#f59e0b", "#22c55e", "#ec4899", "#06b6d4"];

/** Rounds a maximum up to a "nice" axis value (4, 5, 8, 10, 20, 50 ...). */
export function niceMax(value: number, minimum = 4): number {
  const v = Math.max(value, minimum);
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 2, 2.5, 4, 5, 8, 10]) {
    if (v <= step * pow) return step * pow;
  }
  return 10 * pow;
}
