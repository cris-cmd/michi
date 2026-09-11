// Server-side ONNX inference for clause-level text emotion and optional vocal
// tone. Reaction policy remains in conversation/listener/affect.

import { env, pipeline } from "@huggingface/transformers";
import { segmentUtterance } from "../conversation/listener/affect/segment";
import { readFromClassified } from "../conversation/listener/affect/fusion";
import type { AffectRead, AudioAffect } from "../conversation/listener/affect/types";

const TEXT_MODEL = "SamLowe/roberta-base-go_emotions-onnx";
const TEXT_MODEL_REVISION = "90ee0c1c4796d370e68968687b8ba51fc11224f4";
const AUDIO_MODEL_DIR = "models/affect/michi-audio-affect";

// Normalize labels from different audio model vocabularies.
const AUDIO_LABEL_CANON: Record<string, string> = {
  sad: "sad", sadness: "sad",
  hap: "hap", happy: "hap", happiness: "hap", joy: "hap",
  ang: "ang", angry: "ang", anger: "ang",
  neu: "neu", neutral: "neu", calm: "neu",
  dis: "dis", disgust: "dis",
  fea: "fea", fear: "fea", fearful: "fea",
  sur: "sur", surprise: "sur", surprised: "sur",
};
const MAX_AUDIO_SECONDS = 12; // tone is stationary enough — cap CPU cost
const SAMPLE_RATE = 16000;

// Downloads persist outside node_modules (npm reinstall must not re-pull
// 125 MB); the audio model is loaded from the local export directory.
env.cacheDir = "models/.cache";
env.allowLocalModels = true;

type TextPipe = (texts: string[], opts: { top_k: number }) => Promise<{ label: string; score: number }[][]>;
type AudioPipe = (audio: Float32Array, opts: { top_k: number | null }) => Promise<{ label: string; score: number }[]>;

// Pipelines live on globalThis: Vite's ssrLoadModule re-evaluates this
// module on dev edits, and a 100+ MB model must not reload for that.
type Cache = { text?: Promise<TextPipe>; audio?: Promise<AudioPipe | null>; reads: Map<string, AffectRead> };
const g = globalThis as { __michiAffect?: Cache };
const cache: Cache = (g.__michiAffect ??= { reads: new Map() });

function textPipe(): Promise<TextPipe> {
  if (!cache.text) {
    cache.text = pipeline("text-classification", TEXT_MODEL, {
      dtype: "q8",
      revision: TEXT_MODEL_REVISION,
    }).then(
      (p) => p as unknown as TextPipe,
    );
  }
  return cache.text;
}

function audioPipe(): Promise<AudioPipe | null> {
  if (!cache.audio) {
    // The audio model is optional: without a local download or export, affect
    // degrades to text-only inference.
    cache.audio = pipeline("audio-classification", AUDIO_MODEL_DIR, { dtype: "q8" })
      .then((p) => p as unknown as AudioPipe)
      .catch((err: unknown) => {
        console.warn("[affect] audio model unavailable (text-only):", String(err).slice(0, 200));
        return null;
      });
  }
  return cache.audio;
}

/** Kick both model loads without waiting (GET /api/michi/affect probe —
 *  the browser calls it at boot so the first utterance hits warm models). */
export function prewarmAffect(): { available: true } {
  void textPipe().catch((err) => console.warn("[affect] text model load failed:", err));
  void audioPipe();
  return { available: true };
}

async function analyzeText(text: string): Promise<{ classified: { text: string; emotions: Record<string, number> }[]; ms: number }> {
  const t0 = Date.now();
  const segments = segmentUtterance(text);
  if (segments.length === 0) return { classified: [], ms: 0 };
  const pipe = await textPipe();
  const results = await pipe(segments, { top_k: 8 });
  const classified = segments.map((seg, i) => ({
    text: seg,
    emotions: Object.fromEntries((results[i] ?? []).map((r) => [r.label, r.score])),
  }));
  return { classified, ms: Date.now() - t0 };
}

async function analyzeAudio(pcm: Float32Array): Promise<{ audio: AudioAffect | undefined; ms: number }> {
  const t0 = Date.now();
  const pipe = await audioPipe();
  if (!pipe || pcm.length < SAMPLE_RATE / 4) return { audio: undefined, ms: 0 }; // <250ms of audio says nothing
  const clip = pcm.length > MAX_AUDIO_SECONDS * SAMPLE_RATE ? pcm.subarray(pcm.length - MAX_AUDIO_SECONDS * SAMPLE_RATE) : pcm;
  let sumSq = 0;
  for (let i = 0; i < clip.length; i++) sumSq += clip[i] * clip[i];
  const energy = Math.sqrt(sumSq / clip.length);
  const results = await pipe(clip, { top_k: null });
  const labels: Record<string, number> = {};
  for (const r of results) {
    const canon = AUDIO_LABEL_CANON[r.label.toLowerCase()] ?? r.label.toLowerCase();
    labels[canon] = Math.max(labels[canon] ?? 0, r.score);
  }
  const confidence = Math.max(0, ...results.map((r) => r.score));
  return { audio: { labels, energy, confidence }, ms: Date.now() - t0 };
}

/**
 * POST /api/michi/affect — { text, audioB64? } → AffectRead.
 * `audioB64` is little-endian int16 mono PCM at 16 kHz (the browser capture
 * module downsamples; ~320 KB for a 10 s utterance). Partial transcripts
 * (no audio) prewarm the LRU so the final call is mostly cache-warm.
 */
export async function handleAffect(body: unknown): Promise<{ status: number; json: unknown }> {
  const { text, audioB64 } = (body ?? {}) as { text?: unknown; audioB64?: unknown };
  if (typeof text !== "string" || !text.trim()) {
    return { status: 400, json: { error: "body must be { text, audioB64? }" } };
  }

  try {
    const key = text.trim();
    let textResult = cache.reads.get(key) ?? null;

    let pcm: Float32Array | null = null;
    if (typeof audioB64 === "string" && audioB64.length > 0) {
      const buf = Buffer.from(audioB64, "base64");
      const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      pcm = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) pcm[i] = int16[i] / 32768;
    }

    const [textOut, audioOut] = await Promise.all([
      textResult ? null : analyzeText(key),
      pcm ? analyzeAudio(pcm) : Promise.resolve({ audio: undefined, ms: 0 }),
    ]);

    const classified = textOut
      ? textOut.classified
      : textResult!.segments.map((s) => ({ text: s.text, emotions: s.emotions }));
    const read = readFromClassified(classified, audioOut.audio, {
      text: textOut?.ms ?? 0,
      audio: audioOut.ms || undefined,
    });

    // LRU-ish: cache the text-only read for partial→final reuse.
    if (!audioOut.audio) {
      cache.reads.set(key, read);
      if (cache.reads.size > 60) cache.reads.delete(cache.reads.keys().next().value!);
    }
    return { status: 200, json: read };
  } catch (err) {
    return { status: 502, json: { error: String(err) } };
  }
}
