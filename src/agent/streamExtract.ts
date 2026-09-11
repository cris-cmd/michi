// Incremental extraction of the speakable fields from the structured-output
// JSON while it streams. The response schema deliberately orders language and
// tone BEFORE reply (schema.ts) so both are usually known before the first
// reply words arrive; the extractor still works (reply-only) if the model
// emits fields in another order. Everything after reply (constraints,
// candidates, excluded, …) is ignored here — the caller validates the
// complete JSON at the end as before.
//
// Pure and dependency-free: runs server-side in the turn stream handler and
// is unit-testable in the deterministic harness.

import type { Language, Tone } from "./schema";

const LANG_RE = /"language"\s*:\s*"(en|ja|zh|ko)"/;
const TONE_RE = /"tone"\s*:\s*"(neutral|warm|thinking|apologetic|delighted)"/;
const REPLY_START_RE = /"reply"\s*:\s*"/;

export type ExtractEvent = {
  language?: Language;
  tone?: Tone;
  /** Newly decoded reply text since the last push. */
  replyDelta?: string;
  /** The reply string's closing quote has been seen. */
  replyDone?: boolean;
};

/** Decode a JSON string body prefix (no surrounding quotes). Returns the
 *  decoded text, how many raw chars were consumed, and whether the closing
 *  unescaped quote was reached. A trailing incomplete escape is left
 *  unconsumed so the next push completes it. */
function decodePrefix(raw: string): { text: string; consumed: number; closed: boolean } {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return { text: out, consumed: i, closed: true };
    if (c === "\\") {
      if (i + 1 >= raw.length) break; // incomplete escape — wait for more
      const e = raw[i + 1];
      if (e === "u") {
        if (i + 6 > raw.length) break;
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      const MAP: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      out += MAP[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, consumed: i, closed: false };
}

export class ReplyStreamExtractor {
  private buffer = "";
  private language: Language | null = null;
  private tone: Tone | null = null;
  private replyStart = -1; // index into buffer where the reply string body begins
  private replyEmitted = 0; // decoded chars already emitted
  private replyDone = false;

  push(rawDelta: string): ExtractEvent {
    this.buffer += rawDelta;
    const ev: ExtractEvent = {};

    if (!this.language) {
      const m = LANG_RE.exec(this.buffer);
      if (m) ev.language = this.language = m[1] as Language;
    }
    if (!this.tone) {
      const m = TONE_RE.exec(this.buffer);
      if (m) ev.tone = this.tone = m[1] as Tone;
    }

    if (!this.replyDone) {
      if (this.replyStart < 0) {
        const m = REPLY_START_RE.exec(this.buffer);
        if (m) this.replyStart = m.index + m[0].length;
      }
      if (this.replyStart >= 0) {
        const { text, closed } = decodePrefix(this.buffer.slice(this.replyStart));
        if (text.length > this.replyEmitted) {
          ev.replyDelta = text.slice(this.replyEmitted);
          this.replyEmitted = text.length;
        }
        if (closed) {
          this.replyDone = true;
          ev.replyDone = true;
        }
      }
    }
    return ev;
  }

  raw(): string {
    return this.buffer;
  }
}
