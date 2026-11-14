// @vitest-environment jsdom
/** A "connection added" notification opens THAT Connection: /connections?connection=<id> opens its details; anything else just shows the list. */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ConnectionsBrowser } from "@/components/connections/connections-browser";
import { connectionAddedPayload, connectionUrl, safeUrl } from "@/lib/push/payload";
import type { Connection } from "@/types/domain";

const at = "2026-11-14T10:00:00.000Z";
const LIST: Connection[] = [
  { connectionId: "conn_a1", memberId: "anni", name: "Priya Sharma", company: "Acme", role: "Engineering Manager", status: "Not Connected", createdAt: at, updatedAt: at },
  { connectionId: "conn_b2", memberId: "lukky", name: "Raj Mehta", company: "Bolt", role: "Recruiter", status: "Not Connected", createdAt: at, updatedAt: at },
];

describe("the link", () => {
  it("names the Connection and survives the click-destination allowlist", () => {
    const p = connectionAddedPayload("anni", LIST[0]);
    expect(p.url).toBe("/connections?connection=conn_a1");
    expect(safeUrl(p.url)).toBe("/connections?connection=conn_a1");
  });
  it("a malformed id never reaches the URL", () => {
    expect(connectionUrl("x\"><script>")).toBe("/connections");
    expect(connectionUrl("")).toBe("/connections");
  });
});

describe("the Connections page", () => {
  it("opens the linked Connection's details", () => {
    render(<ConnectionsBrowser connections={LIST} me="rishii" timeZone="Asia/Kolkata" initialConnectionId="conn_b2" />);
    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    expect(within(dialog).getByText("Raj Mehta")).toBeTruthy();
    expect(within(dialog).queryByText("Priya Sharma")).toBeNull();
  });
  it("an unknown or missing id just shows the list", () => {
    const { unmount } = render(<ConnectionsBrowser connections={LIST} me="rishii" timeZone="Asia/Kolkata" initialConnectionId="conn_gone" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    render(<ConnectionsBrowser connections={LIST} me="rishii" timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
