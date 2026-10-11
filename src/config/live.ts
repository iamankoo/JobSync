/**
 * How often open pages quietly re-fetch their data so changes from other members show up without
 * a manual reload. Google Sheets cannot push changes, so this is polling (plus a refresh whenever
 * the tab becomes visible again). Overridable for tests via NEXT_PUBLIC_AUTO_REFRESH_MS.
 */
export const AUTO_REFRESH_MS = Number(process.env.NEXT_PUBLIC_AUTO_REFRESH_MS) > 0 ? Number(process.env.NEXT_PUBLIC_AUTO_REFRESH_MS) : 30_000;
