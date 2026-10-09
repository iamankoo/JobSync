import { z } from "zod";
import { MEMBER_IDS } from "@/config/members";

export const loginSchema = z.object({
  memberId: z.enum(MEMBER_IDS),
  // Always a string so leading zeros ("0001") are preserved.
  code: z.string().min(1).max(32),
});

export type LoginInput = z.infer<typeof loginSchema>;
