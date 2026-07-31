import { auth } from "./firebase";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const user = auth?.currentUser;
  const token = user ? await user.getIdToken() : null;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? body;
}

// apiFetch unwraps to `data` and drops everything else, which is right for
// almost every endpoint. PATCH /v1/logs/:id also returns a `meta` object
// saying whether the correction taught the food index — the client must not
// claim "Kora will remember" for a best-effort write that failed — so this
// sibling returns the whole envelope. Same auth and error handling.
export async function apiFetchEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const user = auth?.currentUser;
  const token = user ? await user.getIdToken() : null;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  return (await res.json()) as { data: T; meta?: Record<string, unknown> };
}

export async function apiFetchMultipart(path: string, form: FormData): Promise<unknown> {
  const user = auth?.currentUser;
  const token = user ? await user.getIdToken() : null;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    body: form,
    // No Content-Type — fetch sets multipart/form-data with the boundary.
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? body;
}
