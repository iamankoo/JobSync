/** Browser-side Web Push helpers. Imported only by client components. */

const REG_KEY = "jobsync:push-registration";
/** Re-confirm an unchanged subscription with the server at most this often. */
const REFRESH_MS = 12 * 3_600_000;

export type EnsureResult = { ok: true } | { ok: false; reason: "unconfigured" | "failed" };

/** True when this browser can show Web Push notifications (service workers, Push API, Notification API). */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=").replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

function readCache(): { memberId: string; endpoint: string; at: number } | null {
  try {
    return JSON.parse(localStorage.getItem(REG_KEY) ?? "null");
  } catch {
    return null;
  }
}
function writeCache(value: { memberId: string; endpoint: string; at: number } | null) {
  try {
    if (value) localStorage.setItem(REG_KEY, JSON.stringify(value));
    else localStorage.removeItem(REG_KEY);
  } catch {
    /* storage unavailable: registration is simply repeated next time */
  }
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function post(method: "POST" | "DELETE", body: unknown): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch("/api/push/subscriptions", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Whether the server can use push at all (VAPID keys and the PushSubscriptions tab). False on any doubt. */
export async function pushAvailable(): Promise<boolean> {
  try {
    return (await fetch("/api/push/config", { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}

/**
 * With notification permission already granted: makes sure this browser has a push subscription and that the
 * server knows it for `memberId`. Never asks for permission. Safe to call on every page load.
 */
export async function ensureSubscribed(memberId: string, retried = false): Promise<EnsureResult> {
  try {
    const reg = await serviceWorkerRegistration();
    // Fast path (no network): the same subscription was confirmed with the server for this member recently.
    const current = await reg.pushManager.getSubscription();
    const cachedReg = readCache();
    if (current && cachedReg && cachedReg.memberId === memberId && cachedReg.endpoint === current.endpoint && Date.now() - cachedReg.at < REFRESH_MS) {
      return { ok: true };
    }
    const cfg = await fetch("/api/push/config", { cache: "no-store" });
    if (cfg.status === 503) return { ok: false, reason: "unconfigured" };
    if (!cfg.ok) return { ok: false, reason: "failed" };
    const publicKey: string = (await cfg.json())?.data?.publicKey;
    if (!publicKey) return { ok: false, reason: "failed" };
    const appKey = keyBytes(publicKey);

    let sub = await reg.pushManager.getSubscription();
    // A subscription made with a different (rotated) VAPID key can never receive our pushes.
    if (sub && !sameBytes(sub.options.applicationServerKey, appKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });

    const json = sub.toJSON();
    const cached = readCache();
    if (cached && cached.memberId === memberId && cached.endpoint === sub.endpoint && Date.now() - cached.at < REFRESH_MS) return { ok: true };

    const res = await post("POST", { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } });
    if (res.status === 409 && !retried) {
      // The server already holds this endpoint with other keys: start over with a fresh subscription.
      await sub.unsubscribe();
      writeCache(null);
      return ensureSubscribed(memberId, true);
    }
    if (res.status === 503) return { ok: false, reason: "unconfigured" };
    if (!res.ok) return { ok: false, reason: "failed" };
    writeCache({ memberId, endpoint: sub.endpoint, at: Date.now() });
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/**
 * Logout: removes THIS browser's subscription from the signed-in member on the server so the next person to use
 * this browser does not receive their notifications. The member's other devices are not affected, and the
 * browser permission is kept (signing in again re-registers silently). Best effort; never throws.
 */
export async function removeThisDevice(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    writeCache(null);
    if (sub) await post("DELETE", { endpoint: sub.endpoint });
  } catch {
    /* ignore */
  }
}
