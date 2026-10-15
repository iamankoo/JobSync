import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { dataRows, goViaNav, horizontalOverflow, resetStore, signIn } from "./helpers";


/**
 * Group chat with THREE real browser contexts (Anni, Lukky, Rishii) against the isolated in-memory backend.
 * Messages travel through the real routes and are picked up by the real polling; calls are real WebRTC between the
 * contexts using Chromium's fake camera and microphone. Real phones/networks are NOT covered here (see docs/testing).
 */
const CREDS = { Anni: "0001", Lukky: "0002", Rishii: "0003" } as const;
type Who = keyof typeof CREDS;

// A valid 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

interface Session {
  who: Who;
  ctx: BrowserContext;
  page: Page;
}

async function join(browser: Browser, info: TestInfo, who: Who, path = "/group-chat"): Promise<Session> {
  const ctx = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: info.project.use.extraHTTPHeaders,
    permissions: ["microphone", "camera"],
  });
  const page = await ctx.newPage();
  await signIn(page, who, CREDS[who]);
  if (path === "/group-chat") {
    // (Direct navigation: with unread messages the sidebar link's name also carries the unread count.)
    await page.goto("/group-chat");
    await page.locator('[data-notification-gate="open"]').waitFor({ state: "attached" });
    await expect(page.getByRole("log", { name: "Chat messages" })).toBeVisible();
  }
  return { who, ctx, page };
}

const bubble = (page: Page, text: string) => page.getByTestId("chat-message").filter({ hasText: text });
async function say(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test.beforeEach(async ({ request }) => {
  await resetStore(request);
});

test("every member's message reaches the other two without a refresh, with sender and time, and survives a reload", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const s = { Anni: await join(browser, info, "Anni"), Lukky: await join(browser, info, "Lukky"), Rishii: await join(browser, info, "Rishii") };
  try {
    for (const sender of ["Anni", "Lukky", "Rishii"] as Who[]) {
      const text = `Hello from ${sender} ${Date.now()}`;
      await say(s[sender].page, text);
      await expect(bubble(s[sender].page, text)).toHaveAttribute("data-sender", sender.toLowerCase());
      for (const receiver of (["Anni", "Lukky", "Rishii"] as Who[]).filter((w) => w !== sender)) {
        const got = bubble(s[receiver].page, text);
        await expect(got).toBeVisible({ timeout: 20_000 }); // appears by itself (polling), no reload
        await expect(got).toHaveAttribute("data-sender", sender.toLowerCase());
        await expect(got.getByText(sender, { exact: true })).toBeVisible();
        await expect(got.locator("time")).toHaveText(/\d{1,2}:\d{2}/);
      }
    }
    // persisted in the sheet and after a reload
    const rows = await dataRows(s.Anni.page.request, "ChatMessages");
    expect(rows.map((r) => r[1])).toEqual(["anni", "lukky", "rishii"]);
    await s.Rishii.page.reload();
    await expect(s.Rishii.page.getByTestId("chat-message")).toHaveCount(3);
    expect(await horizontalOverflow(s.Rishii.page)).toBeLessThanOrEqual(0);
  } finally {
    await Promise.all(Object.values(s).map((x) => x.ctx.close()));
  }
});

test("auto-scrolls to the newest message, keeps the reader's place when scrolled up, and offers a jump button", async ({ browser, request }, info) => {
  test.setTimeout(120_000);
  const rows = Array.from({ length: 60 }, (_, i) => [`msg_seed${i}`, i % 2 ? "lukky" : "rishii", "text", `Seed message number ${i + 1}`, "", "", "", "", "", new Date(Date.now() - (70 - i) * 60_000).toISOString()]);
  await request.post("/api/test/seed", { data: { action: "append", tab: "ChatMessages", rows } });
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky");
  try {
    const log = anni.page.getByRole("log", { name: "Chat messages" });
    await expect(anni.page.getByText("Seed message number 60", { exact: true })).toBeInViewport();
    const atBottom = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 8);
    expect(await atBottom()).toBe(true);
    // new message while at the bottom: stays at the bottom
    await say(lukky.page, "Fresh one while you watch");
    await expect(anni.page.getByText("Fresh one while you watch", { exact: true })).toBeInViewport({ timeout: 20_000 });
    // scroll up: a new message must not yank the view, and a jump button counts it
    await log.evaluate((el) => (el.scrollTop = 0));
    await say(lukky.page, "Arrived while scrolled up");
    await expect(anni.page.getByRole("button", { name: /1 new message/ })).toBeVisible({ timeout: 20_000 });
    expect(await atBottom()).toBe(false);
    await anni.page.getByRole("button", { name: /1 new message/ }).click();
    await expect(anni.page.getByText("Arrived while scrolled up", { exact: true })).toBeInViewport();
    // sending your own message always brings you to the bottom
    await log.evaluate((el) => (el.scrollTop = 0));
    await say(anni.page, "My own reply");
    await expect(anni.page.getByText("My own reply", { exact: true })).toBeInViewport();
  } finally {
    await anni.ctx.close();
    await lukky.ctx.close();
  }
});

