/* JobSync service worker: shows Web Push notifications and opens the right page when one is clicked.
 * It caches nothing and intercepts no requests, so it cannot change how the site loads. */

const SAFE_PATHS = ["/dashboard", "/all-jobs", "/my-applications", "/add-job", "/group-chat"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Same-origin, allow-listed destination only; anything else opens the dashboard. */
function safeTarget(raw) {
  try {
    const u = new URL(String(raw || ""), self.location.origin);
    if (u.origin !== self.location.origin || !SAFE_PATHS.includes(u.pathname)) return "/dashboard";
    return u.pathname + u.search;
  } catch {
    return "/dashboard";
  }
}

const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = text(data.title, 120) || "JobSync";
  const options = {
    body: text(data.body, 200),
    tag: text(data.tag, 100) || undefined,
    data: { url: safeTarget(data.url) },
  };
  // Only same-origin icons are used.
  const icon = text(data.icon, 200);
  if (icon.startsWith("/") && !icon.startsWith("//")) options.icon = icon;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        } catch {
          /* fall through to opening a new window */
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/** The browser rotated/expired the subscription: tell open pages so they re-register. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) client.postMessage({ type: "jobsync-push-resubscribe" });
    }),
  );
});
