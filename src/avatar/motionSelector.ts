// Motion variants rotate with recency exclusion. IDs are avatar-specific;
// null entries deliberately leave the gesture to the presenter.

/** Semantic beats the listener/runtime can request — never raw IDs. */
export type MotionBeat =
  | "listening" // user speech began — attentive reaction
  | "correction" // "no, I meant…" — settling gesture
  | "compassion" // bereavement/grief beat — somber stillness
  | "celebration" // good news — restrained brightness
  | "processing"; // "let me check" — concierge look-up

type Variant = { id: string; name: string } | null;

const POOLS: Record<MotionBeat, Variant[]> = {
  listening: [
    { id: "01KWV787R5FE3G9B595Q58V3K3", name: "Female Listen Lean Forward" },
    { id: "01KZAGR7KQANP3JV6W8P464NEV", name: "Casual Hand Clasp" },
    { id: "01KWV77W5T41RJ4PKFQ3PJVDDH", name: "Female Idle Breathe" },
  ],
  correction: [
    { id: "01KZAH3BEZCXDRCZ0T05ZGQMFJ", name: "Calming Hand Gesture" },
    { id: "01KZAHEHP975NG4KAB23NJFBWJ", name: "Lower Arms" },
  ],
  compassion: [
    { id: "01KZAGQ0VHHCWPTN6Q17G8JBD1", name: "Head Bowed Idle" },
    { id: "01KZAH3BEZCXDRCZ0T05ZGQMFJ", name: "Calming Hand Gesture" },
  ],
  celebration: [
    { id: "01KZAGYKTQ0JVGK3MV9SWDTBR4", name: "Clap and Rub Hands" },
    { id: "01KZAHGB36ZQXFJZV997DH2YSZ", name: "Casual Arm Raise" },
  ],
  processing: [
    { id: "01KZAH96K7PSTFQAA6H4JQ3N69", name: "Earpiece Touch" },
    null, // often the right amount of "let me check" is no gesture at all
    { id: "01KZAH514KWMDHKXABPQ1DCJ9K", name: "Idle Look Around" },
  ],
};

const EXCLUDE_RECENT = 2;

export class MotionSelector {
  private recent = new Map<MotionBeat, string[]>(); // last picked ids/null-marker per beat

  /** Pick a variant for the beat, avoiding the last EXCLUDE_RECENT picks
   *  where the pool allows. Returns null when the variant is "no gesture". */
  pick(beat: MotionBeat): Variant {
    const pool = POOLS[beat];
    const recent = this.recent.get(beat) ?? [];
    const fresh = pool.filter((v) => !recent.includes(v?.id ?? "∅"));
    const candidates = fresh.length > 0 ? fresh : pool;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    const marker = chosen?.id ?? "∅";
    this.recent.set(beat, [marker, ...recent].slice(0, Math.min(EXCLUDE_RECENT, pool.length - 1)));
    return chosen;
  }
}

export const motionSelector = new MotionSelector();
