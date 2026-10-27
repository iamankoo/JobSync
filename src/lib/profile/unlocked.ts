import "server-only";
import { NextResponse } from "next/server";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { gmailOverview } from "@/lib/gmail/overview";
import { listResumes, type ResumeInfo } from "@/lib/google-sheets/member-files-service";
import { readProfile, type Profile } from "@/lib/google-sheets/profile-service";
import { unlockCookie } from "./lock-service";

/** Everything the Profile shows, sent ONLY in the response to a successful unlock / password setup. */
export interface UnlockedProfile {
  profile: Profile;
  /** null while the MemberFiles tab does not exist. */
  resumes: ResumeInfo[] | null;
  gmail: { configured: boolean; setUp: boolean; status: string; email?: string };
}

export async function unlockedProfile(memberId: MemberId): Promise<UnlockedProfile> {
  const [profile, resumes, gmail] = await Promise.all([readProfile(memberId), listResumes(memberId), gmailOverview(memberId, MEMBER_IDS)]);
  return { profile, resumes, gmail: { configured: gmail.configured, setUp: gmail.setUp, status: gmail.me.status, ...(gmail.me.email ? { email: gmail.me.email } : {}) } };
}

/** 200 with the Profile data and the unlock cookie. */
export async function unlockedResponse(memberId: MemberId, token: string): Promise<Response> {
  const res = NextResponse.json({ data: await unlockedProfile(memberId) }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(unlockCookie(token));
  return res;
}
