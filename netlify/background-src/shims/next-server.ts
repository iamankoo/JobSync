// `after()` exists only inside a Next.js request. Callers (lib/push/notify.ts) catch this and await the task instead.
export function after(): never {
  throw new Error("after() is not available in the background function");
}