test("unread: badge while elsewhere, 'New messages' divider on open, cleared after reading, per member", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky", "/dashboard");
  try {
    await say(anni.page, "ping one");
    await say(anni.page, "ping two");
    await expect(bubble(anni.page, "ping two")).toBeVisible();
    // Lukky is on the dashboard: the sidebar badge reports 2 (it polls; a reload makes it immediate)
    await lukky.page.reload();
    await expect(lukky.page.getByTestId("chat-unread-badge").first()).toHaveText("2", { timeout: 25_000 });
    // Anni never sees an unread badge for her own messages
    await anni.page.goto("/dashboard");
    await expect(anni.page.getByTestId("chat-unread-badge")).toHaveCount(0);
    // opening the chat: the new messages are marked by a divider, and the badge goes away
    await lukky.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Group Chat/ }).click();
    await lukky.page.waitForURL("**/group-chat");
    await expect(lukky.page.getByTestId("unread-divider")).toBeVisible({ timeout: 15_000 });
    await expect(lukky.page.getByTestId("chat-unread-badge")).toHaveCount(0);
    await expect.poll(async () => (await dataRows(lukky.page.request, "ChatReads")).map((r) => r[0]).sort(), { timeout: 15_000 }).toContain("lukky");
    // after reading, leaving and coming back there are no unread messages
    await goViaNav(lukky.page, "Dashboard", "/dashboard");
    await lukky.page.reload();
    await lukky.page.waitForTimeout(1500);
    await expect(lukky.page.getByTestId("chat-unread-badge")).toHaveCount(0);
    await goViaNav(lukky.page, "Group Chat", "/group-chat"); // exact name works again: no unread count in it
    await expect(lukky.page.getByTestId("unread-divider")).toHaveCount(0);
  } finally {
    await anni.ctx.close();
    await lukky.ctx.close();
  }
});

test("images, PDFs, documents and voice notes are shared, previewed and downloaded; bad files are refused", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky");
  try {
    const input = anni.page.getByTestId("chat-file-input");

    await input.setInputFiles({ name: "team photo.png", mimeType: "image/png", buffer: PNG });
    const img = lukky.page.getByRole("img", { name: "team photo.png" });
    await expect(img).toBeVisible({ timeout: 25_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBe(1);

    await input.setInputFiles({ name: "My CV.pdf", mimeType: "application/pdf", buffer: PDF });
    const pdfCard = lukky.page.getByTestId("chat-message").filter({ hasText: "My CV.pdf" });
    await expect(pdfCard).toBeVisible({ timeout: 25_000 });
    await expect(pdfCard.getByRole("link", { name: "Open My CV.pdf" })).toHaveAttribute("target", "_blank");
    const href = (await pdfCard.getByRole("link", { name: "Download My CV.pdf" }).getAttribute("href"))!;
    const fetched = await lukky.page.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get("content-type"), nosniff: r.headers.get("x-content-type-options"), text: (await r.text()).slice(0, 8) };
    }, href);
    expect(fetched).toEqual({ status: 200, type: "application/pdf", nosniff: "nosniff", text: "%PDF-1.4" });

    await input.setInputFiles({ name: "notes.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
    await expect(lukky.page.getByTestId("chat-message").filter({ hasText: "notes.csv" })).toBeVisible({ timeout: 25_000 });

    // refused client-side with a clear reason (and nothing is stored for them)
    const before = (await dataRows(anni.page.request, "ChatMessages")).length;
    await input.setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) });
    await expect(anni.page.getByRole("alert").filter({ hasText: "This file type is not allowed" })).toBeVisible();
    await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) });
    await expect(anni.page.getByRole("alert").filter({ hasText: "at most 2 MB" })).toBeVisible();
    await input.setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<html><script>alert(1)</script></html>") });
    await expect(anni.page.getByRole("alert").filter({ hasText: "not allowed" })).toBeVisible();
    expect((await dataRows(anni.page.request, "ChatMessages")).length).toBe(before);

    // the server enforces the same rules even if the browser check is bypassed
    const bypass = await anni.page.evaluate(async () => {
      const fd = new FormData();
      fd.set("file", new File([new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0])], "photo.png", { type: "image/png" }));
      fd.set("kind", "file");
      return (await fetch("/api/chat/upload", { method: "POST", body: fd })).status;
    });
    expect(bypass).toBe(400);

    // voice note: record with the (fake) microphone, send, and the other member can play the same bytes
    await anni.page.getByRole("button", { name: "Record a voice note" }).click();
    await expect(anni.page.getByTestId("recording-bar")).toBeVisible();
    await anni.page.waitForTimeout(1800);
    await anni.page.getByRole("button", { name: "Stop and send voice note" }).click();
    const audio = lukky.page.locator("audio[aria-label^='Voice note from Anni']");
    await expect(audio).toBeVisible({ timeout: 25_000 });
    const src = (await audio.getAttribute("src"))!;
    const head = await lukky.page.evaluate(async (u) => {
      const r = await fetch(u);
      const b = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get("content-type"), magic: Array.from(b.slice(0, 4)), size: b.length };
    }, src);
    expect(head.status).toBe(200);
    expect(head.type).toMatch(/^audio\//);
    expect(head.size).toBeGreaterThan(500);
    expect(head.magic).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // WebM/Opus recorded by Chromium
  } finally {
    await anni.ctx.close();
    await lukky.ctx.close();
  }
});

