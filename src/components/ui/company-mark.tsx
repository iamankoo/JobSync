const PALETTE = ["#2563eb", "#7c3aed", "#0d9488", "#c2410c", "#be123c", "#4d7c0f", "#0e7490", "#a21caf"];

/** Letter tile derived from the company name (no logos or invented imagery). */
export function CompanyMark({ name, size = 32 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-lg font-bold text-white"
      style={{ width: size, height: size, background: PALETTE[hash % PALETTE.length], fontSize: size * 0.45 }}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
