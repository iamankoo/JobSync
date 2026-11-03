/**
 * "Role to Apply": a category plus the final role. Shared by the Add/Edit form (client) and the server validation so the
 * two can never drift. Pure (no I/O, safe in the browser).
 */
export const ROLE_CATEGORIES = ["SDE", "AI/ML", "Web D", "Data", "Other"] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export const ROLE_OPTIONS: Record<Exclude<RoleCategory, "Other">, readonly string[]> = {
  SDE: ["Software Engineer", "Software Developer", "Backend Engineer"],
  "AI/ML": ["AI/ML Engineer", "Applied AI Engineer", "Agentic AI Engineer", "AI Engineer", "Machine Learning Engineer", "Python Developer"],
  "Web D": ["Full Stack Engineer", "Front End Developer", "Web Developer", "App Developer"],
  Data: ["Data Engineer", "Data Analyst", "Data Scientist", "Data Entry"],
};

export const CUSTOM_ROLE_MIN = 2;
export const CUSTOM_ROLE_MAX = 80;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export const isRoleCategory = (v: unknown): v is RoleCategory => typeof v === "string" && (ROLE_CATEGORIES as readonly string[]).includes(v);

/** The specific roles offered for a category (empty for "Other", which takes a custom role). */
export function rolesFor(category: RoleCategory | ""): readonly string[] {
  return category && category !== "Other" ? ROLE_OPTIONS[category] : [];
}

/** Checks a category + final role pair. Returns the problem text, or null when valid. */
export function applyRoleProblem(category: string | undefined, role: string | undefined): string | null {
  const r = (role ?? "").trim();
  if (!isRoleCategory(category)) return "Choose a role category";
  if (!r) return category === "Other" ? "Enter the role" : "Choose a role";
  if (CONTROL_CHARS.test(r)) return "Invalid characters";
  if (category === "Other") {
    if (r.length < CUSTOM_ROLE_MIN) return `Enter at least ${CUSTOM_ROLE_MIN} characters`;
    if (r.length > CUSTOM_ROLE_MAX) return `Max ${CUSTOM_ROLE_MAX} characters`;
    return null;
  }
  return rolesFor(category).includes(r) ? null : "Choose a role from the list";
}

/**
 * Historical connections have no category: the role their description named (if any) is OFFERED as a starting point in the
 * edit form and never saved unless the member saves it. A role that is one of the listed ones selects its category;
 * anything else becomes a custom "Other" role.
 */
export function suggestApplyRole(legacyTitle: string | undefined): { category: RoleCategory; role: string } | null {
  const t = (legacyTitle ?? "").trim();
  if (!t) return null;
  for (const cat of Object.keys(ROLE_OPTIONS) as (keyof typeof ROLE_OPTIONS)[]) {
    const hit = ROLE_OPTIONS[cat].find((o) => o.toLowerCase() === t.toLowerCase());
    if (hit) return { category: cat, role: hit };
  }
  return t.length >= CUSTOM_ROLE_MIN && t.length <= CUSTOM_ROLE_MAX && !CONTROL_CHARS.test(t) ? { category: "Other", role: t } : null;
}
