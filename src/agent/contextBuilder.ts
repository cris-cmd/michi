// ContextBuilder — the ONE place that decides what conversation history the
// model sees (browser live path; the eval harness feeds its own short
// histories). The principle: authoritative facts do NOT live in prose.
//
//   · constraints / party / plan / budget → promptContext + the LATEST
//     validated JSON response (kept verbatim: it carries current stage +
//     the full constraint state the model itself asserted)
//   · older assistant JSON blobs → reduced to their spoken reply text; the
//     structured state inside them is stale duplication of the above
//   · then the whole window is capped — a 30-turn chat must not grow the
//     prompt linearly forever (old prose vanishes; confirmed facts survive
//     via promptContext + the latest JSON)
//
// Pure and offline-tested (harness/deterministic.ts).

import type { ChatTurn } from "./client";

/** Max messages sent to the model after reduction (user + assistant). 24
 *  messages ≈ the last ~8–10 conversational exchanges incl. spoken acks. */
const MAX_WINDOW = 24;

function isJsonTurn(t: ChatTurn): boolean {
  return t.role === "assistant" && t.content.trimStart().startsWith("{");
}

/** Reduce one historical JSON response to what mattered conversationally —
 *  the words Michi spoke. Malformed content passes through untouched. */
function toSpokenReply(t: ChatTurn): ChatTurn {
  try {
    const reply = (JSON.parse(t.content) as { reply?: unknown }).reply;
    if (typeof reply === "string" && reply.trim()) return { role: "assistant", content: reply };
  } catch {
    /* plain-text turn (spoken ack) or garbage — keep as-is */
  }
  return t;
}

/**
 * Build the history window for a live model turn. The LAST JSON response
 * stays verbatim (current stage + asserted constraint state — core.ts's
 * uncertain-transcript guard also diffs against it); everything older is
 * reduced to prose and the window is capped.
 */
export function buildTurnHistory(history: ChatTurn[]): ChatTurn[] {
  let lastJsonIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (isJsonTurn(history[i])) {
      lastJsonIndex = i;
      break;
    }
  }

  const reduced = history.map((t, i) => (i !== lastJsonIndex && isJsonTurn(t) ? toSpokenReply(t) : t));

  if (reduced.length <= MAX_WINDOW) return reduced;
  const start = reduced.length - MAX_WINDOW;
  // Never cut the latest JSON state turn out of the window.
  const from = lastJsonIndex >= 0 ? Math.min(start, lastJsonIndex) : start;
  return reduced.slice(from);
}

/** Debug aid: approximate context size, logged by the client per turn. */
export function historyBytes(history: ChatTurn[]): number {
  return history.reduce((n, t) => n + t.content.length, 0);
}
