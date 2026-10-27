import "server-only";
import { randomUUID } from "node:crypto";

export type IdPrefix = "job" | "act" | "conn" | "msg" | "file" | "sig" | "call" | "res" | "pho";

/** Collision-resistant, URL-safe ID, e.g. `job_3f2b...`. Generated server-side only. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}
