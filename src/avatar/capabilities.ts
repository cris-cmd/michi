// What the mounted adapter can actually do, probed at runtime — the UI uses
// this to decide which fallbacks to render (text field when no STT, etc.).

import type { AvatarAdapter, AvatarCaps } from "./adapter";

export function describeCaps(caps: AvatarCaps): string {
  const parts = [
    caps.speechIn ? "speech-in" : "text-in (no STT)",
    caps.speechOut ? "speech-out" : "silent (no TTS)",
    caps.emotion ? "emotion" : "no emotion",
    caps.lipsync ? "lipsync" : "no lipsync",
    caps.bargeIn ? "barge-in" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function needsTextInput(adapter: AvatarAdapter): boolean {
  return !adapter.caps.speechIn;
}