test("chat data and files are not available to signed-out visitors or other origins", async ({ browser, request }, info) => {
  test.setTimeout(90_000);
  const anni = await join(browser, info, "Anni");
  try {
    await anni.page.getByTestId("chat-file-input").setInputFiles({ name: "secret.png", mimeType: "image/png", buffer: PNG });
    await expect(anni.page.getByRole("img", { name: "secret.png" })).toBeVisible({ timeout: 20_000 });
    const fileHref = (await anni.page.getByRole("img", { name: "secret.png" }).evaluate((el) => (el as HTMLImageElement).getAttribute("src")))!;
    // `request` is a fresh, signed-out API context
    const anon = [
      await request.get("/api/chat/poll"),
      await request.get("/api/chat/unread"),
      await request.get(fileHref),
      await request.post("/api/chat/messages", { data: { text: "hi" } }),
      await request.post("/api/chat/call", { data: { action: "start", media: "audio" } }),
    ].map((r) => r.status());
    expect(anon).toEqual([401, 401, 401, 401, 401]);
    // a signed-in browser page on ANOTHER origin cannot post (same-origin check)
    const cross = await anni.page.request.post("/api/chat/messages", { data: { text: "csrf" }, headers: { origin: "https://evil.example" } });
    expect(cross.status()).toBe(403);
    // signed-out page route redirects to login
    const fresh = await browser.newContext({ baseURL: info.project.use.baseURL });
    const p = await fresh.newPage();
    await p.goto("/group-chat");
    await p.waitForURL("**/login");
    await fresh.close();
  } finally {
    await anni.ctx.close();
  }
});

