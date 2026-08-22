import { aiAllowance, aiAllowanceBadge, availableAgainAt, ratePercent, remainingAIRequests, rupees } from "../aiUsage";
import type { AIUsageStatus } from "../types";

function status(overrides: Partial<AIUsageStatus> = {}): AIUsageStatus {
  return {
    daily: { used: 3, limit: 20, remaining: 17, resets_at: "2026-08-23T00:00:00Z" },
    weekly: { used: 9, limit: 100, remaining: 91, resets_at: "2026-08-24T00:00:00Z" },
    monthly: { used: 17, limit: 300, remaining: 283, resets_at: "2026-09-01T00:00:00Z" },
    ...overrides,
  };
}

const spent = status({ daily: { used: 20, limit: 20, remaining: 0, resets_at: "2026-08-23T00:00:00Z" } });

test("the tightest window is what is actually left", () => {
  expect(remainingAIRequests(status())).toBe(17);
  expect(availableAgainAt(status())).toBeNull();
  expect(availableAgainAt(spent)).toBe("2026-08-23T00:00:00Z");
});

test("free allowance is reported before any top-up is touched", () => {
  const allowance = aiAllowance(status({ top_up: { active: true, unlimited: false, remaining: 25, daily_remaining: 10 } }));

  expect(allowance.headline).toBe("17 calls left");
  expect(allowance.fromTopUp).toBe(false);
  expect(allowance.blocked).toBe(false);
});

test("a spent free allowance falls through to the purchased pack", () => {
  const allowance = aiAllowance({
    ...spent,
    top_up: { active: true, unlimited: false, pack_code: "spark", remaining: 25, daily_remaining: 10 },
  });

  expect(allowance.headline).toBe("10 calls left");
  expect(allowance.detail).toContain("25 left in the pack");
  expect(allowance.fromTopUp).toBe(true);
  expect(allowance.blocked).toBe(false);
});

// A pack's daily cap is a real limit: exhausting it blocks even though the
// pack still has requests in it.
test("a pack with nothing left today blocks rather than promising its balance", () => {
  const allowance = aiAllowance({
    ...spent,
    top_up: { active: true, unlimited: false, pack_code: "spark", remaining: 15, daily_remaining: 0 },
  });

  expect(allowance.headline).toBe("AI limit reached");
  expect(allowance.blocked).toBe(true);
});

test("an unlimited pack outranks every free window", () => {
  const allowance = aiAllowance({
    ...spent,
    top_up: {
      active: true,
      unlimited: true,
      pack_code: "boundless",
      remaining: 0,
      daily_remaining: 0,
      expires_at: "2026-09-21T09:00:00Z",
    },
  });

  expect(allowance.headline).toBe("Unlimited");
  expect(allowance.detail).toContain("Included until");
  expect(allowance.blocked).toBe(false);
});

test("an expired pack is not an allowance", () => {
  const allowance = aiAllowance({
    ...spent,
    top_up: { active: false, unlimited: false, remaining: 25, daily_remaining: 10 },
  });

  expect(allowance.blocked).toBe(true);
  expect(allowance.detail).toContain("Available again");
});

test("the row badge says the same thing in fewer words", () => {
  expect(aiAllowanceBadge(status())).toBe("17 left");
  expect(aiAllowanceBadge(spent)).toBe("Limit reached");
  expect(
    aiAllowanceBadge({ ...spent, top_up: { active: true, unlimited: true, remaining: 0, daily_remaining: 0 } }),
  ).toBe("Unlimited");
});

// Money is integer paise everywhere; a float would eventually render 60.17.
test("paise render as exact rupees", () => {
  expect(rupees(6_018)).toBe("₹60.18");
  expect(rupees(126_378)).toBe("₹1263.78");
  expect(rupees(5_000)).toBe("₹50.00");
  expect(rupees(7)).toBe("₹0.07");
  expect(rupees(0)).toBe("₹0.00");
});

test("basis points render as the rate a bill would show", () => {
  expect(ratePercent(1800)).toBe("18%");
  expect(ratePercent(200)).toBe("2%");
  expect(ratePercent(250)).toBe("2.50%");
});
