import "server-only";
import type { MemberId } from "@/config/members";
import type { ProfileInput } from "@/lib/validation/profile";
import { getSheetsClient } from "./client";
import { DomainError } from "./errors";
import { withWriteLock } from "./lock";
import { columnLetter, TABS } from "./schema";
import { invalidateTableCache, readTable } from "./table";

/**
 * Each member's own Profile page details, kept in the Members tab's optional columns E–J
 * (ProfileName, LinkedIn, GitHub, Email, Mobile, ProfileUpdatedAt). Only ever read or written for the
 * SESSION member; MemberID, Name, Photo and Active (A–D) are never written here.
 */
export interface Profile {
  name: string;
  linkedin: string;
  github: string;
  email: string;
  mobile: string;
  /** ISO timestamp of the last save, or "" if never saved. */
  updatedAt: string;
}

const FIRST = TABS.members.headers.length + 1; // column E
const LAST = FIRST + 5; // column J

async function locate(memberId: MemberId, fresh: boolean) {
  const rows = await readTable("members", { fresh });
  return rows.find((r) => r.cells[0]?.trim() === memberId);
}

const fromCells = (cells: string[]): Profile => {
  const [name = "", linkedin = "", github = "", email = "", mobile = "", updatedAt = ""] = cells.slice(FIRST - 1, LAST).map((c) => c.trim());
  return { name, linkedin, github, email, mobile, updatedAt };
};

export async function readProfile(memberId: MemberId): Promise<Profile> {
  const hit = await locate(memberId, true);
  if (!hit) throw new DomainError("member_inactive", "This member is not in the Members tab.");
  return fromCells(hit.cells);
}

/** Overwrites ONLY columns E–J of the member's own row. */
export async function saveProfile(memberId: MemberId, input: ProfileInput, now: Date = new Date()): Promise<Profile> {
  return withWriteLock(async () => {
    const hit = await locate(memberId, true);
    if (!hit) throw new DomainError("member_inactive", "This member is not in the Members tab.");
    const next: Profile = { ...input, updatedAt: now.toISOString() };
    const range = `${TABS.members.name}!${columnLetter(FIRST)}${hit.row}:${columnLetter(LAST)}${hit.row}`;
    try {
      await getSheetsClient().updateValues(range, [[next.name, next.linkedin, next.github, next.email, next.mobile, next.updatedAt]]);
    } finally {
      invalidateTableCache();
    }
    return next;
  });
}
