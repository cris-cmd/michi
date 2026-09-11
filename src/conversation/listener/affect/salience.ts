// Emotion distribution → social salience. ML perceives (the GoEmotions
// distribution comes from the text model); THESE rules decide what the
// perception socially obliges — routing and safety live here by design.
//
// Salience ≠ intensity: joy at 0.9 scores lower obligation than grief at
// 0.5, because failing to acknowledge a loss is a much worse social error
// than failing to cheer.  Pure and browser-safe; tested offline.

import type { EmotionalSegment, SocialResponse } from "./types";

/** obligation weight per GoEmotions label (unlisted labels → none/0). */
const LABEL_OBLIGATION: Record<string, { response: SocialResponse; weight: number }> = {
  grief: { response: "compassion", weight: 1.0 },
  sadness: { response: "compassion", weight: 0.8 },
  fear: { response: "concern", weight: 0.7 },
  nervousness: { response: "concern", weight: 0.6 },
  anger: { response: "concern", weight: 0.65 },
  annoyance: { response: "concern", weight: 0.55 },
  disgust: { response: "concern", weight: 0.5 },
  disappointment: { response: "warmth", weight: 0.55 },
  remorse: { response: "warmth", weight: 0.6 },
  embarrassment: { response: "warmth", weight: 0.5 },
  pride: { response: "celebration", weight: 0.75 },
  excitement: { response: "celebration", weight: 0.7 },
  joy: { response: "celebration", weight: 0.65 },
  love: { response: "warmth", weight: 0.5 },
  gratitude: { response: "warmth", weight: 0.4 },
  relief: { response: "warmth", weight: 0.4 },
  caring: { response: "warmth", weight: 0.4 },
  optimism: { response: "warmth", weight: 0.35 },
  admiration: { response: "warmth", weight: 0.35 },
  amusement: { response: "warmth", weight: 0.35 },
};

/** Tie-break order when scores are close — never trade compassion away. */
const PRECEDENCE: SocialResponse[] = ["compassion", "concern", "celebration", "warmth", "none"];

/** Loss/bereavement markers (en/ja/zh). A safety prior, not perception: the
 *  model sometimes reads "my cat died" as plain sadness — the marker
 *  upgrades sadness-family probability mass to grief-level obligation. */
const LOSS_MARKERS =
  /\b(died|passed away|passing|funeral|put (him|her|them) (down|to sleep))\b|\b(lost|we lost) (my|our|his|her|them)\b|亡くな|死ん|死んじゃ|他界|葬式|お葬式|過世|走了|去世/i;

export function hasLossMarker(text: string): boolean {
  return LOSS_MARKERS.test(text);
}

/**
 * Score one segment's classified emotion distribution. `emotions` is the
 * model's label→probability map (any subset of GoEmotions labels).
 */
export function scoreSegment(text: string, emotions: Record<string, number>): EmotionalSegment {
  const scores = new Map<SocialResponse, number>();
  const driver = new Map<SocialResponse, number>(); // raw prob of the label behind the score
  for (const [label, prob] of Object.entries(emotions)) {
    const ob = LABEL_OBLIGATION[label];
    if (!ob) continue;
    if (prob * ob.weight > (scores.get(ob.response) ?? 0)) {
      scores.set(ob.response, prob * ob.weight);
      driver.set(ob.response, prob);
    }
  }

  // The loss prior: explicit bereavement language with ANY sadness-family
  // mass (or a distracted model) is a compassion moment, full stop.
  if (hasLossMarker(text)) {
    const sad = (emotions.grief ?? 0) + (emotions.sadness ?? 0) + (emotions.remorse ?? 0);
    scores.set("compassion", Math.max(scores.get("compassion") ?? 0, Math.min(1, 0.55 + sad)));
    driver.set("compassion", Math.max(driver.get("compassion") ?? 0, 0.75));
  }

  let socialResponse: SocialResponse = "none";
  let salience = 0;
  for (const r of PRECEDENCE) {
    const s = scores.get(r) ?? 0;
    // precedence-ordered: a later family must beat the current winner by a
    // real margin (not a rounding hair) to take the segment
    if (s > salience + 0.05) {
      socialResponse = r;
      salience = s;
    }
  }

  const won = salience >= 0.15;
  return {
    text,
    emotions,
    salience,
    socialResponse: won ? socialResponse : "none",
    // Confidence IN the social read = probability of the label that drove
    // it — a 0.6 "neutral" must not lend confidence to a 0.2 "sadness".
    confidence: won ? (driver.get(socialResponse) ?? 0) : Math.max(0, ...Object.values(emotions)),
  };
}