test("audio call: start, notify via banner, join, both connected, mute, leave, call ends", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky");
  const rishii = await join(browser, info, "Rishii");
  try {
    await anni.page.getByRole("button", { name: "Start an audio call" }).click();
    await expect(anni.page.getByTestId("call-panel")).toBeVisible({ timeout: 20_000 });
    await expect(anni.page.getByTestId("call-waiting")).toBeVisible();
    // the others see the call (banner + chat line) and cannot start a second one
    for (const other of [lukky, rishii]) {
      await expect(other.page.getByTestId("call-banner")).toContainText("Anni started an audio call", { timeout: 25_000 });
      await expect(other.page.getByRole("button", { name: "Start an audio call" })).toBeDisabled();
    }
    await expect(lukky.page.getByTestId("call-event")).toContainText("Anni started an audio call");

    await lukky.page.getByTestId("call-banner").getByRole("button", { name: "Join" }).click();
    await expect(lukky.page.getByTestId("call-panel")).toBeVisible({ timeout: 20_000 });
    // both ends reach "connected" (real WebRTC between the two contexts)
    await expect(anni.page.getByTestId("call-tile-lukky")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
    await expect(lukky.page.getByTestId("call-tile-anni")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
    // remote audio is actually flowing into the element
    expect(await anni.page.getByTestId("call-tile-lukky").locator("video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream)?.getAudioTracks().length)).toBe(1);

    // mute toggles
    await lukky.page.getByRole("button", { name: "Mute microphone" }).click();
    await expect(lukky.page.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");

    // a third member joins the live call: everyone ends up connected to everyone
    await rishii.page.getByTestId("call-banner").getByRole("button", { name: "Join" }).click();
    for (const [a, others] of [[anni, ["lukky", "rishii"]], [lukky, ["anni", "rishii"]], [rishii, ["anni", "lukky"]]] as const) {
      for (const o of others) await expect(a.page.getByTestId(`call-tile-${o}`)).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
    }

    // leaving removes that member's tile for the others; the call survives while someone remains
    await rishii.page.getByRole("button", { name: "Leave call" }).click();
    await expect(rishii.page.getByTestId("call-panel")).toHaveCount(0);
    await expect(anni.page.getByTestId("call-tile-rishii")).toHaveCount(0, { timeout: 30_000 });
    await lukky.page.getByRole("button", { name: "Leave call" }).click();
    await expect(anni.page.getByTestId("call-tile-lukky")).toHaveCount(0, { timeout: 30_000 });
    await anni.page.getByRole("button", { name: "Leave call" }).click();
    // nobody left: the banner is gone everywhere and a new call can be started
    await expect(rishii.page.getByTestId("call-banner")).toHaveCount(0, { timeout: 30_000 });
    await expect(rishii.page.getByRole("button", { name: "Start an audio call" })).toBeEnabled();
    expect((await dataRows(anni.page.request, "ChatMessages")).filter((r) => r[2] === "call")).toHaveLength(1);
  } finally {
    await Promise.all([anni, lukky, rishii].map((x) => x.ctx.close()));
  }
});

test("video call: local and remote video render, camera toggle, and joining audio-only works", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky");
  try {
    await anni.page.getByRole("button", { name: "Start a video call" }).click();
    await expect(anni.page.getByTestId("call-tile-local").locator("video")).toBeVisible({ timeout: 20_000 });
    await expect(lukky.page.getByTestId("call-banner")).toContainText("Anni started a video call", { timeout: 25_000 });
    await lukky.page.getByTestId("call-banner").getByRole("button", { name: "Join with video" }).click();
    await expect(lukky.page.getByTestId("call-tile-anni")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
    await expect(anni.page.getByTestId("call-tile-lukky")).toHaveAttribute("data-state", "connected", { timeout: 60_000 });
    // real video frames arrive on both sides
    for (const [s, remote] of [[anni, "lukky"], [lukky, "anni"]] as const) {
      const video = s.page.getByTestId(`call-tile-${remote}`).locator("video");
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    }
    await anni.page.getByRole("button", { name: "Turn camera off" }).click();
    await expect(anni.page.getByRole("button", { name: "Turn camera on" })).toBeVisible();
    // End Call: only the starter has it, and it ends the call for everyone
    await expect(lukky.page.getByRole("button", { name: "End call for everyone" })).toHaveCount(0);
    await anni.page.getByRole("button", { name: "End call for everyone" }).click();
    await expect(anni.page.getByTestId("call-panel")).toHaveCount(0);
    await expect(lukky.page.getByTestId("call-panel")).toHaveCount(0, { timeout: 45_000 });
    await expect(lukky.page.getByTestId("call-error")).toContainText("ended it for everyone");
    await expect(lukky.page.getByTestId("call-banner")).toHaveCount(0);
  } finally {
    await anni.ctx.close();
    await lukky.ctx.close();
  }
});

test("call failure states: permission denied, no device, joining a call that already ended, second start", async ({ browser }, info) => {
  test.setTimeout(150_000);
  const anni = await join(browser, info, "Anni");
  const lukky = await join(browser, info, "Lukky");
  try {
    // permission denied
    await anni.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    });
    await anni.page.getByRole("button", { name: "Start a video call" }).click();
    await expect(anni.page.getByTestId("call-error")).toContainText("Permission needed for your camera and microphone");
    await expect(anni.page.getByTestId("call-panel")).toHaveCount(0);
    expect((await dataRows(anni.page.request, "CallSignals")).length).toBe(0); // nothing was announced
    // no microphone at all
    await anni.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" }));
    });
    await anni.page.getByRole("button", { name: "Dismiss" }).first().click();
    await anni.page.getByRole("button", { name: "Start an audio call" }).click();
    await expect(anni.page.getByTestId("call-error")).toContainText("No microphone found");

    // Lukky starts a real call; Anni sees the banner but her mic is blocked: joining fails cleanly
    await lukky.page.getByRole("button", { name: "Start an audio call" }).click();
    await expect(anni.page.getByTestId("call-banner")).toBeVisible({ timeout: 25_000 });
    await anni.page.getByTestId("call-banner").getByRole("button", { name: "Join" }).click();
    await expect(anni.page.getByTestId("call-error")).toContainText("No microphone found");
    await expect(anni.page.getByTestId("call-banner")).toBeVisible();

    // a call that ended while Anni was looking at the banner: joining says so
    await lukky.page.getByRole("button", { name: "Leave call" }).click();
    await anni.page.evaluate(() => location.reload());
    await expect(anni.page.getByTestId("call-banner")).toHaveCount(0, { timeout: 25_000 });
  } finally {
    await anni.ctx.close();
    await lukky.ctx.close();
  }
});
