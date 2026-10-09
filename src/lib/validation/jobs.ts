import { z } from "zod";
import { JOB_TYPES, WORK_MODES } from "@/types/domain";
import { MAX_URL_LENGTH, parseHttpUrl } from "@/lib/utils/url";
import { isIsoDate } from "@/lib/utils/time";

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const noControl = (v: string) => !CONTROL_CHARS.test(v);

/** Required single-line text. */
const text = (max: number) =>
  z.string().trim().min(1, "Required").max(max, `Max ${max} characters`).refine(noControl, "Invalid characters");

/** Optional text: empty strings and null become undefined. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v), schema.optional());

export const createJobSchema = z.strictObject({
  company: text(120),
  jobRole: text(160),
  jobType: z.enum(JOB_TYPES),
  workMode: optional(z.enum(WORK_MODES)),
  experience: optional(text(60)),
  stipendSalary: optional(text(80)),
  location: text(120),
  jobUrl: z
    .string()
    .trim()
    .max(MAX_URL_LENGTH, "URL is too long")
    .refine((u) => parseHttpUrl(u) !== null, "Enter a valid http(s) URL"),
  deadline: optional(z.string().trim().refine(isIsoDate, "Use a real date in YYYY-MM-DD format")),
  description: optional(z.string().trim().max(5000, "Max 5000 characters").refine(noControl, "Invalid characters")),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
