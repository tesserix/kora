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
