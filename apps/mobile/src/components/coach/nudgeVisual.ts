export type NudgeTone = "accent" | "status" | "neutral";

export interface NudgeVisual {
  icon: string;
  tone: NudgeTone;
}

const VISUALS: Record<string, NudgeVisual> = {
  protein: { icon: "drumstick", tone: "accent" },
  fibre: { icon: "leaf", tone: "status" },
  weight_down: { icon: "trending-down", tone: "neutral" },
  weight_up: { icon: "trending-up", tone: "neutral" },
  today: { icon: "sparkles", tone: "neutral" },
};

export function nudgeVisual(kind: string): NudgeVisual {
  return VISUALS[kind] ?? { icon: "sparkles", tone: "neutral" };
}
