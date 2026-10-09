import "server-only";
import { randomUUID } from "node:crypto";

export type IdPrefix = "job" | "act";

/** Collision-resistant, URL-safe ID, e.g. `job_3f2b...`. Generated server-side only. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}
