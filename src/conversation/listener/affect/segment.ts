// Clause segmentation for segment-level affect. Deliberately lightweight:
// sentence enders + contrast/conjunction markers, en/ja/zh. The point is to
// keep "my cat died" and "but my sister visits this weekend" in SEPARATE
// segments so classification never averages them — not to win a parsing
// shootout. Pure and browser-safe.

const SENTENCE_END = /([.!?。！？…]+)\s*/g;

// Contrast/continuation markers that start a new emotional clause. English
// markers need surrounding context (", but " / " but "); Japanese/Chinese
// connectives are matched bare.
const CLAUSE_SPLIT =
  /,?\s+(?=(?:but|although|though|however|anyway|even though|and then)\b)|(?<=[、。])(?=(?:でも|だけど|けど|ただ|とはいえ)、?)|(?<=，|。|、)(?=(?:但是|不過|可是|雖然|然而))/gi;

const MAX_SEGMENTS = 6;

/** Split an utterance into emotional clauses. Always returns ≥1 non-empty
 *  segment for non-empty input; overflow folds into the final segment. */
export function segmentUtterance(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Pass 1: sentences (keep their enders).
  const sentences: string[] = [];
  let last = 0;
  for (const m of trimmed.matchAll(SENTENCE_END)) {
    sentences.push(trimmed.slice(last, m.index! + m[0].length).trim());
    last = m.index! + m[0].length;
  }
  if (last < trimmed.length) sentences.push(trimmed.slice(last).trim());

  // Pass 2: contrast clauses inside each sentence.
  const segments = sentences
    .flatMap((s) => s.split(CLAUSE_SPLIT))
    .map((s) => (s ?? "").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));

  if (segments.length <= MAX_SEGMENTS) return segments;
  return [...segments.slice(0, MAX_SEGMENTS - 1), segments.slice(MAX_SEGMENTS - 1).join(" ")];
}
