// Same-origin API handlers. This module runs in Node, never in the browser.
//
//   POST /api/michi/turn   { history }            → AgentResponse | {error}
//   POST /api/michi/voice  { text, lang, tone? }  → audio/mpeg    | {error}
//   GET  /api/michi/voice                          → { available }
//

import { agentTurn } from "../agent/core";
import { ReplyStreamExtractor } from "../agent/streamExtract";
import type { ChatTurn, ListenerContext, TranscriptHint } from "../agent/client";
import { speakable } from "../voice/speakable";
import type { Lang, Tone } from "../voice/types";
import { consumeTurnBudget } from "./gate";

const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const MODEL_ID = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "mp3_44100_128";
// ElevenLabs' premade Rachel voice; override it with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// Flash supports explicit language enforcement (ISO 639-1).
const LANGUAGE_CODE: Record<Lang, string> = { en: "en", ja: "ja", zh: "zh" };
const LANGS = new Set(Object.keys(LANGUAGE_CODE));

// Subtle tone shaping only — the voice must stay recognizably one person.
const TONE_STABILITY: Partial<Record<Tone, number>> = {
  apologetic: 0.65,
  thinking: 0.6,
  delighted: 0.35,
};

// Same 8s budget the browser engine has always had.
const SYNTH_TIMEOUT_MS = 8000;

type HandlerResult = {
  status: number;
  json?: unknown;
  /** When set, the middleware responds audio/mpeg with these bytes. */
  audio?: ArrayBuffer;
};

function elevenKey(): string | undefined {
  return ENV.ELEVEN_LABS_API_KEY;
}

const missingProviderKey = (message: string) => message.includes("API_KEY is not set");

/** GET probe so createVoiceEngine() can preserve its construction-time choice. */
export function voiceAvailable(): boolean {
  return Boolean(elevenKey());
}

function isChatTurn(t: unknown): t is ChatTurn {
  const r = t as Record<string, unknown> | null;
  return (
    !!r &&
    (r.role === "user" || r.role === "assistant") &&
    typeof r.content === "string"
  );
}

const REPLY_LANGS = new Set(["en", "ja", "zh-TW"]);

const SOCIAL_RESPONSES = new Set(["none", "warmth", "compassion", "celebration", "concern"]);
const TASK_TONES = new Set(["neutral", "warm", "gently_positive", "upbeat", "calm"]);

function validTranscript(t: unknown): t is TranscriptHint {
  const r = t as Record<string, unknown> | null;
  return !!r && r.uncertain === true && typeof r.confidence === "number";
}

function validListener(l: unknown): l is ListenerContext {
  const r = l as Record<string, unknown> | null;
  return (
    !!r &&
    SOCIAL_RESPONSES.has(r.socialResponse as string) &&
    TASK_TONES.has(r.taskTone as string) &&
    typeof r.voiceSubdued === "boolean"
  );
}

function validPromptContext(pc: unknown): pc is import("../agent/prompt").PromptContext {
  const p = pc as { context?: { location?: unknown; nowTime?: unknown }; fixedItems?: unknown } | null;
  return (
    !!p &&
    typeof p.context?.location === "string" &&
    typeof p.context?.nowTime === "string" &&
    Array.isArray(p.fixedItems)
  );
}

