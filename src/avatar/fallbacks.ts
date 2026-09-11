// Browser speech in/out when the Perxona kit lacks it (or isn't reachable).
// STT: Web Speech API SpeechRecognition in CONTINUOUS mode with our own
// silence endpointing (src/voice/endpoint.ts) — the mic cycles hands-free:
// listening → hearing → endpoint → commit → (thinking/speaking) → listening.
// TTS: BrowserVoice (speechSynthesis). If STT is unsupported, caps.speechIn
// is false and the UI shows a text field. Also serves as the STT half (and
// barge-in trigger) inside PerxonaKitAdapter.

import type { AvatarAdapter, AvatarCaps, Emotion, Tone, UtteranceHandle } from "./adapter";
import { BrowserVoice } from "../voice/browser";
import { endpointDelayMs } from "../voice/endpoint";
import * as metrics from "../conversation/metrics";
import { prewarmText } from "../conversation/listener/affectClient";
import type { Lang } from "../voice/types";

type SpeechResultLike = ArrayLike<{ transcript: string; confidence?: number }> & {
  isFinal?: boolean;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<SpeechResultLike> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  onspeechstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

// Speech recognition locale per spec: zh maps to Taiwan Mandarin. Applied
// on the NEXT listening session (setListening), never mid-turn.
const LANG_TO_BCP47: Record<string, string> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-TW",
};

export class BrowserAvatarAdapter implements AvatarAdapter {
  caps: AvatarCaps;
  private voice = new BrowserVoice();
  private recognition: SpeechRecognitionLike | null = null;
  private inputCb: ((text: string, meta?: { sttConfidence?: number }) => void) | null = null;
  private speechActivityCb: (() => void) | null = null;
  private listening = false;
  private wantListening = false;
  private lang = "en-US";
  private endpointTimer: ReturnType<typeof setTimeout> | null = null;
  private heardFinal = "";
  private heardInterim = "";
  private finalConfidences: number[] = [];

