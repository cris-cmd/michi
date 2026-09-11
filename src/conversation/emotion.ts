// Shared emotion vocabulary for the listener, agent, UI, and presenter.

import type { PresentOptions } from "@perxona/presenter-types";
import type { Tone } from "../agent/schema";
import type { ListenerEmotion } from "./listener/types";

export type AvatarEmotion =
  | "neutral"
  | "warm"
  | "happy"
  | "curious"
  | "thinking"
  | "concerned"
  | "compassionate"
  | "apologetic"
  | "excited";

/** Listener emotions are a subset of AvatarEmotion — identity mapping. */
export function listenerToAvatarEmotion(e: ListenerEmotion): AvatarEmotion {
  return e;
}

/** The planning model's spoken tone → shared avatar emotion. */
export function toneToAvatarEmotion(tone: Tone): AvatarEmotion {
  switch (tone) {
    case "warm":
      return "warm";
    case "delighted":
      return "excited";
    case "apologetic":
      return "apologetic";
    case "thinking":
      return "thinking";
    default:
      return "neutral";
  }
}

/** AvatarEmotion → Perxona per-presentation options. undefined = neutral =
 *  no facial expression attached (Behavior AI stays in charge). */
export function avatarEmotionOptions(e: AvatarEmotion): PresentOptions | undefined {
  switch (e) {
    case "warm":
      return { emotion: "caring", intensity: "neutral" };
    case "happy":
      return { emotion: "joy", intensity: "neutral" };
    case "excited":
      return { emotion: "joy", intensity: "high" };
    case "curious":
      return { emotion: "curiosity", intensity: "low" };
    case "thinking":
      return { emotion: "curiosity", intensity: "low" };
    case "concerned":
      return { emotion: "realization", intensity: "low" };
    case "compassionate":
      return { emotion: "caring", intensity: "high" };
    case "apologetic":
      return { emotion: "sadness", intensity: "low" };
    default:
      return undefined;
  }
}

/** Convenience: tone → PresentOptions in one hop (used per spoken phrase). */
export function toneOptions(tone?: Tone): PresentOptions | undefined {
  return tone ? avatarEmotionOptions(toneToAvatarEmotion(tone)) : undefined;
}
