"use client";

import { RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/ui/filter-select";
import type { JobFilters } from "@/lib/jobs/query";

export interface FilterOptions {
  companies: string[];
  locations: string[];
  jobTypes: string[];
  experiences: string[];
  statuses: string[];
}

interface Props {
  filters: JobFilters;
  options: FilterOptions;
  searchLabel: string;
  searchPlaceholder: string;
  onChange: (patch: Partial<JobFilters>) => void;
  onReset: () => void;
  canReset: boolean;
}

/** Search + dropdown filters. Dropdown options come from the real records only. */
export function FilterBar({ filters, options, searchLabel, searchPlaceholder, onChange, onReset, canReset }: Props) {
  return (
    <div role="search" aria-label={searchLabel} className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-navy-900/70 p-3 md:grid-cols-3 xl:grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,1fr))_auto]">
      <label className="relative col-span-2 block md:col-span-3 xl:col-span-1">
        <span className="sr-only">{searchLabel}</span>
        <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={filters.query}
          onChange={(e) => onChange({ query: e.target.value })}
          placeholder={searchPlaceholder}
          className="h-11 w-full rounded-lg border border-line bg-navy-900 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted hover:border-electric-soft focus-visible:border-electric-soft"
        />
      </label>
      <FilterSelect label="Company" value={filters.company} onChange={(company) => onChange({ company })} options={options.companies} />
      <FilterSelect label="Location" value={filters.location} onChange={(location) => onChange({ location })} options={options.locations} />
      <FilterSelect label="Job Type" value={filters.jobType} onChange={(jobType) => onChange({ jobType })} options={options.jobTypes} />
      <FilterSelect label="Experience" value={filters.experience} onChange={(experience) => onChange({ experience })} options={options.experiences} />
      <FilterSelect label="Status" value={filters.status} onChange={(status) => onChange({ status })} options={options.statuses} />
      <Button onClick={onReset} disabled={!canReset} className="col-span-2 h-11 md:col-span-1">
        <RotateCcw size={16} aria-hidden /> Reset
      </Button>
    </div>
  );
}
