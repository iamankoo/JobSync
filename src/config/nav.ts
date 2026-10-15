export interface NavItem {
  label: string;
  href: string;
}

/** The five original items, then Connections and Group Chat below Analytics. No Team Activity or Bookmarks. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "All Jobs", href: "/all-jobs" },
  { label: "Add Job", href: "/add-job" },
  { label: "My Applications", href: "/my-applications" },
  { label: "Analytics", href: "/analytics" },
  { label: "Connections", href: "/connections" },
  { label: "Group Chat", href: "/group-chat" },
];
