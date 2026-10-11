import { ChevronDown } from "lucide-react";

/**
 * "Responsive table": ONE table in the DOM that is a normal table at xl (>= 1280px) and turns
 * into a list of cards below it (1 column on phones, 2 on tablets). Each cell carries a
 * `data-label` that is shown as the field name on the card. Explicit ARIA roles keep the table
 * semantics for assistive technology even though the CSS display changes. The column headers
 * stay in the accessibility tree (visually hidden on cards); the visible "Sort by" control
 * (MobileSort) replaces the header sort buttons on small screens.
 */
export const TABLE_CLASS = "w-full text-sm max-xl:block xl:min-w-[960px]";
export const THEAD_CLASS = "border-b border-line text-muted max-xl:sr-only";
export const TBODY_CLASS = "max-xl:grid max-xl:grid-cols-1 max-xl:gap-3 max-xl:p-3 md:max-xl:grid-cols-2";
export const HEAD_ROW_CLASS = "max-xl:block";
export const ROW_CLASS =
  "hover:bg-navy-800/50 xl:border-b xl:border-line/60 xl:last:border-0 max-xl:block max-xl:rounded-xl max-xl:border max-xl:border-line max-xl:bg-navy-950/40 max-xl:p-3";

const CELL_MOBILE =
  "max-xl:flex max-xl:items-center max-xl:justify-between max-xl:gap-3 max-xl:py-1.5 max-xl:before:shrink-0 max-xl:before:text-xs max-xl:before:text-muted max-xl:before:content-[attr(data-label)]";

/** Cell classes. `extra` are the desktop-only extras (e.g. "whitespace-nowrap", "font-medium"). */
export function cellClass(extra = "", kind?: "index" | "title"): string {
  const desktop = `xl:px-3 xl:py-3 ${extra}`.trim();
  if (kind === "index") return `${desktop} max-xl:hidden`;
  if (kind === "title") return `${desktop} max-xl:block max-xl:pb-2 max-xl:text-base max-xl:font-semibold`;
  return `${desktop} ${CELL_MOBILE}`;
}

/** Header cell classes for the (desktop) column headers. */
export const TH_CLASS = "px-3 py-3 text-left font-medium";

/** Visible only below xl: replaces the column-header sort buttons that are hidden on cards. */
export function MobileSort({
  value, onChange, options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative mx-3 mt-3 block xl:hidden">
      <span className="sr-only">Sort by</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full appearance-none rounded-lg border border-line bg-navy-900 pl-3 pr-9 text-sm text-ink outline-none hover:border-electric-soft focus-visible:border-electric-soft"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            Sort: {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </label>
  );
}
