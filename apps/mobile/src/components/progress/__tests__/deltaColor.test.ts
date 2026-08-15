import { instrumentLight } from "@/theme/palette";
import { deltaColor } from "../deltaColor";

// Pure color decision for the Weight panel's delta figure (kora ignition
// Task 8, accent-budget demotion): ink when the change moves toward the
// stated goal, danger when it moves away. No instrument.accent branch here —
// the delta text is no longer an unconditional accent.
describe("deltaColor", () => {
  it("losing weight with a fat-loss goal reads ink (toward goal)", () => {
    expect(deltaColor(-1.2, "fat_loss", instrumentLight)).toBe(instrumentLight.ink);
  });

  it("gaining weight with a fat-loss goal reads danger (away from goal)", () => {
    expect(deltaColor(0.8, "fat_loss", instrumentLight)).toBe(instrumentLight.danger);
  });

  it("gaining weight with a muscle-gain goal reads ink (toward goal)", () => {
    expect(deltaColor(0.8, "muscle_gain", instrumentLight)).toBe(instrumentLight.ink);
  });

  it("losing weight with a muscle-gain goal reads danger (away from goal)", () => {
    expect(deltaColor(-0.8, "muscle_gain", instrumentLight)).toBe(instrumentLight.danger);
  });

  it("a maintenance goal has no away direction to judge — always ink", () => {
    expect(deltaColor(0.8, "maintenance", instrumentLight)).toBe(instrumentLight.ink);
    expect(deltaColor(-0.8, "maintenance", instrumentLight)).toBe(instrumentLight.ink);
  });

  it("zero delta reads ink regardless of goal", () => {
    expect(deltaColor(0, "fat_loss", instrumentLight)).toBe(instrumentLight.ink);
  });
});
