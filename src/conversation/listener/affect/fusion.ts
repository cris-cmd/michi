// Combines text, audio, and intent signals using deterministic rules. Strong
// reactions require strong evidence; conflicting or weak signals soften the
// result instead of escalating it.

import type { ListenerDecision } from "../types";
import { hasLossMarker, isKnownLoss, lossFingerprint, scoreSegment } from "./salience";
import type { AffectRead, AudioAffect, EmotionalSegment, SocialResponse } from "./types";

/** Minimum salience for a STRONG social ack, per family — below these the
 *  fusion under-reacts on purpose. Compassion stays the most conservative
 *  (a wrong condolence is the worst failure); celebration is cheaper to
 *  get wrong, and GoEmotions spreads positive mass across joy/excitement/
 *  pride so its winning label sits lower (calibrated in harness/affect.ts). */
const STRONG_SALIENCE: Record<SocialResponse, number> = {
  compassion: 0.45,
  concern: 0.4,
  celebration: 0.33,
  warmth: 0.3,
  none: 1,
};
const STRONG_CONFIDENCE = 0.4;

/** Assemble the utterance-level read from per-segment classifications
 *  (already scored by salience.ts) plus optional audio. */
export function fuseUtterance(
  segments: EmotionalSegment[],
  audio: AudioAffect | undefined,
  latencyMs: { text?: number; audio?: number },
): AffectRead {
  // Highest obligation wins — precedence lives in scoreSegment's weighting,
  // so a plain max over salience is already "never average".
  let winner: EmotionalSegment | null = null;
  for (const s of segments) {
    if (s.socialResponse === "none") continue;
    if (!winner || s.salience > winner.salience) winner = s;
  }

  let socialResponse: SocialResponse = winner?.socialResponse ?? "none";
  let salience = winner?.salience ?? 0;
  let confidence = winner?.confidence ?? Math.max(0, ...segments.map((s) => s.confidence));

  // Audio can ESCALATE a neutral text read one gentle step (subdued or sad
  // voice on task-only words → warmth), and DAMP a celebration when the
  // voice is flat (positive words, joyless delivery → don't be extremely
  // cheerful). It never invents compassion on its own — that requires
  // semantic evidence.
  if (audio) {
    // Thresholds are calibrated against the optional six-class audio model.
    const sad = audio.labels.sad ?? 0;
    const subdued = sad >= 0.4 || (sad >= 0.3 && audio.energy < 0.05);
    if (socialResponse === "none" && subdued && audio.confidence >= 0.4) {
      socialResponse = "warmth";
      salience = Math.max(salience, 0.35);
      confidence = Math.min(confidence || 1, audio.confidence * 0.8); // tone-only → soft
    }
    // "joyless" = the voice carries almost no happiness and the non-positive
    // mass (neutral + sad + disgust + fear) dominates — the model spreads
    // negative affect across those labels rather than concentrating in sad.
    const nonPositive =
      (audio.labels.neu ?? 0) + sad + (audio.labels.dis ?? 0) + (audio.labels.fea ?? 0);
    const joyless = (audio.labels.hap ?? 0) < 0.25 && nonPositive >= 0.5;
    if (socialResponse === "celebration" && joyless) {
      socialResponse = "warmth"; // conflicting signals → no extreme reaction
      salience = Math.min(salience, 0.4);
    }
  }

  return {
    segments,
    socialResponse,
    salience,
    taskTone: taskToneOf(segments, socialResponse),
    audio,
    confidence,
    latencyMs,
  };
}

/** The task continuation's feel — allowed to differ from the ack (grief then
 *  planning something fun for a visiting sister = compassionate ack,
 *  gently-positive plan). */
function taskToneOf(segments: EmotionalSegment[], social: SocialResponse): AffectRead["taskTone"] {
  // "somewhere fun" reads ~0.13+ on the joy family; "somewhere peaceful"
  // reads ~0.03 (both are high `desire`, which can't separate them) —
  // threshold calibrated against the live model in harness/affect.ts.
  const hasPositive = segments.some(
    (s) =>
      s.socialResponse === "celebration" ||
      (s.emotions.optimism ?? 0) + (s.emotions.joy ?? 0) + (s.emotions.excitement ?? 0) + (s.emotions.amusement ?? 0) >= 0.12,
  );
  switch (social) {
    case "compassion":
      return hasPositive ? "gently_positive" : "calm";
    case "celebration":
      return "upbeat";
    case "concern":
      return "warm";
    case "warmth":
      return "warm";
    default:
      return "neutral";
  }
}

/** Classify-and-fuse helper for callers that already have per-segment
 *  emotion distributions (the server inference path and the benchmark). */
export function readFromClassified(
  classified: { text: string; emotions: Record<string, number> }[],
  audio: AudioAffect | undefined,
  latencyMs: { text?: number; audio?: number },
): AffectRead {
  return fuseUtterance(
    classified.map((c) => scoreSegment(c.text, c.emotions)),
    audio,
    latencyMs,
  );
}

/** Epistemic cap for a suspect STT hearing: the listener must not assert
 *  understanding of words that may not have been said. Assertive shelves
 *  (confirmation / positive / celebration / compassion / correction) drop to
 *  a neutral hold; deliberate silence and neutral shelves pass through. */
