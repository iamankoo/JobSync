export interface NavItem {
  label: string;
  href: string;
}

/** Exactly these five items: no Team Activity or Bookmarks. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "All Jobs", href: "/all-jobs" },
  { label: "Add Job", href: "/add-job" },
  { label: "My Applications", href: "/my-applications" },
  { label: "Analytics", href: "/analytics" },
];
