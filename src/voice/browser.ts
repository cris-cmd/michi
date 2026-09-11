// BrowserVoice — the speechSynthesis engine. This is the deliberate "bypassed"
// shape from the voice-pillar design: speechSynthesis cannot hand back an
// ArrayBuffer, so it does not implement VoiceEngine.synth. Instead it plays
// aloud directly and the adapter uses it as the last tier (and ?voice=browser
// simply constructs the adapter with no VoiceEngine at all, so tier 1 is
// skipped). Construction is the only place that decision is made.

import { speakable } from "./speakable";
import type { Lang, Tone } from "./types";

const LANG_TO_BCP47: Record<string, string> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-TW",
};

export class BrowserVoice {
  readonly available = typeof window !== "undefined" && "speechSynthesis" in window;

  warm(): void {
    // some browsers populate the voice list lazily
    if (this.available) window.speechSynthesis.getVoices();
  }

  private pickVoice(bcp47: string): SpeechSynthesisVoice | undefined {
    const voices = window.speechSynthesis.getVoices();
    const prefix = bcp47.split("-")[0];
    return (
      voices.find((v) => v.lang.replace("_", "-") === bcp47) ??
      voices.find((v) => v.lang.startsWith(prefix))
    );
  }

  speak(text: string, lang?: Lang | string, _tone?: Tone): Promise<void> {
    if (!this.available) return Promise.resolve();
    const bcp47 = LANG_TO_BCP47[lang ?? "en"] ?? "en-US";
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(speakable(text, (lang ?? "en") as Lang));
      u.lang = bcp47;
      const voice = this.pickVoice(bcp47);
      if (voice) u.voice = voice;
      u.rate = 1.02;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  }

  cancel(): void {
    if (this.available) window.speechSynthesis.cancel();
  }
}
