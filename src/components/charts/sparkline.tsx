/** Tiny trend line. All-zero data draws a flat baseline (never an invented curve). */
export function Sparkline({ values, color, label }: { values: number[]; color: string; label: string }) {
  const W = 96;
  const H = 36;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 4 - (v / max) * (H - 8)).toFixed(1)}`).join(" ");
  const flat = values.every((v) => v === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} className="shrink-0">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity={flat ? 0.4 : 1} />
    </svg>
  );
}
