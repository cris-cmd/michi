// Stable interface over the Perxona, browser, and static avatar implementations.

import type { MotionKind } from "../agent/schema";
import type { ListenerDecision } from "../conversation/listener/types";

export type Tone = "neutral" | "warm" | "thinking" | "apologetic" | "delighted";
export type Emotion = "idle" | "listening" | "thinking" | "presenting" | "concerned";

/** Incremental speech for a streamed reply: phrases are queued as the model
 *  produces them; end() resolves when everything queued has played (or the
 *  utterance was interrupted). */
export interface UtteranceHandle {
  speak(phrase: string): void;
  end(): Promise<void>;
  cancel(): void;
}

export type AvatarCaps = {
  speechIn: boolean; // STT available (browser SpeechRecognition)
  speechOut: boolean; // some speech path exists
  emotion: boolean; // an expression/behaviour control exists
  lipsync: boolean;
  bargeIn: boolean; // the avatar can be interrupted mid-sentence by speech
};

export interface AvatarAdapter {
  caps: AvatarCaps;
  /** Distinguishes the real kit for UI affordances only — never for behavior. */
  kind?: "perxona";
  mount(el: HTMLElement): Promise<void>;
  say(text: string, tone?: Tone, lang?: string, motion?: MotionKind): Promise<void>;
  setEmotion(state: Emotion): void; // no-op if !caps.emotion
  /** meta.sttConfidence: weakest finalized STT segment (0..1), when the
   *  recognizer reports one — feeds conversation/transcript.ts. */
  onUserInput(cb: (text: string, meta?: { sttConfidence?: number }) => void): void;
  setListening(on: boolean, lang?: string): void;
  /** Autoplay unlock — call synchronously inside the Begin click handler. */
  unlockAudio?(): Promise<void>;
  /** Play a prerecorded acknowledgement per the listener decision (clip +
   *  emotion + optional motion). Fire-and-forget, never await. Returns the
   *  queued clip's text (it becomes part of the conversation context — see
   *  agent/ackContext.ts) or null if nothing played. */
  playAcknowledgement?(decision: ListenerDecision, lang: string): { text: string } | null;
  /** Begin an incrementally-spoken reply (streamed turn). Optional — callers
   *  fall back to say() with the complete text. */
  beginUtterance?(lang: string, tone?: Tone): UtteranceHandle;
  destroy(): void;
}

import { BrowserAvatarAdapter } from "./fallbacks";
import { MockAdapter } from "./mock";
import { prepareKit } from "./kit";
import { createVoiceEngine } from "../voice";

export async function createAdapter(): Promise<AvatarAdapter> {
  const params = new URLSearchParams(window.location.search);
  if (params.has("mock")) return new MockAdapter();

  if (!params.has("nokit")) {
    const kit = await prepareKit(await createVoiceEngine());
    if (kit) return kit;
  }

  return new BrowserAvatarAdapter({ disableStt: params.has("nostt") });
}

// App calls warmAdapter() from its first effect so the presenter initializes
// and the fillers pre-synthesize while the guest is still reading the Begin
// overlay. Module singleton: StrictMode's double-mount must not build two
// presenters.
let adapterPromise: Promise<AvatarAdapter> | null = null;

export function warmAdapter(): Promise<AvatarAdapter> {
  adapterPromise ??= createAdapter();
  return adapterPromise;
}
