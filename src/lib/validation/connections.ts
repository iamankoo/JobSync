import { z } from "zod";
import { CONNECTION_STATUSES } from "@/types/domain";
import { MAX_URL_LENGTH, parseHttpUrl } from "@/lib/utils/url";

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

export const MESSAGE_MAX = 2000;
export const NOTES_MAX = 2000;

const fields = {
  name: line(120).min(1, "Required"),
  company: optional(line(120)),
  role: optional(line(120)),
  profileUrl: optional(url),
  otherUrl: optional(url),
  message: optional(longText(MESSAGE_MAX)),
  notes: optional(longText(NOTES_MAX)),
  status: z.enum(CONNECTION_STATUSES),
};

/** Body of POST /api/connections. The owner is always the session member; the body cannot name one. */
export const createConnectionSchema = z.strictObject({ ...fields, status: fields.status.default("Not Connected") });

/** Body of PUT /api/connections/:id: any subset of the editable fields (at least one). Clearing an optional field = empty string. */
export const updateConnectionSchema = z
  .strictObject({ ...fields, name: fields.name.optional(), status: fields.status.optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;
