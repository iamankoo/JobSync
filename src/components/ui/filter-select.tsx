import { ChevronDown } from "lucide-react";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  /** Text of the "no filter" option, e.g. "Company". */
  allLabel?: string;
}

/** Native select (keyboard and screen-reader friendly) with a visible label as the empty option. */
export function FilterSelect({ label, value, onChange, options, allLabel }: Props) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full appearance-none rounded-lg border border-line bg-navy-900 pl-3 pr-9 text-sm text-ink outline-none transition hover:border-electric-soft focus-visible:border-electric-soft"
      >
        <option value="">{allLabel ?? label}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
    </label>
  );
}
