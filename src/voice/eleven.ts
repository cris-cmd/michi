import type { Lang, Tone, VoiceEngine } from "./types";

// ElevenLabs engine, hardened: the browser holds NO key and never talks to
// api.elevenlabs.io. synth() posts to the same-origin endpoint
// POST /api/michi/voice (Vite middleware → src/server/handlers.ts), which
// owns the provider specifics — one voice ID for all four languages,
// eleven_flash_v2_5, MP3 stream endpoint, tone→stability mapping.
//
// The behavioral contract is unchanged: complete ArrayBuffer out (chunk-level
// pipelining lives in the adapter), 8s timeout, and two consecutive failures
// mark the engine unhealthy so the adapter stops paying the round trip.

const SYNTH_TIMEOUT_MS = 8000;

export class ElevenVoice implements VoiceEngine {
  /** Consecutive failures; after 2 the adapter should stop paying the round trip. */
  private failures = 0;

  get healthy(): boolean {
    return this.failures < 2;
  }

  async synth(text: string, lang: Lang, tone?: Tone, previousText?: string): Promise<ArrayBuffer> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
    try {
      const res = await fetch("/api/michi/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ text, lang, tone, ...(previousText ? { previousText } : {}) }),
      });
      if (!res.ok) {
        this.failures++;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `voice endpoint failed (${res.status})`);
      }
      const buf = await res.arrayBuffer();
      this.failures = 0;
      return buf;
    } catch (err) {
      if (ctrl.signal.aborted) this.failures++;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
