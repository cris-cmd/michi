import type { ModelStage } from "../agent/schema";

// App stages = model stages plus the pre-conversation greet.
export type AppStage = "greet" | ModelStage;

// The machine only moves on an explicit model `stage` field — never inferred
// from reply text. Forward-only, except the revise loop and a genuine
// change-of-brief back to gather.
const ALLOWED: Record<AppStage, ModelStage[]> = {
  greet: ["gather", "suggest"],
  gather: ["gather", "suggest"],
  suggest: ["suggest", "revise", "confirm", "gather"],
  revise: ["suggest", "revise", "confirm", "gather"],
  confirm: ["confirm", "revise", "checkout", "gather"],
  checkout: ["checkout", "done"],
  done: ["done"],
};

export function nextStage(current: AppStage, proposed: ModelStage): AppStage {
  return ALLOWED[current].includes(proposed) ? proposed : current;
}
