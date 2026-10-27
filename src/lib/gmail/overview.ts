import "server-only";
import type { MemberId } from "@/config/members";
import { SheetsError } from "@/lib/google-sheets/errors";
import { loadGmailConfig } from "./config";
import { readGmailAccounts, type GmailStatus } from "./store";

export interface GmailOverview {
  /** OAuth client + encryption key are configured on the server. */
  configured: boolean;
  /** The NF_GmailAccounts tab exists. */
  setUp: boolean;
  me: { status: GmailStatus | "not_connected"; email?: string; connectedAt?: string };
  /** Other members: connected or not (never their address or anything else). */
  members: { id: MemberId; connected: boolean }[];
}

export async function gmailOverview(me: MemberId, all: readonly MemberId[]): Promise<GmailOverview> {
  const configured = loadGmailConfig().ok;
  try {
    const accounts = await readGmailAccounts();
    const mine = accounts.find((a) => a.memberId === me);
    return {
      configured,
      setUp: true,
      me: mine && mine.status !== "disconnected" ? { status: mine.status, email: mine.email, connectedAt: mine.connectedAt } : { status: "not_connected" },
      members: all.map((id) => ({ id, connected: accounts.some((a) => a.memberId === id && a.status === "connected") })),
    };
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") {
      return { configured, setUp: false, me: { status: "not_connected" }, members: all.map((id) => ({ id, connected: false })) };
    }
    throw err;
  }
}
