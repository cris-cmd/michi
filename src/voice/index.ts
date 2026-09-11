// Voice engine selection. ?voice=browser or a missing key returns null, so
// the avatar uses presenter TTS or browser speech synthesis.

import { ElevenVoice } from "./eleven";
import type { VoiceEngine } from "./types";

export type { Lang, Tone, VoiceEngine } from "./types";
export { BrowserVoice } from "./browser";

export async function createVoiceEngine(): Promise<VoiceEngine | null> {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("voice") === "browser") return null;
  }
  // The key lives server-side only; a lightweight same-origin probe preserves
  // the old construction-time decision (no key → null → tier 1 skipped).
  try {
    const res = await fetch("/api/michi/voice", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const { available } = (await res.json()) as { available?: boolean };
    return available ? new ElevenVoice() : null;
  } catch {
    return null;
  }
}
