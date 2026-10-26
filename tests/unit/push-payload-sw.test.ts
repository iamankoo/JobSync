import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { chatMessagePayload, clean, connectionAddedPayload, jobAddedPayload, jobAppliedPayload, jobUrl, recipientsFor, safeUrl } from "@/lib/push/payload";
import { isAllowedPushEndpoint, subscribeSchema, unsubscribeSchema } from "@/lib/push/validation";
import { loadVapidConfig } from "@/lib/push/config";

describe("recipients", () => {
  it("are always exactly the other two members", () => {
    expect(recipientsFor("anni")).toEqual(["lukky", "rishii"]);
    expect(recipientsFor("lukky")).toEqual(["anni", "rishii"]);
    expect(recipientsFor("rishii")).toEqual(["anni", "lukky"]);
  });
});

describe("payload text", () => {
  const job = { jobId: "job_abc-1", company: "Acme Corp", jobRole: "Software Engineer" };
  it("matches the required wording and includes the company", () => {
    const added = jobAddedPayload("anni", job);
    expect(added.title).toBe("Anni added a job: Software Engineer");
    expect(added.body).toContain("Acme Corp");
    expect(jobAppliedPayload("rishii", { ...job, jobRole: "Frontend Engineer" }).title).toBe("Rishii applied for Frontend Engineer — hurry up!");
    expect(jobAppliedPayload("lukky", { ...job, jobRole: "Backend Developer" }).title).toBe("Lukky applied for Backend Developer — hurry up!");
  });
  it("opens the job and carries the sender's public photo only", () => {
    const p = jobAddedPayload("lukky", job);
    expect(p.url).toBe("/all-jobs?job=job_abc-1");
    expect(p.icon).toBe("/assets/lukky.jpeg");
    expect(Object.keys(p).sort()).toEqual(["body", "icon", "tag", "title", "url"]);
  });
  it("strips control characters and bounds length", () => {
    expect(clean("a\u0000b\nc\t d", 50)).toBe("a b c d");
    expect(clean("x".repeat(300), 20)).toHaveLength(20);
    expect(jobAddedPayload("anni", { ...job, jobRole: "R".repeat(500) }).title.length).toBeLessThanOrEqual(110);
  });
});

describe("connection and chat payloads", () => {
  it("connection: who added whom, at which company; opens Connections; never the message or notes", () => {
    const p = connectionAddedPayload("rishii", { connectionId: "conn_1", name: "Priya", company: "Acme", role: "Recruiter" });
    expect(p).toEqual({ title: "Rishii added a connection: Priya", body: "Recruiter · Acme — tap to view in Connections.", url: "/connections", tag: "connection-added-conn_1", icon: "/assets/rishii.jpeg" });
  });
  it("chat: names the sender, previews the text, one collapsing tag per sender", () => {
    const p = chatMessagePayload("anni", { messageId: "msg_1", kind: "text", text: "hi\nthere" });
    expect(p).toEqual({ title: "New Group Chat message from Anni", body: "hi there", url: "/group-chat", tag: "chat-anni", icon: "/assets/anni.jpeg" });
    expect(chatMessagePayload("anni", { messageId: "msg_2", kind: "text", text: "  " }).body).toBe("Open Group Chat to read it.");
  });
});

describe("click destinations", () => {
  it("only emits same-origin job URLs with well-formed IDs", () => {
    expect(jobUrl("job_1")).toBe("/all-jobs?job=job_1");
    expect(jobUrl("../../evil?x=1")).toBe("/all-jobs");
  });
  it("safeUrl rejects other origins and unknown paths", () => {
    const origin = "https://jobsbyarillabs.vercel.app";
    expect(safeUrl("/all-jobs?job=job_1", origin)).toBe("/all-jobs?job=job_1");
    expect(safeUrl("https://evil.example/all-jobs", origin)).toBe("/dashboard");
    expect(safeUrl("//evil.example/x", origin)).toBe("/dashboard");
    expect(safeUrl("javascript:alert(1)", origin)).toBe("/dashboard");
    expect(safeUrl("/api/auth/logout", origin)).toBe("/dashboard");
    expect(safeUrl("/connections", origin)).toBe("/connections");
    expect(safeUrl("/group-chat", origin)).toBe("/group-chat");
  });
});

