import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardSummary } from "@/api/types";
import { buildSnapshot } from "../snapshot";

// Snapshot.swift and snapshot.ts are documented as ONE wire format that must
// change together (see the comments on NutritionSnapshot and WidgetSnapshot),
// but nothing enforced that before this test — a renamed or dropped field on
// either side would silently break decoding with no signal until a device
// showed the widget's empty state. This binds the two by parsing Swift's
// `let` declarations the same way deepLinks.test.ts parses widgetURL calls,
// and comparing the field-name set against what buildSnapshot actually
// produces.
const TARGETS = join(__dirname, "../../../targets/kora-widgets");

function swiftSnapshotFields(): string[] {
  const source = readFileSync(join(TARGETS, "Snapshot.swift"), "utf8");
  const structMatch = source.match(/struct NutritionSnapshot: Codable \{([^}]*)\}/);
  if (!structMatch) throw new Error("NutritionSnapshot struct not found in Snapshot.swift");
  return [...structMatch[1].matchAll(/let\s+(\w+):/g)].map((m) => m[1]);
}

test("NutritionSnapshot's fields match buildSnapshot's output keys", () => {
  const summary: DashboardSummary = {
    date: "2026-08-11",
    consumed: { kcal: 1200, protein_g: 60, carbs_g: 130, fat_g: 40, fiber_g: 12 },
    targets: { kcal: 2451, protein_g: 156, carbs_g: 337, fat_g: 73, fiber_g: 30 },
    water_ml: 0,
    streak_days: 0,
    source_counts: {},
  };

  const tsKeys = Object.keys(buildSnapshot({ summary, stepGoal: 10000 })).sort();
  const swiftKeys = swiftSnapshotFields().sort();

  expect(swiftKeys).toEqual(tsKeys);
});
