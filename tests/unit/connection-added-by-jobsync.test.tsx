// @vitest-environment jsdom
/** Connections JobSync created (Outreach Database import, Network Finder) are shown as "Added by JobSync", never under a member's name. */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ConnectionsBrowser } from "@/components/connections/connections-browser";
import { addedByJobSync } from "@/lib/connections/source";
import type { Connection } from "@/types/domain";

const at = "2026-11-14T10:00:00.000Z";
const base = { status: "Not Connected" as const, createdAt: at, updatedAt: at };
const LIST: Connection[] = [
  { ...base, connectionId: "conn_imp", memberId: "anni", name: "Imported Person", company: "Acme", notes: "Source: Outreach Database c_123\nContact: person-and-company" },
  { ...base, connectionId: "conn_nf", memberId: "rishii", name: "Found Person", company: "Bolt", notes: "Source: Network Finder — YC → apollo" },
  { ...base, connectionId: "conn_man", memberId: "lukky", name: "Manual Person", company: "Zed", notes: "Met at a meetup. Source: Outreach Database mentioned later" },
];

describe("addedByJobSync", () => {
  it("is true only for the automation's own marker at the start of the notes", () => {
    expect(LIST.map(addedByJobSync)).toEqual([true, true, false]);
    expect(addedByJobSync({})).toBe(false);
  });
});

describe("the Connections list and details", () => {
  it("rows show JobSync for automated Connections and the member for manual ones (even for the stored owner)", () => {
    render(<ConnectionsBrowser connections={LIST} me="anni" timeZone="Asia/Kolkata" />);
    const cells = screen.getAllByTestId("connection-row-added-by").map((e) => e.textContent?.trim());
    expect(cells).toEqual(["JobSync", "JobSync", "Lukky"]);
  });

  it("the details say 'Added by JobSync'", () => {
    render(<ConnectionsBrowser connections={LIST} me="anni" timeZone="Asia/Kolkata" initialConnectionId="conn_imp" />);
    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    expect(within(dialog).getByTestId("connection-added-by").textContent).toMatch(/^Added by JobSync on/);
  });
});
