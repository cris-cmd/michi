// End-of-turn detection heuristics — pure, cheap, no LLM. The recognizer
// keeps running (continuous mode); after each result event we schedule a
// commit this many ms out. Trailing hesitation earns extra patience; clear
// short commands commit fast.

const QUICK_COMMIT =
  /^(yes|yeah|yep|no|nope|ok|okay|sure|confirm|book (that|it)|go ahead|do it|perfect|sounds good|that('s| is) it|the (first|second|third) one|move it to \w+)[.!]?$/i;

const HESITATION = /\b(and|but|because|maybe|also|so|or|um|uh|like|then)$|[,;]$/i;

export const ENDPOINT_BASE_MS = 800;
export const ENDPOINT_QUICK_MS = 450;
export const ENDPOINT_PATIENT_MS = 1500;

export function endpointDelayMs(text: string): number {
  const t = text.trim().toLowerCase();
  if (!t) return ENDPOINT_PATIENT_MS; // heard something, no words yet — wait
  if (QUICK_COMMIT.test(t)) return ENDPOINT_QUICK_MS;
  if (HESITATION.test(t)) return ENDPOINT_PATIENT_MS;
  return ENDPOINT_BASE_MS;
}
