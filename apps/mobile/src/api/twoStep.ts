// The signed-in person's two-step settings. kora-api acts on their own
// Zitadel user; an authenticator app added here is what makes sign-in ask
// for a code on /two-step.
import { apiFetch } from "@/lib/api";

export type TwoStepSetup = { uri: string; secret: string };

const post = (path: string, body?: Record<string, string>) =>
  apiFetch(`/v1/me/two-step${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export async function fetchTwoStepEnabled(): Promise<boolean> {
  const data = (await apiFetch("/v1/me/two-step")) as { enabled?: boolean };
  return data.enabled === true;
}

// startTwoStep issues a fresh secret, replacing any setup left unconfirmed.
export async function startTwoStep(): Promise<TwoStepSetup> {
  return (await post("/setup")) as TwoStepSetup;
}

export async function confirmTwoStep(code: string): Promise<void> {
  await post("/confirm", { code });
}

export async function disableTwoStep(code: string): Promise<void> {
  await post("/disable", { code });
}

// The secret as an authenticator app shows it for typing: groups of four.
export function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}
