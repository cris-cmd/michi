// Centralized per-turn latency instrumentation. Everything that matters for
// perceived latency marks a timestamp here; the HUD (default-on; ?debug=0 hides) and the
// console line read the derived numbers. Safe in Node (harness) — the window
// event dispatch is guarded, performance.now() exists in both runtimes.
//
// Lifecycle: marks before a turn commits (speech start, transcripts) land in
// a PENDING record; executeUserTurn adopts it via commitTurn(); presentation
// events land in the ACTIVE record; completeTurn() derives + publishes.

export interface TurnLatencyMetrics {
  speechStart?: number;
  speechEnd?: number;

  partialTranscriptFirst?: number;
  finalTranscript?: number;

  affectRequestStart?: number;
  affectComplete?: number;

  acknowledgementDecision?: number;
  acknowledgementAudioStart?: number;
  acknowledgementAudioEnd?: number;

  llmRequestStart?: number;
  llmFirstToken?: number;
  llmComplete?: number;

  ttsRequestStart?: number;
  ttsFirstAudio?: number;

  avatarPresentationStart?: number;
  avatarAudibleStart?: number;
  avatarPresentationEnd?: number;
}

export interface TurnLatencyReport {
  turnId: number;
  metrics: TurnLatencyMetrics;
  /** Derived durations in ms; only pairs whose marks both exist. */
  derived: Record<string, number>;
  /** Qualitative per-turn facts (ack clip, motion, affect read, STT
   *  confidence) — the HUD's "what did the runtime decide" half. */
  notes: Record<string, string>;
  interrupted: boolean;
}

type PreField = "speechStart" | "speechEnd" | "partialTranscriptFirst" | "finalTranscript";

const now = () => performance.now();

let pending: TurnLatencyMetrics = {};
let active: { id: number; m: TurnLatencyMetrics; notes: Record<string, string>; done: boolean } | null = null;
const reports: TurnLatencyReport[] = [];

/** Marks gathered while the user is (maybe) producing the next turn.
 *  First-wins for the *First/Start fields, last-wins for speechEnd. */
export function preMark(field: PreField): void {
  if (field === "speechEnd") {
    pending.speechEnd = now();
    return;
  }
  pending[field] ??= now();
}

/** Adopt the pending marks as turn `id` (from turnGate). An unfinished
 *  previous turn is finalized as interrupted first. */
export function commitTurn(id: number): void {
  if (active && !active.done) finalize(true);
  active = { id, m: pending, notes: {}, done: false };
  pending = {};
  active.m.finalTranscript ??= now();
}

/** Attach a qualitative fact to the active turn (ack clip, motion name,
 *  affect read, STT confidence). Last write wins per key. */
export function note(key: string, value: string): void {
  if (!active || active.done) return;
  active.notes[key] = value;
}

/** Mark into the active turn. First-wins so chunk 2's synth doesn't
 *  overwrite ttsFirstAudio etc. */
export function mark(field: keyof TurnLatencyMetrics): void {
  if (!active || active.done) return;
  active.m[field] ??= now();
}

/** Overwrite-mark for fields where the LAST event is the truth. */
export function markLast(field: "avatarPresentationEnd" | "acknowledgementAudioEnd"): void {
  if (!active || active.done) return;
  active.m[field] = now();
}

export function completeTurn(): void {
  if (active && !active.done) finalize(false);
}

export function turnInterrupted(): void {
  if (active && !active.done) finalize(true);
}

function finalize(interrupted: boolean): void {
  if (!active) return;
  active.done = true;
  const m = active.m;
  const d = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.round(b - a) : undefined);
  const ref = m.speechEnd ?? m.finalTranscript; // text mode has no speech marks
  const derived: Record<string, number> = {};
  const put = (k: string, v?: number) => {
    if (v !== undefined && v >= 0) derived[k] = v;
  };
  put("sttFinal", d(m.speechEnd, m.finalTranscript));
  put("affect", d(m.affectRequestStart, m.affectComplete));
  put("ackDecision", d(ref, m.acknowledgementDecision));
  put("ackAudible", d(ref, m.acknowledgementAudioStart));
  put("llmTtft", d(m.llmRequestStart, m.llmFirstToken));
  put("llmTotal", d(m.llmRequestStart, m.llmComplete));
  put("ttsFirstAudio", d(m.ttsRequestStart, m.ttsFirstAudio));
  put("speechEndToLlmFirstToken", d(ref, m.llmFirstToken));
  put("speechEndToFirstReplyAudio", d(ref, m.avatarAudibleStart));
  put("perceivedResponseDelay", d(ref, m.acknowledgementAudioStart ?? m.avatarAudibleStart));
  put("presentationTotal", d(m.avatarAudibleStart, m.avatarPresentationEnd));

  const report: TurnLatencyReport = {
    turnId: active.id,
    metrics: m,
    derived,
    notes: active.notes,
    interrupted,
  };
  reports.push(report);
  if (reports.length > 20) reports.shift();

  const line = Object.entries(derived)
    .map(([k, v]) => `${k}=${v}ms`)
    .join(" ");
  console.info(`[latency] turn ${report.turnId}${interrupted ? " (interrupted)" : ""}: ${line}`);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("michi:turn-latency", { detail: report }));
  }
}

export function latencyReports(): readonly TurnLatencyReport[] {
  return reports;
}