  constructor(opts: { disableStt?: boolean } = {}) {
    const RecognitionCtor = opts.disableStt ? null : getRecognitionCtor();
    this.caps = {
      speechIn: RecognitionCtor !== null,
      speechOut: this.voice.available,
      emotion: true, // our own CSS avatar renders emotion states
      lipsync: false,
      bargeIn: false, // browser TTS pauses the mic while speaking — no barge-in
    };
    if (RecognitionCtor) {
      this.recognition = new RecognitionCtor();
      // Continuous conversation mode: the session stays open across turns;
      // WE decide when an utterance ends (silence endpointing below), not
      // the browser's aggressive default endpointer.
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.onspeechstart = () => {
        metrics.preMark("speechStart");
        this.speechActivityCb?.();
      };
      this.recognition.onresult = (e) => {
        let finals = "";
        let interim = "";
        const confidences: number[] = [];
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          const text = r[0]?.transcript ?? "";
          if (r.isFinal) {
            finals += `${text} `;
            // STT confidence per finalized segment — the transcript
            // validator (conversation/transcript.ts) scores the utterance
            // from these; a suspect hearing must never be treated as truth.
            if (typeof r[0]?.confidence === "number" && r[0].confidence > 0) {
              confidences.push(r[0].confidence);
            }
          } else interim += `${text} `;
        }
        this.heardFinal = finals.trim();
        this.heardInterim = interim.trim();
        this.finalConfidences = confidences;
        // Any result = the user is (still) talking → barge-in signal and a
        // fresh endpoint window sized to what we've heard so far.
        if (this.heardInterim || this.heardFinal) {
          metrics.preMark("speechStart");
          metrics.preMark("partialTranscriptFirst");
          metrics.preMark("speechEnd"); // last-wins: end of speech ≈ last result
          this.speechActivityCb?.();
          // Incremental affect: partials keep the server's text-affect LRU
          // warm so the endpoint-time read is mostly a cache hit.
          prewarmText(`${this.heardFinal} ${this.heardInterim}`.trim());
        }
        this.scheduleEndpoint();
      };
      this.recognition.onend = () => {
        this.listening = false;
        // commit whatever we have (browser closed the session on its own),
        // then auto-restart if the app still wants the mic open
        this.commitUtterance();
        if (this.wantListening) this.startRecognition();
      };
      this.recognition.onerror = () => {
        this.listening = false;
      };
    }
  }

  private scheduleEndpoint(): void {
    if (this.endpointTimer) clearTimeout(this.endpointTimer);
    const soFar = `${this.heardFinal} ${this.heardInterim}`.trim();
    this.endpointTimer = setTimeout(() => this.commitUtterance(), endpointDelayMs(soFar));
  }

  private commitUtterance(): void {
    if (this.endpointTimer) {
      clearTimeout(this.endpointTimer);
      this.endpointTimer = null;
    }
    const text = (this.heardFinal || this.heardInterim).trim();
    const confs = this.finalConfidences;
    this.heardFinal = "";
    this.heardInterim = "";
    this.finalConfidences = [];
    if (text) metrics.preMark("finalTranscript");
    if (text && this.inputCb) {
      // Utterance confidence = the WEAKEST finalized segment (one garbled
      // span poisons the whole hearing); interim-only commits report none.
      const sttConfidence = confs.length ? Math.min(...confs) : undefined;
      this.inputCb(text, { sttConfidence });
    }
  }

  async mount(_el: HTMLElement): Promise<void> {
    // Visuals are rendered by Stage.tsx (the CSS avatar); nothing to mount.
    this.voice.warm();
  }

  say(text: string, tone?: Tone, lang?: string): Promise<void> {
    if (!this.caps.speechOut) return Promise.resolve();
    // pause the mic while speaking so the avatar doesn't hear itself
    const resume = this.wantListening;
    this.setListening(false);
    return this.voice.speak(text, lang as Lang | undefined, tone).then(() => {
      if (resume) this.setListening(true, lang);
    });
  }

  /** Streamed-reply speech: phrases play sequentially through speechSynthesis
   *  (local, so no latency win — this exists for pipeline parity). */
  beginUtterance(lang?: string, tone?: Tone): UtteranceHandle {
    const resume = this.wantListening;
    this.setListening(false);
    let chain: Promise<void> = Promise.resolve();
    let cancelled = false;
    return {
      speak: (phrase) => {
        if (cancelled || !this.caps.speechOut) return;
        chain = chain.then(() => {
          if (cancelled) return;
          metrics.mark("avatarAudibleStart");
          return this.voice.speak(phrase, lang as Lang | undefined, tone);
        });
      },
      end: async () => {
        await chain;
        metrics.markLast("avatarPresentationEnd");
        if (resume && !cancelled) this.setListening(true, lang);
      },
      cancel: () => {
        cancelled = true;
        this.voice.cancel();
      },
    };
  }

  setEmotion(_state: Emotion): void {
    // Emotion is rendered by Stage.tsx reading the store; nothing to do here.
  }

  onUserInput(cb: (text: string, meta?: { sttConfidence?: number }) => void): void {
    this.inputCb = cb;
  }

  /** Fires the moment the mic detects speech — the kit's barge-in trigger. */
  onSpeechActivity(cb: () => void): void {
    this.speechActivityCb = cb;
  }

  setListening(on: boolean, lang?: string): void {
    this.wantListening = on;
    if (!this.recognition) return;
    if (lang) this.lang = LANG_TO_BCP47[lang] ?? this.lang;
    if (on && !this.listening) {
      this.startRecognition();
    } else if (!on && this.listening) {
      // drop any half-heard audio: a closed mic must not emit a turn later
      if (this.endpointTimer) clearTimeout(this.endpointTimer);
      this.endpointTimer = null;
      this.heardFinal = "";
      this.heardInterim = "";
      this.recognition.stop();
      this.listening = false;
    }
  }

  private startRecognition(): void {
    if (!this.recognition || this.listening) return;
    try {
      this.recognition.lang = this.lang;
      this.recognition.start();
      this.listening = true;
    } catch {
      // start() throws if already started — ignore
    }
  }

  destroy(): void {
    this.wantListening = false;
    if (this.endpointTimer) clearTimeout(this.endpointTimer);
    this.recognition?.abort();
    this.voice.cancel();
  }
}
