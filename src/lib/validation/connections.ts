import { z } from "zod";
import { CONNECTION_STATUSES } from "@/types/domain";
import { MAX_URL_LENGTH, normalizeCompanyUrl, parseHttpUrl } from "@/lib/utils/url";
import { applyRoleProblem, CUSTOM_ROLE_MAX, isRoleCategory } from "@/lib/connections/apply-role";

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const noControl = (v: string) => !CONTROL_CHARS.test(v);

/** Optional: empty strings and null become undefined. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v), schema.optional());

const line = (max: number) => z.string().trim().max(max, `Max ${max} characters`).refine(noControl, "Invalid characters");
const longText = (max: number) => z.string().trim().max(max, `Max ${max} characters`).refine(noControl, "Invalid characters");
const url = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH, "URL is too long")
  .refine((u) => parseHttpUrl(u) !== null, "Enter a valid http(s) URL");

export const EMAIL_MAX = 254;
/** Simple, permissive address check (something@domain.tld, no spaces); the mail client is the real judge. */
export function isEmailAddress(v: string): boolean {
  return v.length <= EMAIL_MAX && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(v);
}
const email = z.string().trim().max(EMAIL_MAX, "Email is too long").refine((v) => isEmailAddress(v), "Enter a valid email address");

export const MESSAGE_MAX = 2000;
export const NOTES_MAX = 2000;

const companyUrl = optional(
  z
    .string()
    .trim()
    .max(MAX_URL_LENGTH, "URL is too long")
    .transform((v, ctx) => {
      const normalised = normalizeCompanyUrl(v);
      if (!normalised) {
        ctx.addIssue({ code: "custom", message: "Enter a valid website address, e.g. https://acme.com" });
        return z.NEVER;
      }
      return normalised;
    }),
);

/**
 * Editable fields. The six the form shows: name, role (the person's DESIGNATION), email, company, companyUrl and the
 * Role to Apply (roleCategory + applyRole). profileUrl / otherUrl / message / notes are HISTORICAL: still accepted from
 * old API payloads and still stored and shown on old records, but no longer part of the Add/Edit form.
 */
const fields = {
  name: line(120).min(1, "Required"),
  company: optional(line(120)),
  role: optional(line(120)),
  email: optional(email),
  companyUrl,
  roleCategory: optional(z.string().trim().max(20, "Invalid role category")),
  applyRole: optional(line(CUSTOM_ROLE_MAX)),
  profileUrl: optional(url),
  otherUrl: optional(url),
  message: optional(longText(MESSAGE_MAX)),
  notes: optional(longText(NOTES_MAX)),
  status: z.enum(CONNECTION_STATUSES),
};

/** Permissive create (Network Finder and other server-side callers): only the name is required. */
export const createConnectionSchema = z.strictObject({ ...fields, status: fields.status.default("Not Connected") });

type Roleish = { roleCategory?: string; applyRole?: string };
/** Refinements normally skip when a field already failed; these must still run so the form can show every problem at once. */
const always = () => true;
const roleProblemOf = (iss: { input?: unknown }) => {
  const v = (iss.input ?? {}) as Roleish;
  return applyRoleProblem(v.roleCategory, v.applyRole) ?? "Invalid role";
};

/** The category must be chosen, then the role must be one of its options (or a custom role for Other). */
function requireRole<S extends z.ZodType<Roleish>>(schema: S, applies: (v: Roleish) => boolean = () => true) {
  return schema
    .refine((v) => !applies(v) || isRoleCategory(v.roleCategory), { path: ["roleCategory"], error: () => applyRoleProblem(undefined, undefined) ?? "Choose a role category", when: always })
    .refine((v) => !applies(v) || !isRoleCategory(v.roleCategory) || applyRoleProblem(v.roleCategory, v.applyRole) === null, { path: ["applyRole"], error: roleProblemOf, when: always });
}

/**
 * Body of POST /api/connections (the Add form). The owner is always the session member; the body cannot name one.
 * Required: Person Name, Person Email, Company Name and a valid Role to Apply (category + final role).
 */
export const createManualConnectionSchema = requireRole(
  createConnectionSchema
    .refine((v) => Boolean(v.email), { path: ["email"], message: "Required", when: always })
    .refine((v) => Boolean(v.company), { path: ["company"], message: "Required", when: always }),
);

/**
 * Body of PUT /api/connections/:id: any subset of the editable fields (at least one). Clearing an optional field = empty string.
 * A required field that is sent must not be blank, and the Role to Apply is always saved as a valid pair.
 */
export const updateConnectionSchema = requireRole(
  z
    .strictObject({ ...fields, name: fields.name.optional(), status: fields.status.optional() })
    .refine((v) => Object.keys(v).length > 0, "Nothing to update")
    .refine((v) => !("email" in v) || Boolean(v.email), { path: ["email"], message: "Required", when: always })
    .refine((v) => !("company" in v) || Boolean(v.company), { path: ["company"], message: "Required", when: always }),
  (v) => "roleCategory" in v || "applyRole" in v,
);

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;
