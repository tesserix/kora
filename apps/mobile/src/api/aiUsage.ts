import type { AIQuotaWindow, AIUsageStatus } from "./types";

export function aiQuotaWindows(status: AIUsageStatus): AIQuotaWindow[] {
  return [status.daily, status.weekly, status.monthly];
}

export function remainingAIRequests(status: AIUsageStatus): number {
  return Math.min(...aiQuotaWindows(status).map((window) => window.remaining));
}

export function availableAgainAt(status: AIUsageStatus): string | null {
  const exhausted = aiQuotaWindows(status).filter((window) => window.remaining === 0);
  if (exhausted.length === 0) return null;
  return exhausted.reduce((latest, window) =>
    new Date(window.resets_at).getTime() > new Date(latest).getTime() ? window.resets_at : latest,
  exhausted[0].resets_at);
}

// Paise → "₹60.18". Integer arithmetic only: the API itemises every amount in
// paise precisely so no client ever has to hold a price in a float.
export function rupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(paise));
  return `${sign}₹${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// Basis points → "18%" / "2.5%", so a rate change in Go needs no app release.
export function ratePercent(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

export interface AIAllowance {
  // headline is what the screen shows large; detail explains it.
  headline: string;
  detail: string;
  blocked: boolean;
  // fromTopUp marks an allowance that is being served by a purchased pack,
  // which the screen says out loud — a user who paid should be able to see
  // that what they paid for is what is answering them.
  fromTopUp: boolean;
}

// One place decides what "how much is left" means. The server already knows
// whether the user is blocked (free windows AND any pack considered), so this
// never re-derives that: it only chooses the wording.
export function aiAllowance(status: AIUsageStatus): AIAllowance {
  const topUp = status.top_up;
  const free = remainingAIRequests(status);
  const availableAt = availableAgainAt(status);

  if (topUp?.active && topUp.unlimited) {
    return {
      headline: "Unlimited",
      detail: topUp.expires_at ? `Included until ${dateText(topUp.expires_at)}` : "Included with your top-up",
      blocked: false,
      fromTopUp: true,
    };
  }
  if (free > 0) {
    return {
      headline: `${free} calls left`,
      detail: "The tightest active limit determines what is available.",
      blocked: false,
      fromTopUp: false,
    };
  }
  if (topUp?.active) {
    const usable = Math.min(topUp.remaining, topUp.daily_remaining);
    if (usable > 0) {
      return {
        headline: `${usable} calls left`,
        detail: `From your top-up · ${topUp.remaining} left in the pack`,
        blocked: false,
        fromTopUp: true,
      };
    }
  }
  return {
    headline: "AI limit reached",
    // Never promises a purchase. The fallback used to read "Add requests to
    // keep going", which after kora#479 pointed at a checkout that no longer
    // exists. Whether requests can be BOUGHT is a server-config question the
    // screens answer separately; what is always true is that the free windows
    // reset on their own.
    detail: availableAt ? `Available again ${dateText(availableAt)}` : "Your allowance resets on its own.",
    blocked: true,
    fromTopUp: false,
  };
}

function dateText(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

// The short form for a list row: same source of truth as the full allowance,
// trimmed to fit beside a title.
export function aiAllowanceBadge(status: AIUsageStatus): string {
  const allowance = aiAllowance(status);
  if (allowance.blocked) return "Limit reached";
  if (allowance.headline === "Unlimited") return "Unlimited";
  return allowance.headline.replace(" calls left", " left");
}