export function capForUncertainTranscript(d: ListenerDecision, uncertain: boolean): ListenerDecision {
  if (!uncertain) return d;
  const assertive =
    d.ackCategory === "confirmation" ||
    d.ackCategory === "positive" ||
    d.ackCategory === "celebration" ||
    d.ackCategory === "compassion" ||
    d.ackCategory === "correction";
  if (!assertive) return { ...d, emotion: d.emotion === "excited" ? "warm" : d.emotion };
  return { ...d, ackCategory: "processing", emotion: "warm", motion: null, mode: "spoken" };
}

/** Conversational-event continuity: a loss or celebration that was ALREADY
 *  acknowledged must not be rediscovered — "even though I'm sad my cat
 *  died" gets continuity, never a second first-time condolence.
 *
 *  Two corrections over the original type-only version:
 *   1. A loss is identified by FINGERPRINT, not just by type. "my cat died"
 *      followed by "my mom died" is two events; silencing the second one is
 *      a worse failure than repeating yourself. Pass `lossFingerprints` +
 *      `text` to get that discrimination; omit them and the old type-only
 *      behaviour stands.
 *   2. Continuity SPEAKS. The previous version fired the compassion motion
 *      with no clip, so the avatar performed a comforting gesture into
 *      silence before the planning model spoke, which reads as a glitch,
 *      not as tact. The gesture now has a line to travel with. */
export function applyEventContinuity(
  d: ListenerDecision,
  known: { loss?: boolean; celebration?: boolean; lossFingerprints?: string[][] },
  text?: string,
): ListenerDecision {
  if (d.ackCategory === "compassion" && known.loss) {
    // A NEW loss re-triggers a real condolence — but "new" needs BOTH an
    // explicit bereavement marker (otherwise "I'm just sad" re-condoles the
    // grief we already spoke to) and a subject that doesn't match one we
    // already know. Without fingerprints this stays type-only.
    const discriminating = known.lossFingerprints !== undefined && text !== undefined;
    const announcesNewLoss =
      discriminating &&
      hasLossMarker(text as string) &&
      !isKnownLoss(lossFingerprint(text as string), known.lossFingerprints ?? []);
    if (announcesNewLoss) return d;
    return { ...d, ackCategory: "continuity", mode: "spoken", motion: "compassion", emotion: "warm" };
  }
  if (d.ackCategory === "celebration" && known.celebration) {
    return { ...d, ackCategory: "continuity", mode: "spoken", motion: "celebration", emotion: "happy" };
  }
  return d;
}

/** Compact listener context for the planning model's system note. Audio is
 *  absent from the transcript, so the subdued-voice flag rides along. Null when
 *  from the transcript, so the subdued-voice flag rides along. Null when
 *  there is nothing confident enough to say (never prime the model to diagnose
 *  feelings off weak evidence). */
export function listenerContextOf(affect: AffectRead | null): {
  socialResponse: SocialResponse;
  taskTone: AffectRead["taskTone"];
  voiceSubdued: boolean;
} | null {
  if (!affect) return null;
  const sad = affect.audio?.labels.sad ?? 0;
  const voiceSubdued = sad >= 0.5 || (sad >= 0.35 && (affect.audio?.energy ?? 1) < 0.04);
  if (affect.socialResponse === "none" && !voiceSubdued) return null;
  if (affect.confidence < STRONG_CONFIDENCE && !voiceSubdued) return null;
  return { socialResponse: affect.socialResponse, taskTone: affect.taskTone, voiceSubdued };
}

/**
 * Final step: overlay the ML read on the rule policy's decision. The rules
 * keep ROUTING (correction/revision/confirmation beats, ack breathing); the
 * ML read owns emotional PERCEPTION (which shelf, which face).
 */
export function fuseListenerDecision(rule: ListenerDecision, affect: AffectRead | null): ListenerDecision {
  if (!affect) {
    // No ML read at all (offline / budget miss / inference down). Rules may
    // still ROUTE, but they may not celebrate: surface patterns like
    // "…would be great" are exactly how a bereavement sentence once earned
    // a "Wonderful." ack. An emotionally flat "Okay." is always safe; an
    // emotionally wrong one never is.
    if (rule.intent === "positive") {
      return { ...rule, ackCategory: rule.ackCategory ? "neutral" : null, emotion: "neutral" };
    }
    return rule;
  }

  // Task-routing beats outrank emotional re-shelving — but a compassion
  // moment still softens the delivery.
  const routing = rule.intent === "correction" || rule.intent === "revision" || rule.intent === "confirmation";
  const strong =
    affect.salience >= STRONG_SALIENCE[affect.socialResponse] && affect.confidence >= STRONG_CONFIDENCE;

  if (routing) {
    if (affect.socialResponse === "compassion" && strong) {
      return { ...rule, emotion: "compassionate" };
    }
    return rule;
  }

  switch (affect.socialResponse) {
    case "compassion":
      if (strong)
        return { ...rule, ackCategory: "compassion", emotion: "compassionate", motion: "compassion", mode: "spoken", confidence: affect.confidence };
      // weak sadness evidence → warm, never a spoken condolence
      return { ...rule, emotion: "warm" };
    case "celebration":
      if (strong)
        return { ...rule, ackCategory: "celebration", emotion: "excited", motion: "celebration", mode: "spoken", confidence: affect.confidence };
      // weak positive = recolor only; a deliberate rule silence stays silent
      return { ...rule, emotion: "happy" };
    case "concern":
      if (strong) return { ...rule, ackCategory: "concerned", emotion: "concerned", mode: "spoken", confidence: affect.confidence };
      return { ...rule, emotion: "warm" };
    case "warmth":
      return { ...rule, emotion: "warm" };
    default:
      return rule;
  }
}
