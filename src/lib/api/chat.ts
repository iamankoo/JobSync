import "server-only";
import { z } from "zod";
import { SheetsError } from "@/lib/google-sheets/errors";
import { ApiError } from "./responses";

/** The chat tabs are created by hand/script. Until they exist the chat is "not set up" rather than broken. */
export async function whenChatReady<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") {
      throw new ApiError(503, "chat_not_configured", "Group Chat is not set up yet: its tabs are missing from the spreadsheet.");
    }
    throw err;
  }
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const sendMessageSchema = z.strictObject({
  text: z.string().trim().min(1, "Write a message first.").max(4000, "Messages can be at most 4000 characters.").refine((v) => !CONTROL.test(v), "Invalid characters"),
});

export const readSchema = z.strictObject({ upToRow: z.number().int().min(1).max(10_000_000) });

export const pollSchema = z.object({
  after: z.coerce.number().int().min(0).max(10_000_000).default(0),
  since: z.string().max(40).optional(),
});