export async function handleTurn(body: unknown, signal?: AbortSignal): Promise<HandlerResult> {
  const { history, language, promptContext, listener, transcript, state } = (body ?? {}) as {
    history?: unknown;
    language?: unknown;
    promptContext?: unknown;
    listener?: unknown;
    transcript?: unknown;
    state?: unknown;
  };
  if (!Array.isArray(history) || history.length === 0 || !history.every(isChatTurn)) {
    return { status: 400, json: { error: "body must be { history: {role, content}[], language?, promptContext? }" } };
  }
  const budget = consumeTurnBudget();
  if (!budget.ok) return { status: budget.status, json: { error: budget.error } };
  const replyLang =
    typeof language === "string" && REPLY_LANGS.has(language)
      ? (language as "en" | "ja" | "zh-TW")
      : undefined;
  try {
    // agentTurn = model call + runtime guard + one-shot retry, unchanged.
    return {
      status: 200,
      json: await agentTurn(history, {
        signal,
        language: replyLang,
        promptContext: validPromptContext(promptContext) ? promptContext : undefined,
        listener: validListener(listener) ? listener : undefined,
        transcript: validTranscript(transcript) ? transcript : undefined,
        state: typeof state === "string" ? state.slice(0, 900) : undefined,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: missingProviderKey(msg) ? 503 : 502, json: { error: msg } };
  }
}

/** One NDJSON line of the streaming turn response (POST /turn {stream:true}).
 *  meta → as soon as language/tone are known · reply → speakable text delta ·
 *  final → the fully validated AgentResponse · error → terminal failure. */
export type TurnStreamEvent =
  | { type: "meta"; language?: string; tone?: string }
  | { type: "reply"; text: string }
  | { type: "final"; response: unknown }
  | { type: "error"; error: string; status: number };

/**
 * Streaming variant of handleTurn: emits reply text as the provider generates it
 * (time-to-first-phrase instead of time-to-full-JSON), then the validated
 * response. State is ONLY ever applied from the final event — partial prose
 * can never mutate deterministic app state. The internal validation retry is
 * non-streamed (agentTurn), so a retry can't speak a second reply.
 */
export async function handleTurnStream(
  body: unknown,
  signal: AbortSignal | undefined,
  emit: (ev: TurnStreamEvent) => void,
): Promise<void> {
  const { history, language, promptContext, listener, transcript, state } = (body ?? {}) as {
    history?: unknown;
    language?: unknown;
    promptContext?: unknown;
    listener?: unknown;
    transcript?: unknown;
    state?: unknown;
  };
  if (!Array.isArray(history) || history.length === 0 || !history.every(isChatTurn)) {
    emit({ type: "error", error: "body must be { history: {role, content}[], … }", status: 400 });
    return;
  }
  const budget = consumeTurnBudget();
  if (!budget.ok) {
    emit({ type: "error", error: budget.error, status: budget.status });
    return;
  }
  const replyLang =
    typeof language === "string" && REPLY_LANGS.has(language)
      ? (language as "en" | "ja" | "zh-TW")
      : undefined;

  const extractor = new ReplyStreamExtractor();
  try {
    const response = await agentTurn(history, {
      signal,
      language: replyLang,
      promptContext: validPromptContext(promptContext) ? promptContext : undefined,
      listener: validListener(listener) ? listener : undefined,
      transcript: validTranscript(transcript) ? transcript : undefined,
      state: typeof state === "string" ? state.slice(0, 900) : undefined,
      onRawDelta: (delta) => {
        const ev = extractor.push(delta);
        if (ev.language || ev.tone) emit({ type: "meta", language: ev.language, tone: ev.tone });
        if (ev.replyDelta) emit({ type: "reply", text: ev.replyDelta });
      },
    });
    emit({ type: "final", response });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "error", error: msg, status: missingProviderKey(msg) ? 503 : 502 });
  }
}

export async function handleVoice(body: unknown, signal?: AbortSignal): Promise<HandlerResult> {
  const { text, lang, tone, previousText } = (body ?? {}) as {
    text?: unknown;
    lang?: unknown;
    tone?: unknown;
    previousText?: unknown;
  };
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 3000 ||
    typeof lang !== "string" ||
    !LANGS.has(lang)
  ) {
    return { status: 400, json: { error: "body must be { text (1–3000 characters), lang: en|ja|zh, tone? }" } };
  }
  // What reaches the voice must be SAYABLE (¥/ISO dates/24h → words) — the
  // transcript keeps the original text; only speech is shaped here.
  const spoken = speakable(text, lang as Lang);
  // Request stitching: the prior phrase gives ElevenLabs prosodic context so
  // per-phrase synthesis doesn't reset intonation at every boundary.
  const previous =
    typeof previousText === "string" && previousText.trim()
      ? speakable(previousText, lang as Lang).slice(-300)
      : undefined;
  const apiKey = elevenKey();
  if (!apiKey) return { status: 503, json: { error: "ELEVEN_LABS_API_KEY is not set (server-side)" } };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort(); // caller (browser) gave up or was superseded
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ENV.ELEVENLABS_VOICE_ID ?? DEFAULT_VOICE_ID}/stream?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          text: spoken,
          ...(previous ? { previous_text: previous } : {}),
          model_id: MODEL_ID,
          language_code: LANGUAGE_CODE[lang as Lang],
          voice_settings: {
            stability: TONE_STABILITY[tone as Tone] ?? 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { status: 502, json: { error: `ElevenLabs ${res.status} ${detail}`.trim() } };
    }
    return { status: 200, audio: await res.arrayBuffer() };
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    return {
      status: aborted ? 504 : 502,
      json: { error: aborted ? "voice synthesis timed out or was aborted" : String(err) },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
