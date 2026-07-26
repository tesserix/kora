import { apiFetch } from "./api";

export async function registerDevice(token: string, platform: string): Promise<void> {
  await apiFetch("/v1/devices", {
    method: "POST",
    body: JSON.stringify({ token, platform }),
  });
}

export async function unregisterDevice(token: string): Promise<void> {
  await apiFetch(`/v1/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
}
