/**
 * Static guard: the Gmail send endpoint is reachable only through the gated outreach send workflow. If someone adds another caller,
 * this fails and forces a review.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SENDING_ENABLED } from "@/lib/outreach/types";

const root = path.resolve(import.meta.dirname, "../../../src");
const files: string[] = [];
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
};
walk(root);
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
const using = (re: RegExp) => files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map(rel).sort();

describe("the sending surface", () => {
  it("the sending switch is a compile-time constant (not configuration)", () => {
    expect(SENDING_ENABLED).toBe(true);
  });

  it("sendDraftFor / the drafts.send endpoint exist only in gmail/send.ts and the gated wiring in outreach/run.ts", () => {
    expect(using(/\bsendDraftFor\b|drafts\/send|SEND_ENDPOINT/)).toEqual(["lib/gmail/send.ts", "lib/outreach/run.ts"]);
  });

  it("the real send wiring is constructed only when the gate is open, and no environment variable can open it", () => {
    const run = fs.readFileSync(path.join(root, "lib/outreach/run.ts"), "utf8");
    expect(run).toContain("const gate: boolean = SENDING_ENABLED;");
    expect(run).toMatch(/\.\.\.\(gate\s*\?\s*\{\s*send: async \(\) => \{/);
    expect(run).toContain("runSendStep(buildRealSendDeps(config, sheet, timezone");
    expect(fs.readFileSync(path.join(root, "lib/outreach/types.ts"), "utf8")).toContain("export const SENDING_ENABLED = true as const;");
    expect(using(/process\.env\.[A-Z_]*SEND(ING)?_ENABLED/)).toEqual([]);
  });

  it("no other Gmail call that sends, deletes, trashes or modifies mail exists", () => {
    const gmailCode = (f: string) => /^lib\/(gmail|outreach|network-finder)\//.test(f);
    expect(using(/messages\/send|\/trash|users\/me\/messages\/[^`'"]*\/(modify|trash|delete)|method:\s*"DELETE"/).filter(gmailCode)).toEqual([]);
  });
});
