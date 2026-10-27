import type { ApiResult } from "@/lib/client/api";

/** Multipart upload of one file to our own route; same result envelope as apiRequest. Never throws. */
export async function uploadFile<T>(url: string, file: File): Promise<ApiResult<T>> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch(url, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (res.ok && body && "data" in body) return { ok: true, data: body.data as T };
    const err = body?.error;
    return {
      ok: false,
      status: res.status,
      code: typeof err?.code === "string" ? err.code : "unknown_error",
      message: typeof err?.message === "string" ? err.message : res.status === 413 ? "That file is too large." : "Upload failed. Please try again.",
    };
  } catch {
    return { ok: false, status: 0, code: "network_error", message: "Network error. Check your connection and try again." };
  }
}
