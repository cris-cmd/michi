// Transcript uncertainty assessment — STT output is a NOISY OBSERVATION,
// not semantic truth ("there isn't really a budget" → "Israel at the
// budget"). This module is deliberately layered, because no single check
// catches everything:
//
//   1. HERE (deterministic, fast path): score the transcript from STT
//      confidence + whether it touches critical slots (money/dates/party).
//      An uncertain read caps the listener at neutral-hold acks — the fast
//      path NEVER asserts understanding of a suspect hearing.
//   2. agent/core.ts (slow path): an uncertain transcript reaches the model as
//      a system note, and a critical-constraint change made from an
//      uncertain hearing WITHOUT a confirmation question fails the runtime
//      guard → one-shot retry.
//   3. The system prompt permanently instructs the model to treat garbled /
//      contextually impossible phrasing as a mishearing and confirm — that
//      is the layer that catches high-confidence nonsense the acoustic
//      score can't see.
//
// The fast path never mutates business state under ANY assessment — that
// property is structural (acks are phatic clips), not a threshold.

export interface TranscriptAssessment {
  /** Effective 0..1 confidence (STT-reported, or a prior when unreported). */
  confidence: number;
  /** The utterance touches money / dates / party-size — values where a
   *  mishearing does real damage. */
  criticalSlots: boolean;
  /** Treat this hearing as unreliable: neutral-hold acks only, and the
   *  model must confirm before committing critical values. */
  uncertain: boolean;
}

/** Interim-only commits (browser closed the session early) carry no
 *  confidence — score them as mediocre, not terrible. */
const UNREPORTED_CONFIDENCE = 0.7;
const UNCERTAIN_BELOW = 0.55;
const CRITICAL_UNCERTAIN_BELOW = 0.68;

const CRITICAL_SLOTS =
  /(¥|\byen\b|円|\bbudget\b|予算|\d[\d,]*\s*(yen|dollars?|euros?|元)|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today)\b|曜日|明日|今夜|\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}[:時]\d{0,2}\b|\b(adults?|kids?|child(ren)?|infants?|people|person)\b|人で|大人|子供|嬰兒|預算)/i;

export function assessTranscript(text: string, sttConfidence?: number): TranscriptAssessment {
  const confidence = sttConfidence ?? UNREPORTED_CONFIDENCE;
  const criticalSlots = CRITICAL_SLOTS.test(text);
  const uncertain =
    confidence < UNCERTAIN_BELOW || (criticalSlots && confidence < CRITICAL_UNCERTAIN_BELOW);
  return { confidence, criticalSlots, uncertain };
}