describe("subscription validation", () => {
  const keys = { p256dh: "BPk1234567890abcd", auth: "auth1234567890" };
  it("accepts real push service hosts only", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://wns2-par02p.notify.windows.com/x"]) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "https://example.com/x", "https://fcm.googleapis.com.evil.io/x", "not a url"]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });
  it("is strict about the body", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    expect(subscribeSchema.safeParse({ endpoint, keys }).success).toBe(true);
    expect(subscribeSchema.safeParse({ endpoint, keys, memberId: "anni" }).success).toBe(false);
    expect(subscribeSchema.safeParse({ endpoint, keys: { ...keys, extra: "x" } }).success).toBe(false);
    expect(subscribeSchema.safeParse({ endpoint, keys: { p256dh: "<script>", auth: keys.auth } }).success).toBe(false);
    expect(unsubscribeSchema.safeParse({ endpoint }).success).toBe(true);
    expect(unsubscribeSchema.safeParse({ endpoint, memberId: "lukky" }).success).toBe(false);
  });
});

describe("VAPID config", () => {
  it("is null unless both keys are set, and defaults the subject", () => {
    expect(loadVapidConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadVapidConfig({ VAPID_PUBLIC_KEY: "a" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(loadVapidConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ subject: "https://jobsbyarillabs.vercel.app" });
  });
});

// ---- the real public/sw.js, run in a sandbox with a fake service-worker scope ----
function loadServiceWorker(windows: { url: string; focus: () => Promise<void>; navigate?: (u: string) => Promise<void> }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const self = {
    location: { origin: "https://jobsbyarillabs.vercel.app" },
    registration: { showNotification },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8"), { self, URL, console });
  const waits: Promise<unknown>[] = [];
  const event = (extra: object) => ({ waitUntil: (p: Promise<unknown>) => waits.push(p), ...extra });
  return { handlers, showNotification, openWindow, event, settle: () => Promise.all(waits) };
}

describe("service worker (public/sw.js)", () => {
  it("shows a system notification for a push", async () => {
    const sw = loadServiceWorker();
    const payload = { title: "Anni added a job: Software Engineer", body: "Acme Corp — tap to view the job.", url: "/all-jobs?job=job_1", tag: "job-added-job_1", icon: "/assets/anni.jpeg" };
    sw.handlers.push(sw.event({ data: { json: () => payload } }));
    await sw.settle();
    expect(sw.showNotification).toHaveBeenCalledWith("Anni added a job: Software Engineer", {
      body: "Acme Corp — tap to view the job.", tag: "job-added-job_1", data: { url: "/all-jobs?job=job_1" }, icon: "/assets/anni.jpeg",
    });
  });

  it("still shows a generic notification for an empty or malformed push, and ignores foreign icons/URLs", async () => {
    const sw = loadServiceWorker();
    sw.handlers.push(sw.event({ data: { json: () => { throw new Error("bad json"); } } }));
    sw.handlers.push(sw.event({ data: { json: () => ({ title: "T", url: "https://evil.example/", icon: "https://evil.example/i.png" }) } }));
    await sw.settle();
    expect(sw.showNotification).toHaveBeenNthCalledWith(1, "JobSync", expect.objectContaining({ data: { url: "/dashboard" } }));
    const second = (sw.showNotification.mock.calls[1] as unknown as [string, Record<string, unknown>])[1];
    expect(second.data).toEqual({ url: "/dashboard" });
    expect(second.icon).toBeUndefined();
  });

  it("clicking focuses an open JobSync window and navigates it to the job", async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const sw = loadServiceWorker([{ url: "https://jobsbyarillabs.vercel.app/dashboard", focus, navigate }]);
    const close = vi.fn();
    sw.handlers.notificationclick(sw.event({ notification: { close, data: { url: "/all-jobs?job=job_1" } } }));
    await sw.settle();
    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/all-jobs?job=job_1");
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it("clicking opens a new window when JobSync is not open", async () => {
    const sw = loadServiceWorker([]);
    sw.handlers.notificationclick(sw.event({ notification: { close: vi.fn(), data: { url: "/all-jobs?job=job_9" } } }));
    await sw.settle();
    expect(sw.openWindow).toHaveBeenCalledWith("/all-jobs?job=job_9");
  });

  it("opens Connections from a new-connection notification", async () => {
    const sw = loadServiceWorker([]);
    sw.handlers.notificationclick(sw.event({ notification: { close: vi.fn(), data: { url: "/connections" } } }));
    await sw.settle();
    expect(sw.openWindow).toHaveBeenCalledWith("/connections");
  });

  const chatPush = { title: "New Group Chat message from Lukky", body: "hello", url: "/group-chat", tag: "chat-lukky", icon: "/assets/lukky.jpeg" };
  type Win = { url: string; focus: () => Promise<void>; visibilityState?: string; focused?: boolean };

  it("shows Group Chat messages and re-alerts for each new one from the same sender", async () => {
    const sw = loadServiceWorker([{ url: "https://jobsbyarillabs.vercel.app/dashboard", focus: vi.fn(), visibilityState: "visible", focused: true } as Win]);
    sw.handlers.push(sw.event({ data: { json: () => chatPush } }));
    await sw.settle();
    expect(sw.showNotification).toHaveBeenCalledWith("New Group Chat message from Lukky", {
      body: "hello", tag: "chat-lukky", data: { url: "/group-chat" }, icon: "/assets/lukky.jpeg", renotify: true,
    });
  });

  it("skips the popup only while this member is actively looking at Group Chat", async () => {
    const reading = loadServiceWorker([{ url: "https://jobsbyarillabs.vercel.app/group-chat", focus: vi.fn(), visibilityState: "visible", focused: true } as Win]);
    reading.handlers.push(reading.event({ data: { json: () => chatPush } }));
    await reading.settle();
    expect(reading.showNotification).not.toHaveBeenCalled();

    for (const win of [
      { url: "https://jobsbyarillabs.vercel.app/group-chat", visibilityState: "hidden", focused: false }, // chat tab in the background
      { url: "https://jobsbyarillabs.vercel.app/group-chat", visibilityState: "visible", focused: false }, // another window has focus
    ]) {
      const sw = loadServiceWorker([{ ...win, focus: vi.fn() } as Win]);
      sw.handlers.push(sw.event({ data: { json: () => chatPush } }));
      await sw.settle();
      expect(sw.showNotification, JSON.stringify(win)).toHaveBeenCalledTimes(1);
    }
  });

  it("other notifications are always shown, even with Group Chat open", async () => {
    const sw = loadServiceWorker([{ url: "https://jobsbyarillabs.vercel.app/group-chat", focus: vi.fn(), visibilityState: "visible", focused: true } as Win]);
    sw.handlers.push(sw.event({ data: { json: () => ({ title: "Anni added a connection: Priya", url: "/connections", tag: "connection-added-conn_1" }) } }));
    await sw.settle();
    expect(sw.showNotification).toHaveBeenCalledWith("Anni added a connection: Priya", { body: "", tag: "connection-added-conn_1", data: { url: "/connections" } });
  });

  it("never opens an unsafe destination", async () => {
    for (const url of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/api/auth/logout"]) {
      const sw = loadServiceWorker([]);
      sw.handlers.notificationclick(sw.event({ notification: { close: vi.fn(), data: { url } } }));
      await sw.settle();
      expect(sw.openWindow, url).toHaveBeenCalledWith("/dashboard");
    }
  });
});
