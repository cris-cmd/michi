// Browser client for the in-process affect models (/api/michi/affect).
// The contract with the turn pipeline:
//
//   · partial transcripts stream in during speech → prewarmText() keeps the
//     server's text-affect LRU warm (fire-and-forget, throttled)
//   · on the final transcript, finalRead() races inference against
//     ACK_BUDGET_MS — a missed budget returns null and the deterministic
//     policy's decision stands unchanged (graceful degradation, offline-
//     safe: ?mockagent demos never touch the network)
//
// The listener runtime stays independent of the planning model and app state.

import type { AffectRead } from "./affect/types";

const disabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mockagent");

/** How long the spoken ack may wait for perception. Beyond this the rules
 *  ack plays anyway — a slightly plainer "Got it." beats a late one. The
 *  visual/emotional read still lands when inference finishes. */
export const ACK_BUDGET_MS = 500;

const PREWARM_THROTTLE_MS = 400;
let lastPrewarm = 0;
let lastPrewarmText = "";

let available: boolean | null = null;

/** Boot-time probe; also starts model loading server-side so the first real
 *  utterance hits warm models. */
export async function probeAffect(): Promise<boolean> {
  if (disabled) {
    available = false;
    return false;
  }
  try {
    const res = await fetch("/api/michi/affect");
    available = res.ok;
  } catch {
    available = false;
  }
  return available;
}

/** Throttled text-only prewarm on partial transcripts (fire-and-forget). */
export function prewarmText(partial: string): void {
  if (available === false) return;
  const text = partial.trim();
  const now = Date.now();
  if (!text || text === lastPrewarmText || now - lastPrewarm < PREWARM_THROTTLE_MS) return;
  lastPrewarm = now;
  lastPrewarmText = text;
  void fetch("/api/michi/affect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

/**
 * Full read for the committed utterance (text + optional utterance audio as
 * base64 int16 PCM @16 kHz). Resolves null on timeout/error — callers MUST
 * treat null as "no perception, keep the rule decision".
 *
 * Two requests race the budget: text-only (~16 ms warm, LRU-cached) and
 * text+audio (~100 ms for short clips, but long utterances can blow the
 * budget). If the full read misses, the text read alone still stands — this
 * is what stops a bereavement sentence ending in "…would be great" from
 * getting a cheery rules-only ack while the audio model chews a 10 s clip.
 */
export async function finalRead(
  text: string,
  audioB64: string | null,
  budgetMs: number = ACK_BUDGET_MS,
): Promise<AffectRead | null> {
  if (available === false) return null;

  const post = (body: object, signal?: AbortSignal): Promise<AffectRead | null> =>
    fetch("/api/michi/affect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<AffectRead>) : null))
      .catch(() => null);

  const budget = new Promise<undefined>((r) => setTimeout(() => r(undefined), budgetMs));

  let textResult: AffectRead | null = null;
  const textOnly = post({ text }).then((r) => (textResult = r));

  if (!audioB64) return (await Promise.race([textOnly, budget])) ?? null;

  const ctrl = new AbortController();
  const full = post({ text, audioB64 }, ctrl.signal);
  const winner = await Promise.race([full, budget]);
  if (winner) return winner;
  ctrl.abort(); // budget spent — don't leave the audio inference request dangling
  // The text read (16 ms) has virtually always landed by now; semantic
  // perception beats no perception even without vocal tone.
  return textResult ?? (await Promise.race([textOnly, Promise.resolve(null)])) ?? null;
}
