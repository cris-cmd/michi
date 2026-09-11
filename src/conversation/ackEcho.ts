// Duplicate-acknowledgement guard — a safety net under the prompt
// contract in agent/ackContext.ts. Prompting handles most repetition; this
// catches the obvious failure where the ack already said "Got it." and the
// model still opens with "Got it, so…". Deliberately small: leading-sentence
// checks only, no semantic rewriting. Tested in harness/deterministic.ts.

// Phatic leads that duplicate an ack when they OPEN the reply. Matched
// against a whole normalized leading sentence (en + ja + zh shelf lines).
const PHATIC_LEAD =
  /^(got it|okay|ok|alright|all right|sure|right|understood|absolutely|of course|no problem|i understand|i see|i hear you|my mistake|good question|(oh|ah)( okay| got it| i see)?|(i'?m|i am) (really |so |very )?sorry( to hear that| about that| you'?re going through (that|this))?|that('s| is| sounds) (really |so )?(exciting|amazing|wonderful|great|fantastic|rough|hard|tough|awful)|congratulations|はい|なるほど|わかりました|承知しました|かしこまりました|了解(です)?|お気の毒に|それは大変でしたね|好的|明白(了)?|沒問題|真的很遺憾)$/;

/** Normalize for comparison: lowercase, strip punctuation/symbols, collapse
 *  whitespace. Apostrophes survive so "i'm sorry" stays matchable; CJK is
 *  untouched (\p{L}\p{N}). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token overlap (Jaccard) — word-level for spaced scripts, character
 *  bigrams for CJK-ish strings without spaces. */
function overlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    if (s.includes(" ")) return new Set(s.split(" "));
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    if (s.length === 1) g.add(s);
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const t of ga) if (gb.has(t)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/** Split off the first sentence-ish chunk — cut at the FIRST ender (., !,
 *  ?, CJK enders), em-dash pause, or "comma + space" ("Got it, so…" must cut
 *  at the comma). Returns [lead, rest]. */
function splitLead(text: string): [string, string] {
  const m = /^\s*[^.!?。！？…]*?(?:[.!?。！？…]+|—|,\s)/u.exec(text);
  if (!m) return [text, ""];
  return [m[0], text.slice(m[0].length)];
}

/** Does this leading sentence merely re-say the ack? */
function isEcho(lead: string, ack: string): boolean {
  const nl = norm(lead);
  if (!nl) return false;
  if (nl.length > 64) return false; // real content, not a phatic lead
  if (PHATIC_LEAD.test(nl)) return true;
  return overlap(nl, norm(ack)) >= 0.6;
}

/**
 * Strip a reply's leading sentences (max 2) that duplicate the already-
 * spoken ack. If stripping would leave nothing, the original reply is kept —
 * a wholly-redundant reply is rarer and less awkward than silence.
 */
export function stripAckEcho(reply: string, ack: string | null | undefined): string {
  if (!ack) return reply;
  let rest = reply;
  for (let i = 0; i < 2; i++) {
    const [lead, tail] = splitLead(rest);
    if (!tail.trim() && i === 0 && isEcho(lead, ack)) return reply; // whole reply IS the echo
    if (!isEcho(lead, ack)) break;
    rest = tail;
  }
  rest = rest.replace(/^[\s,、]+/, "");
  return rest.trim() ? rest : reply;
}

/**
 * Streaming variant: phrases arrive one at a time (PhraseAssembler), so the
 * guard holds state across the first couple of phrases. `filter` returns the
 * text to actually speak ("" = swallow this phrase).
 */
export class AckEchoGuard {
  private budget = 2; // max leading phrases we will ever swallow/trim
  private done = false;

  constructor(private ack: string | null) {
    if (!ack) this.done = true;
  }

  filter(phrase: string): string {
    if (this.done) return phrase;
    const out = stripAckEcho(phrase, this.ack);
    if (out === phrase) {
      // Untouched phrase = real content begins here; stop guarding. (A
      // whole-phrase echo comes back unchanged from stripAckEcho's
      // keep-original edge; catch it explicitly.)
      const [lead, tail] = splitLead(phrase);
      if (!tail.trim() && this.ack && isEcho(lead, this.ack) && this.budget > 0) {
        this.budget--;
        if (this.budget === 0) this.done = true;
        return "";
      }
      this.done = true;
      return phrase;
    }
    this.done = true; // trimmed once — everything after is real content
    return out;
  }
}
