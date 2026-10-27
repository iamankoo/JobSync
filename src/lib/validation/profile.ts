import { z } from "zod";
import { EMAIL_MAX, isEmailAddress } from "./connections";

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const line = (max: number) => z.string().trim().max(max, `Max ${max} characters`).refine((v) => !CONTROL_CHARS.test(v), "Invalid characters");

/** Empty is allowed for every field (a member fills in what they want, when they want). */
const blankOr = (schema: z.ZodType<string>) =>
  z.string().trim().superRefine((v, ctx) => {
    if (v === "") return;
    const r = schema.safeParse(v);
    if (!r.success) ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Invalid value" });
  });

export const PROFILE_HANDLE_MAX = 200;
export const MOBILE_PATTERN = /^\+?[0-9][0-9 ()-]{5,19}$/;

/** A LinkedIn / GitHub ID or full profile URL. No spaces; the member decides which. */
const handleOrUrl = line(PROFILE_HANDLE_MAX).refine((v) => !/\s/.test(v), "No spaces allowed");

/** Body of PUT /api/profile. All five fields are sent each time; the member is always the session member. */
export const profileSchema = z.strictObject({
  name: line(120),
  linkedin: blankOr(handleOrUrl),
  github: blankOr(handleOrUrl),
  email: blankOr(z.string().max(EMAIL_MAX, "Email is too long").refine(isEmailAddress, "Enter a valid email address")),
  mobile: blankOr(z.string().regex(MOBILE_PATTERN, "Enter a valid mobile number (digits, spaces, +, -, brackets)")),
});

export type ProfileInput = z.infer<typeof profileSchema>;
