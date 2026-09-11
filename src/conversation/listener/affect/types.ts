// Runtime-agnostic contracts shared by inference and listener policy.

/** What a segment socially obliges the listener to do — DISTINCT from raw
 *  emotion intensity ("my cat died, but I'm excited about dinner": the
 *  excitement is stronger emotion, the loss carries the obligation). */
export type SocialResponse =
  | "none"
  | "warmth"
  | "compassion"
  | "celebration"
  | "concern";

/** One clause/sentence of the utterance, classified independently —
 *  mixed-emotion utterances must never be averaged into one sentiment. */
export interface EmotionalSegment {
  text: string;
  /** Top emotion probabilities from the text model (GoEmotions labels). */
  emotions: Record<string, number>;
  /** 0..1 — social acknowledgement obligation, NOT emotion intensity. */
  salience: number;
  socialResponse: SocialResponse;
  /** Top-label probability — how sure the model is about this segment. */
  confidence: number;
}

/** Vocal-tone read of the utterance audio (speech emotion model + simple
 *  prosody features). Absent when no audio was captured. */
export interface AudioAffect {
  /** Model label distribution (superb ER classes: neu / hap / ang / sad). */
  labels: Record<string, number>;
  /** RMS energy of the clip, 0..~1 — low + sad-leaning = subdued voice. */
  energy: number;
  /** Top-label probability. */
  confidence: number;
}

/** The fused, whole-utterance read the listener runtime consumes. */
export interface AffectRead {
  segments: EmotionalSegment[];
  /** Highest-obligation social response across segments (never averaged). */
  socialResponse: SocialResponse;
  /** Salience of the segment that won socialResponse. */
  salience: number;
  /** How the TASK continuation should feel — allowed to differ from the
   *  acknowledgement (compassionate ack, gently-positive plan). */
  taskTone: "neutral" | "warm" | "gently_positive" | "upbeat" | "calm";
  audio?: AudioAffect;
  /** Overall confidence in socialResponse (drives graceful degradation:
   *  low confidence must UNDER-react, never overreact). */
  confidence: number;
  /** Server-side inference timings for the HUD / benchmark. */
  latencyMs: { text?: number; audio?: number };
}
