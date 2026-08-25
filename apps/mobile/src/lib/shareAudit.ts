import type { Circle, CircleMember, ShareCategory } from "@/api/types";

// The audit view's arithmetic (kora#437).
//
// "Who can see my body metrics?" is one list of names because grants come
// only from circles — there are no per-person grants to reconcile. That is
// the property circles were chosen for in #326's design, and it is why this
// is a pure function over the response the settings screen already holds
// rather than an endpoint of its own.

// CATEGORY_ORDER fixes the display order everywhere a category list is
// rendered. `body` is deliberately last: it is the consequential one, and a
// list whose order shifts between screens makes a permission surface feel
// untrustworthy.
export const CATEGORY_ORDER: ShareCategory[] = ["progress", "body"];

const LABELS: Record<ShareCategory, string> = {
  progress: "Progress",
  body: "Body metrics",
};

export function categoryLabel(category: ShareCategory): string {
  return LABELS[category];
}

// audienceFor returns everyone who can see `category`, deduplicated and
// sorted by name.
//
// Deduplication keys on member id, never on display name. Two different
// people may share a name, and collapsing them would under-report the
// audience — telling someone fewer people can see their body metrics than
// actually can. That is the failure direction that matters here, so the
// tie-break is always the id.
export function audienceFor(circles: Circle[], category: ShareCategory): CircleMember[] {
  const byID = new Map<string, CircleMember>();
  for (const circle of circles) {
    if (!circle.categories.includes(category)) continue;
    for (const member of circle.members) {
      if (!byID.has(member.id)) byID.set(member.id, member);
    }
  }
  return [...byID.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }),
  );
}
