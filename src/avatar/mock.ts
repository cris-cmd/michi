// ?mock=1 — static avatar + text chat, zero speech APIs. "Ship this rather
// than nothing." Testable in ten seconds during demo rehearsal.

import type { AvatarAdapter, AvatarCaps, Emotion, Tone } from "./adapter";

export class MockAdapter implements AvatarAdapter {
  caps: AvatarCaps = { speechIn: false, speechOut: false, emotion: true, lipsync: false, bargeIn: false };
  private inputCb: ((text: string) => void) | null = null;

  async mount(_el: HTMLElement): Promise<void> {}

  async say(text: string, _tone?: Tone, _lang?: string): Promise<void> {
    console.info("[mock avatar says]", text);
  }

  setEmotion(_state: Emotion): void {}

  onUserInput(cb: (text: string, meta?: { sttConfidence?: number }) => void): void {
    this.inputCb = cb;
  }

  /** Used by the text-input fallback UI. */
  injectText(text: string): void {
    this.inputCb?.(text);
  }

  setListening(_on: boolean): void {}

  destroy(): void {}
}
