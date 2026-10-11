import { PALETTE } from "./colors";

export interface HBarItem {
  label: string;
  value: number;
  /** Optional leading element, e.g. a company mark. */
  leading?: React.ReactNode;
}

/** Horizontal bars with the value at the end. Widths are relative to the largest value. */
export function HBarList({ items, ariaLabel }: { items: HBarItem[]; ariaLabel: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul aria-label={ariaLabel} className="space-y-3.5">
      {items.map((item, i) => (
        <li key={item.label} className="flex items-center gap-3 text-sm">
          {item.leading}
          <span className="w-28 shrink-0 truncate" title={item.label}>
            {item.label}
          </span>
          <span className="h-3.5 flex-1 overflow-hidden rounded-full bg-navy-700" aria-hidden>
            <span
              className="block h-full rounded-full"
              style={{ width: `${(item.value / max) * 100}%`, background: PALETTE[i % PALETTE.length], transition: "width 700ms ease" }}
            />
          </span>
          <span className="w-8 text-right tabular-nums">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
