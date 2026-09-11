// Perxona's presenter is loaded as a Web Component at runtime. Speech falls
// back from supplied audio, to presenter TTS, to browser speech synthesis.

import type {
  IPresentationWidget,
  PresentOptions,
  PresentationTarget,
} from "@perxona/presenter-types";
import type { AvatarAdapter, AvatarCaps, Emotion, Tone, UtteranceHandle } from "./adapter";
import type { MotionKind } from "../agent/schema";
import { BrowserAvatarAdapter } from "./fallbacks";
import { BrowserVoice } from "../voice/browser";
import { AcknowledgementLibrary } from "../conversation/listener/acks";
import type { ListenerDecision } from "../conversation/listener/types";
import { avatarEmotionOptions, listenerToAvatarEmotion, toneOptions } from "../conversation/emotion";
import * as metrics from "../conversation/metrics";
import { motionSelector } from "./motionSelector";
import { useSettings } from "../flow/settings";
import { SPEECH_LANG } from "../i18n";
import type { Lang, VoiceEngine } from "../voice/types";

type PresenterEl = HTMLElement & IPresentationWidget;

// PresentationResultCode.PRESENTATION_INTERRUPTED. A barge-in interrupt
// resolves in-flight present*() calls with this code — it is NOT a failure,
// and falling through to the next tier would replay the line in a second
// voice. Literal because the types package has no runtime exports.
const INTERRUPTED = "303";

// Motion IDs are avatar-specific. null leaves body language to the presenter.
export const MICHI_MOTIONS: Record<MotionKind, string | null> = {
  greeting: null,
  correction: "01KZAH3BEZCXDRCZ0T05ZGQMFJ",
};

// Attentive reaction on user speech onset: the avatar detail exposes NO
// listening/thinking state assets, so setListening() may render nothing —
// an explicit motion (rotating variants via motionSelector) is the reliable
// reaction. Throttled so long utterances get an occasional re-engagement,
// not a twitch per phrase.
const LISTEN_REACT_THROTTLE_MS = 6000;

function motionPrefix(motion?: MotionKind): string {
  const id = motion ? MICHI_MOTIONS[motion] : null;
  return id ? `[MOTION ${id}:1] ` : "";
}