// ── Loss IDENTITY ──────────────────────────────────────────────────────
// `hasLossMarker` answers "is this a bereavement?"; these answer "is it the
// SAME bereavement we already condoled?". Without that distinction the
// event-continuity guard (fusion.ts) silences a genuinely new loss — "my
// cat died" then "my mom died" read as one event and the second gets no
// condolence at all. Deliberately shallow: content words of the clause
// carrying the marker, marker and function words removed, so what remains
// is essentially the subject of the loss ("cat" vs "mom").

/** Marker verbs/nouns carry no identity — every loss has them. */
const MARKER_WORDS =
  /\b(died|die|dies|dying|passed|passing|away|funeral|lost|loss|down|sleep|put)\b/gi;

/** Function words that would inflate every comparison toward "same". */
const STOPWORDS = new Set([
  "a", "an", "and", "at", "be", "but", "do", "for", "he", "her", "him", "his",
  "i", "im", "in", "is", "it", "its", "just", "me", "my", "of", "on", "or",
  "our", "she", "so", "the", "their", "them", "they", "to", "was", "we",
  "with", "yesterday", "today", "recently", "ago", "last", "night", "week",
]);

/** The clause that actually carries the loss marker — comparing whole
 *  utterances would drown the subject in task words ("something calming"). */
function lossClause(text: string): string {
  const parts = text.split(/(?:[.!?。！？…]+|\bbut\b|\bthough\b|でも|但是|,)/iu);
  return parts.find((p) => LOSS_MARKERS.test(p)) ?? text;
}

/**
 * Identity tokens for a loss. Word tokens for spaced scripts; character
 * bigrams for CJK (same convention as conversation/ackEcho.ts), where the
 * marker substrings are stripped before gramming.
 */
export function lossFingerprint(text: string): string[] {
  const clause = lossClause(text)
    .toLowerCase()
    .replace(MARKER_WORDS, " ")
    .replace(/亡くな\S*|死ん\S*|他界|葬式|お葬式|過世|走了|去世/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clause) return [];
  if (clause.includes(" ")) {
    return [...new Set(clause.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
  }
  const grams = new Set<string>();
  for (let i = 0; i < clause.length - 1; i++) grams.add(clause.slice(i, i + 2));
  if (clause.length === 1) grams.add(clause);
  return [...grams];
}

/**
 * Is `next` a reference to a loss we already have a fingerprint for?
 * CONTAINMENT, not Jaccard: a callback is usually much shorter than the
 * original ("still sad about my cat" vs the whole first utterance), so
 * dividing by the smaller set is what keeps it recognizable. An empty new
 * fingerprint ("I'm just sad") carries no new subject → treat as the same
 * event rather than re-condoling.
 */
export function isKnownLoss(next: string[], known: string[][]): boolean {
  if (known.length === 0) return false;
  if (next.length === 0) return true;
  const nextSet = new Set(next);
  return known.some((prev) => {
    if (prev.length === 0) return false;
    const prevSet = new Set(prev);
    let shared = 0;
    for (const t of nextSet) if (prevSet.has(t)) shared++;
    return shared / Math.min(nextSet.size, prevSet.size) >= 0.5;
  });
}
