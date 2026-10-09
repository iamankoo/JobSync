"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { SortDirection } from "@/lib/jobs/query";

interface Props {
  label: string;
  active: boolean;
  direction: SortDirection;
  onSort: () => void;
}

export function SortableTh({ label, active, direction, onSort }: Props) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"} className="px-3 py-3 text-left font-medium">
      <button type="button" onClick={onSort} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded hover:text-ink">
        {label}
        <Icon size={14} aria-hidden className={active ? "text-electric-soft" : "opacity-60"} />
        <span className="sr-only">: sort {active && direction === "asc" ? "descending" : "ascending"}</span>
      </button>
    </th>
  );
}
