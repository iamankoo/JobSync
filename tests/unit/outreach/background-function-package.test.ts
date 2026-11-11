/**
 * The Netlify Background Function package: the bundle that is actually deployed (built here with the real build script), its handler's
 * authentication, and the netlify.toml settings that make Netlify treat it as a BACKGROUND function. No Google, Gmail or network calls.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error plain ESM script without types
import { buildBackground } from "../../../scripts/build-background.mjs";

let outfile = "";
let code = "";

beforeAll(async () => {
  outfile = path.join(mkdtempSync(path.join(tmpdir(), "jobsync-bg-")), "outreach-background.mjs");
  await buildBackground({ outfile });
  code = readFileSync(outfile, "utf8");
}, 60_000);

describe("the bundled function", () => {
  it("is one self-contained ES module: only Node built-ins are imported, so nothing has to be installed next to it", () => {
    const specifiers = [...code.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  it("contains no Next.js runtime and no live `server-only` guard (which throws outside a server component); the thin shims stand in", () => {
    expect(code).not.toMatch(/node_modules\/next\//);
    expect(code).not.toMatch(/This module cannot be imported from a Client Component/);
    expect(code).toMatch(/after\(\) is not available in the background function/);
  });

  it("contains the real pipeline: the runner, the cycle, the send workflow and the import limit", () => {
    for (const marker of ["runOutreachRunner", "runOutreachCycle", "runSendStep", "runOutreachImport", "bg-runner", "run-lock"]) expect(code).toContain(marker);
  });

  it("has a default-exported handler and, because the file name ends in -background, deploys as a Netlify background function", async () => {
    expect(path.basename("netlify/functions/outreach-background.mjs")).toMatch(/-background\.mjs$/);
    const mod = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
    expect(typeof mod.default).toBe("function");
  });
});

describe("the handler fails closed", () => {
  const call = async (auth?: string) => {
    const mod = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
    return mod.default(new Request("https://x.test/.netlify/functions/outreach-background", { method: "POST", headers: auth ? { authorization: auth } : {} })) as Promise<Response>;
  };
  const keep = { secret: process.env.OUTREACH_CRON_SECRET, enabled: process.env.OUTREACH_ENABLED };
  const restore = () => {
    for (const [k, v] of [["OUTREACH_CRON_SECRET", keep.secret], ["OUTREACH_ENABLED", keep.enabled]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };

  it("refuses a request without the secret, with a wrong secret, or when no secret is configured, and starts nothing", async () => {
    try {
      delete process.env.OUTREACH_CRON_SECRET;
      expect((await call()).status).toBe(401);
      expect((await call("Bearer ")).status).toBe(401); // an empty secret must not match an empty configuration
      process.env.OUTREACH_CRON_SECRET = "right-secret";
      expect((await call()).status).toBe(401);
      expect((await call("Bearer wrong-secret")).status).toBe(401);
    } finally {
      restore();
    }
  });

  it("with the right secret but outreach switched off it returns at once without running a cycle", async () => {
    try {
      process.env.OUTREACH_CRON_SECRET = "right-secret";
      process.env.OUTREACH_ENABLED = "false";
      const t0 = Date.now();
      expect((await call("Bearer right-secret")).status).toBe(202);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      restore();
    }
  });
});

describe("netlify.toml and the build wiring", () => {
  const toml = readFileSync("netlify.toml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

  it("declares the function as a background function and builds it before the app", () => {
    expect(toml).toMatch(/\[functions\."outreach-background"\]\s*[\r\n]+\s*background\s*=\s*true/);
    expect(toml).toMatch(/directory\s*=\s*"netlify\/functions"/);
    expect(toml).toMatch(/command\s*=\s*"npm run build:netlify"/);
    expect(pkg.scripts["build:netlify"]).toBe("node scripts/build-background.mjs && next build");
  });

  it("does not use a Netlify scheduled function (30 s limit) and keeps the generated bundle out of Git", () => {
    expect(toml).not.toMatch(/schedule\s*=/);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/netlify\/functions\s*$/m);
  });

  it("the function source never uses Next.js after() for the long-running work", () => {
    const src = readFileSync("netlify/background-src/outreach-background.ts", "utf8") + readFileSync("src/lib/outreach/runner.ts", "utf8");
    expect(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/\bafter\s*\(|from "next\//);
  });
});
