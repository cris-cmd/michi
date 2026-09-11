// Acknowledgement → main-agent context weaving. When the listener has already
// spoken an acknowledgement
// ("I'm really sorry to hear that."), the turn history ends with that plain-
// text assistant turn. The model must treat it as the first words of its own
// reply — not as something to repeat. This module owns that contract:
//
//   [... , user: transcript, assistant: ack]
//     → [... , user: transcript, assistant: ack, user: continuation note]
//
// plus the merge step that keeps the Messages API strictly user/assistant
// alternating (stored history legitimately contains consecutive assistant
// turns: the spoken ack followed by the validated JSON response).
//
// Pure functions, no SDK, no browser APIs — tested in harness/deterministic.ts.

import type { ChatTurn } from "./client";

/** The instruction appended when the trailing turn is a spoken ack. Kept as
 *  a user-role system note (same convention as the validation-retry note in
 *  core.ts) so it survives the internal retry path unchanged. */
export function ackContinuationNote(ack: string): string {
  return (
    `[system note: you (Michi) already said aloud: "${ack}" — the guest heard it ` +
    `as the first words of this reply. Continue naturally from that point. ` +
    `Do NOT repeat it, paraphrase it, or open with another acknowledgement ` +
    `("got it", "okay", "sure", "I understand", "I'm sorry", "that's exciting"). ` +
    `Begin your reply directly with the useful continuation.]`
  );
}

/** True for the user-role system notes this codebase injects ("[system
 *  note: …]") — retrieval hints and transcripts must ignore them. */
export function isSystemNote(turn: ChatTurn): boolean {
  return turn.role === "user" && turn.content.startsWith("[system note:");
}

/** A trailing assistant turn is a spoken ack (plain text) — never the JSON
 *  state responses applyAgentResponse stores. */
function isSpokenAckTurn(turn: ChatTurn | undefined): turn is ChatTurn {
  return (
    !!turn && turn.role === "assistant" && !turn.content.trimStart().startsWith("{")
  );
}

/** If the history ends with a spoken ack, append the continuation note so
 *  the model generates only the continuation. No-op otherwise. */
export function withAckContinuation(history: ChatTurn[]): ChatTurn[] {
  const last = history[history.length - 1];
  if (!isSpokenAckTurn(last)) return history;
  return [...history, { role: "user", content: ackContinuationNote(last.content) }];
}

/** Merge consecutive same-role turns (ack + JSON response are both
 *  assistant) so the Messages API always sees alternating roles. */
export function mergeAlternating(history: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const turn of history) {
    const prev = out[out.length - 1];
    if (prev && prev.role === turn.role) {
      out[out.length - 1] = { role: prev.role, content: `${prev.content}\n${turn.content}` };
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}