// Split a reply into speakable chunks so the first ElevenLabs request is a
// short sentence, not the whole paragraph — playback starts on the first
// chunk while the rest still synthesizes. present*() calls queue in order,
// so chunk-by-chunk handoff is safe by contract.
export function splitSpeech(text: string, minLen = 24, maxChunks = 4): string[] {
  const parts = text.match(/[^。．！？.!?]+[。．！？.!?]*/g) ?? [text];
  const merged: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc} ${p.trim()}` : p.trim();
    if (acc.length >= minLen) {
      merged.push(acc);
      acc = "";
    }
  }
  if (acc) {
    if (merged.length) merged[merged.length - 1] += ` ${acc}`;
    else merged.push(acc);
  }
  if (merged.length > maxChunks) {
    merged.splice(maxChunks - 1, merged.length, merged.slice(maxChunks - 1).join(" "));
  }
  return merged;
}

async function fetchJson<T>(path: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`presenter engine failed to load: ${url}`));
    document.head.append(script);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

type KitConfig = {
  available: boolean;
  presenterUrl?: string;
  target?: PresentationTarget;
  reason?: string;
};

/** Broadcast for Stage.tsx (hide the orb, show the presenter) and the Begin overlay. */
function announce(status: string): void {
  window.dispatchEvent(new CustomEvent("michi:kit-status", { detail: status }));
}

export class PerxonaKitAdapter implements AvatarAdapter {
  caps: AvatarCaps;
  readonly kind = "perxona";

  private fallback: BrowserAvatarAdapter;
  private voiceFallback = new BrowserVoice();
  private acks = new AcknowledgementLibrary();
  private speaking = false;
  private interrupted = false;
  private performing = false;
  private refreshingToken = false;
  private quietWaiters = new Set<() => void>();
  private ready = false;
  private readyWaiters = new Set<(ok: boolean) => void>();
  /** App-desired thinking presence; re-asserted after filler performances so
   *  the widget's Talking state can't dump the avatar back to plain idle
   *  while the planning model is still working. */
  private desiredThinking = false;

  constructor(
    private presenter: PresenterEl,
    private voice: VoiceEngine | null,
  ) {
    this.fallback = new BrowserAvatarAdapter();
    this.caps = {
      speechIn: this.fallback.caps.speechIn,
      speechOut: true,
      emotion: true,
      lipsync: true,
      bargeIn: this.fallback.caps.speechIn,
    };

    presenter.addEventListener("PRESENTER_STATUS", (e) => {
      const detail = (e as CustomEvent).detail as { status?: string } | string | undefined;
      const status = typeof detail === "string" ? detail : (detail?.status ?? "");
      announce(status);
      if (status === "Ready") {
        presenter.hidden = false;
        this.ready = true;
        for (const w of [...this.readyWaiters]) w(true);
        // Pre-synthesize the acknowledgement library NOW — never on demand
        // (that would add a round trip to the thing meant to hide one).
        // Active UI language + English fallback; other languages warm lazily.
        if (this.voice) {
          const active = SPEECH_LANG[useSettings.getState().language] as Lang;
          void this.acks.prewarm(this.voice, active === "en" ? ["en"] : [active, "en"]);
        }
        this.voiceFallback.warm();
      }
    });

    // The sample's gotcha: CONNECT_TOKEN_EXPIRED is documented but you must
    // wire it yourself — the demo runs at 19:00 after a long session, and
    // "reload the page" is not a plan.
    presenter.addEventListener("CONNECT_TOKEN_EXPIRED", () => void this.refreshToken());

    // Queue activity, kept as a flag so say() can wait for real quiet instead
    // of guessing at playback duration.
    presenter.addEventListener("PERFORMANCE_START", () => {
      this.performing = true;
      // Reply audio became audible (ack performances play while !speaking,
      // so this first-wins mark lands on the actual answer).
      if (this.speaking) metrics.mark("avatarAudibleStart");
    });
    presenter.addEventListener("ALL_PERFORMANCE_FINISHED", () => {
      this.performing = false;
      if (this.speaking) metrics.markLast("avatarPresentationEnd");
      else metrics.markLast("acknowledgementAudioEnd");
      // An ack's Talking state ends here — if the app still wants Thinking
      // (model in flight), restore it immediately instead of falling to idle.
      if (this.desiredThinking) presenter.setThinking(true);
      this.resolveQuiet();
    });

    // Barge-in: mic hears speech while the avatar is talking → cut the
    // performance and clear the queue. The transcript then arrives through
    // the normal onresult path and becomes the next turn. When the avatar
    // is quiet, the same signal drives the attentive listening reaction.
    this.fallback.onSpeechActivity(() => {
      if (this.speaking || this.performing) this.interrupt();
      else this.reactToUserSpeech();
    });
  }

  private lastListenReact = 0;

  /** User speech started (or continues): lean in. Visible within one motion
   *  dispatch of speech onset — no model, no synthesis, no round trip. */
  private reactToUserSpeech(): void {
    const now = Date.now();
    if (now - this.lastListenReact < LISTEN_REACT_THROTTLE_MS) return;
    this.lastListenReact = now;
    this.presenter.setListening(true); // correct even if this avatar has no state asset
    const variant = motionSelector.pick("listening");
    if (variant) void this.presenter.playMotion(variant.id);
  }

  private async refreshToken(): Promise<void> {
    if (this.refreshingToken) return;
    this.refreshingToken = true;
    try {
      const { connect_token } = await fetchJson<{ connect_token: string }>(
        "/api/michi/connect-token",
        10000,
      );
      this.presenter.refreshConnectToken(connect_token);
    } catch (err) {
      console.warn("[kit] connect token refresh failed:", err);
    } finally {
      this.refreshingToken = false;
    }
  }

  private interrupt(): void {
    this.interrupted = true;
    this.presenter.interruptPresentation();
    this.voiceFallback.cancel();
    metrics.markLast("avatarPresentationEnd");
    // Never leave a stuck performance state behind an interrupt.
    this.desiredThinking = false;
    this.presenter.setThinking(false);
    this.resolveQuiet();
  }

  private resolveQuiet(): void {
    for (const w of [...this.quietWaiters]) w();
  }

  /** Resolves when the performance queue drains (or on interrupt / 45s cap). */
  private waitQuiet(): Promise<void> {
    if (!this.performing) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.quietWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 45000);
      this.quietWaiters.add(done);
    });
  }

  /** Resolves true once PRESENTER_STATUS hits Ready; false on timeout. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.readyWaiters.add(done);
    });
  }

  /** MUST be invoked synchronously inside the user's click — autoplay unlock. */
  unlockAudio(): Promise<void> {
    return this.presenter.resumeAudioPlayback().catch((err) => {
      console.warn("[kit] resumeAudioPlayback failed:", err);
    });
  }

  async mount(_el: HTMLElement): Promise<void> {
    // The presenter element was placed into #presenter-slot during prepareKit;
    // reparenting a live WebGL component would reset it, so mount() only
    // readies the speech fallbacks.
    await this.fallback.mount(_el);
  }

  private startSynth(
    text: string,
    lang: Lang,
    tone?: Tone,
    previousText?: string,
  ): Promise<ArrayBuffer> | null {
    if (!this.voice || this.voice.healthy === false) return null;
    return this.voice.synth(text, lang, tone, previousText);
  }

  /** Present one chunk through the tiers: our audio → Perxona TTS. Returns
   *  how it went so callers decide whether to fall to browser speech.
   *  Code 303 (interrupted) must STOP the chain — never re-tier. */
  private async presentChunk(
    content: string,
    buf: ArrayBuffer | null,
    opts?: PresentOptions,
  ): Promise<"queued" | "interrupted" | "failed"> {
    if (buf) {
      const r = await this.presenter.presentWithAudio(buf, content, opts);
      if (r.success) {
        metrics.mark("avatarPresentationStart");
        return "queued";
      }
      if (String(r.code) === INTERRUPTED) return "interrupted";
      console.warn("[kit] presentWithAudio failed:", r.code, r.message);
    }
    const r2 = await this.presenter.present(content, opts);
    if (r2.success) {
      metrics.mark("avatarPresentationStart");
      return "queued";
    }
    if (String(r2.code) === INTERRUPTED) return "interrupted";
    console.warn("[kit] present failed:", r2.code, r2.message);
    return "failed";
  }

  /** Enter the speaking posture: thinking/listening presence ends the moment
   *  real speech begins — Behavior AI owns talking body language from here. */
  private enterSpeaking(): void {
    this.speaking = true;
    this.interrupted = false;
    this.desiredThinking = false;
    this.presenter.setThinking(false);
    this.presenter.setListening(false);
  }

  async say(text: string, tone?: Tone, lang?: string, motion?: MotionKind): Promise<void> {
    const language = (lang ?? "en") as Lang;
    const opts = toneOptions(tone);
    this.enterSpeaking();
    try {
      const chunks = splitSpeech(text);
      let queued = false;
      metrics.mark("ttsRequestStart");
      let inFlight = this.startSynth(chunks[0], language, tone);

      for (let i = 0; i < chunks.length; i++) {
        if (this.interrupted) return;
        const buf = inFlight
          ? await inFlight.catch((err) => {
              console.warn("[voice] synth failed:", err);
              return null;
            })
          : null;
        if (buf) metrics.mark("ttsFirstAudio");
        // keep the pipeline full: next chunk synthesizes while this one plays
        inFlight = i + 1 < chunks.length ? this.startSynth(chunks[i + 1], language, tone) : null;
        const content = (i === 0 ? motionPrefix(motion) : "") + chunks[i];

        const result = await this.presentChunk(content, buf, opts);
        if (result === "queued") {
          queued = true;
          continue;
        }
        if (result === "interrupted") return;
        await this.voiceFallback.speak(chunks.slice(i).join(" "), language, tone);
        return;
      }
      if (queued) await this.waitQuiet();
    } finally {
      this.speaking = false;
    }
  }

  /** Incremental reply speech for the streamed turn. Phrases synthesize the
   *  moment they arrive (in parallel) but present strictly in order; the
   *  presenter's FIFO queue makes consecutive chunks seamless. */
  beginUtterance(lang: string, tone?: Tone): UtteranceHandle {
    const language = (lang ?? "en") as Lang;
    const opts = toneOptions(tone);
    this.enterSpeaking();
    let chain: Promise<void> = Promise.resolve();
    let queuedAny = false;
    let cancelled = false;
    let first = true;
    let lastPhrase: string | undefined; // prosodic continuity across phrases

    const speak = (phrase: string): void => {
      if (cancelled || this.interrupted) return;
      if (first) {
        metrics.mark("ttsRequestStart");
        first = false;
      }
      const synth = this.startSynth(phrase, language, tone, lastPhrase); // starts NOW
      lastPhrase = phrase;
      chain = chain.then(async () => {
        if (cancelled || this.interrupted) return;
        const buf = synth
          ? await synth.catch((err) => {
              console.warn("[voice] synth failed:", err);
              return null;
            })
          : null;
        if (buf) metrics.mark("ttsFirstAudio");
        if (cancelled || this.interrupted) return;
        const result = await this.presentChunk(phrase, buf, opts);
        if (result === "queued") queuedAny = true;
        else if (result === "failed") await this.voiceFallback.speak(phrase, language, tone);
      });
    };

    return {
      speak,
      end: async () => {
        await chain;
        if (queuedAny && !cancelled && !this.interrupted) await this.waitQuiet();
        this.speaking = false;
      },
      cancel: () => {
        cancelled = true;
        this.speaking = false;
      },
    };
  }

  /** Fire-and-forget latency mask; queued ahead of the reply, never awaited.
   *  Returns the queued clip's text (spoken-ack context) or null. */
  playAcknowledgement(decision: ListenerDecision, lang: string): { text: string } | null {
    const language = lang as Lang;
    if (this.voice) this.acks.ensureLanguage(this.voice, language); // lazy-warm on language switch
    // Beat gestures fire independently of the speech queue — visible
    // immediately, even when the verbal ack shelf is empty. Variants rotate
    // (motionSelector) so repeated beats never loop one canned motion.
    if (decision.motion) {
      const variant = motionSelector.pick(decision.motion);
      if (variant) {
        void this.presenter.playMotion(variant.id);
        metrics.note("motion", variant.name);
      }
    }
    // Nonverbal mode: the gesture above IS the acknowledgement ("I heard
    // you" without words) — no clip, and the reply starts sooner.
    if (decision.mode !== "spoken" || !decision.ackCategory) return null;
    const clip = this.acks.pick(language, decision.ackCategory);
    if (!clip) return null;
    const opts = avatarEmotionOptions(listenerToAvatarEmotion(decision.emotion));
    void this.presenter.presentWithAudio(clip.buf, clip.text, opts).then((r) => {
      if (r.success) metrics.mark("acknowledgementAudioStart");
      else if (String(r.code) !== INTERRUPTED) console.debug("[kit] ack skipped:", r.code);
    });
    return { text: clip.text };
  }

  setEmotion(state: Emotion): void {
    // Facial expression through the kit is automatic (from text/options);
    // what IS controllable are the performance states — map ours onto them.
    // desiredThinking makes Thinking sticky across filler playback (see the
    // ALL_PERFORMANCE_FINISHED handler); everything else is app-authoritative
    // regardless of whether the widget honors the call (fallback tiers keep
    // their own UI state).
    this.desiredThinking = state === "thinking";
    this.presenter.setThinking(this.desiredThinking);
    this.presenter.setListening(state === "listening");
  }

  onUserInput(cb: (text: string, meta?: { sttConfidence?: number }) => void): void {
    this.fallback.onUserInput(cb);
  }

  setListening(on: boolean, lang?: string): void {
    this.fallback.setListening(on, lang);
  }

  destroy(): void {
    // The presenter element survives (module singleton — StrictMode remounts
    // must not tear down a live WebGL session); only speech I/O stops.
    this.interrupt();
    this.fallback.destroy();
  }
}

// ---------------------------------------------------------------------------
// Preparation — runs once per page load, started from App's first effect so
// the presenter initializes (and fillers prewarm) while the guest is still
// looking at the Begin overlay. Begin then only has to unlock audio.
// ---------------------------------------------------------------------------

let kitPromise: Promise<PerxonaKitAdapter | null> | null = null;

export function prepareKit(voice: VoiceEngine | null): Promise<PerxonaKitAdapter | null> {
  kitPromise ??= doPrepare(voice).catch((err) => {
    console.warn("[kit] unavailable, falling back:", err);
    announce("Unavailable");
    return null;
  });
  return kitPromise;
}

async function doPrepare(voice: VoiceEngine | null): Promise<PerxonaKitAdapter | null> {
  announce("Probing");
  const config = await fetchJson<KitConfig>("/api/michi/kit", 3000);
  if (!config.available || !config.presenterUrl || !config.target)
    throw new Error(config.reason ?? "Perxona not configured");
  await loadScript(config.presenterUrl);

  const el = document.createElement("sv-presenter") as PresenterEl;
  el.hidden = true;
  (document.getElementById("presenter-slot") ?? document.body).appendChild(el);

  try {
    const adapter = new PerxonaKitAdapter(el, voice);
    const { connect_token } = await fetchJson<{ connect_token: string }>(
      "/api/michi/connect-token",
      10000,
    );
    await withTimeout(el.initialize(connect_token, config.target), 30000, "presenter initialize");
    // initialize() resolves BEFORE the avatar's assets finish streaming; the
    // Begin button must not enable until the presenter can actually perform,
    // or the greeting falls to robotic browser TTS. Wait for Ready.
    if (!(await adapter.whenReady(90000))) {
      console.warn("[kit] presenter not Ready after 90s — continuing; speech degrades until it is");
    }
    return adapter;
  } catch (err) {
    el.remove();
    throw err;
  }
}
