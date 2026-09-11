// Turns a stream of reply-text deltas into speakable phrases. ElevenLabs
// must never see individual tokens — phrases are cut at sentence boundaries,
// with a shorter minimum for the FIRST phrase (audio out sooner) and a
// longer one after (fewer, smoother clips).

const CJK_ENDERS = "。．！？…";
const ASCII_ENDERS = ".!?";

export class PhraseAssembler {
  private buf = "";
  private emittedAny = false;

  constructor(
    private firstMinChars = 12,
    private restMinChars = 48,
  ) {}

  /** Feed a delta; returns zero or more completed phrases. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const phrase = this.takePhrase();
      if (!phrase) break;
      out.push(phrase);
    }
    return out;
  }

  /** Whatever is left (end of stream). */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest.length > 0 ? rest : null;
  }

  private takePhrase(): string | null {
    const min = this.emittedAny ? this.restMinChars : this.firstMinChars;
    // find the earliest usable boundary at or after `min` characters
    for (let i = min - 1; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (CJK_ENDERS.includes(c)) {
        return this.cut(i + 1);
      }
      if (ASCII_ENDERS.includes(c)) {
        // an ASCII ender is only a boundary when followed by whitespace or a
        // closing quote — "3.5" and "Mt. Fuji" must not split. A trailing
        // ender at the buffer edge waits for the next delta (flush() covers
        // end-of-stream).
        const next = this.buf[i + 1];
        if (next === undefined) return null;
        if (/[\s"'’”)]/.test(next)) return this.cut(i + 1);
      }
    }
    return null;
  }

  private cut(end: number): string {
    // include trailing closing quotes/spaces in the phrase
    while (end < this.buf.length && /[\s"'’”)]/.test(this.buf[end])) end++;
    const phrase = this.buf.slice(0, end).trim();
    this.buf = this.buf.slice(end);
    this.emittedAny = true;
    return phrase;
  }
}
