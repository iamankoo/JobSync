import type { Application, ApplicationStage, ApplicationStatus, Connection, Job } from "@/types/domain";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

/** Calls one of our own route handlers and normalises success/error envelopes. Never throws. */
export async function apiRequest<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body && "data" in body) return { ok: true, data: body.data as T };
    const err = body?.error;
    return {
      ok: false,
      status: res.status,
      code: typeof err?.code === "string" ? err.code : "unknown_error",
      message: typeof err?.message === "string" ? err.message : "Something went wrong. Please try again.",
      details: err?.details,
    };
  } catch {
    return { ok: false, status: 0, code: "network_error", message: "Network error. Check your connection and try again." };
  }
}

export interface ApplicationUpdate {
  jobId: string;
  status: ApplicationStatus;
  application: Application | null;
  changed: boolean;
}

export interface ApplicationUpdateBody {
  status: ApplicationStatus;
  applicationStage?: ApplicationStage | null;
  notes?: string | null;
}

/** Updates the SIGNED-IN member's own application. The server takes identity from the session. */
export function updateApplication(jobId: string, body: ApplicationUpdateBody) {
  return apiRequest<ApplicationUpdate>(`/api/applications/${encodeURIComponent(jobId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function updateJobRequest(jobId: string, body: Record<string, unknown>) {
  return apiRequest<Job>(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteJobRequest(jobId: string) {
  return apiRequest<{ jobId: string }>(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}

export function createJobRequest(body: Record<string, unknown>) {
  return apiRequest<Job>("/api/jobs", { method: "POST", body: JSON.stringify(body) });
}

export function createConnectionRequest(body: Record<string, unknown>) {
  return apiRequest<Connection>("/api/connections", { method: "POST", body: JSON.stringify(body) });
}

export function updateConnectionRequest(connectionId: string, body: Record<string, unknown>) {
  return apiRequest<Connection>(`/api/connections/${encodeURIComponent(connectionId)}`, { method: "PUT", body: JSON.stringify(body) });
}

export function deleteConnectionRequest(connectionId: string) {
  return apiRequest<{ connectionId: string }>(`/api/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
}
