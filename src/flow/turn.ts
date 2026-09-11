// The listener and model paths begin together. Acknowledgements can play
// immediately, while validated model state is committed only by the current
// turn ticket.

import { agentTurn as liveAgentTurn, type ChatTurn, type TurnStreamCallbacks } from "../agent/client";
import type { AgentResponse } from "../agent/schema";
import type { AvatarAdapter, Tone, UtteranceHandle } from "../avatar/adapter";
import { AckEchoGuard, stripAckEcho } from "../conversation/ackEcho";
import * as metrics from "../conversation/metrics";
import { listenerPolicy, toState, conversationState } from "../conversation/listener";
import { finalRead } from "../conversation/listener/affectClient";
import {
  applyEventContinuity,
  capForUncertainTranscript,
  fuseListenerDecision,
  listenerContextOf,
} from "../conversation/listener/affect/fusion";
import { lossFingerprint } from "../conversation/listener/affect/salience";
import type { AffectRead } from "../conversation/listener/affect/types";
import { PhraseAssembler } from "../conversation/phrases";
import { assessTranscript } from "../conversation/transcript";
import { SPEECH_LANG } from "../i18n";
import { utteranceCapture } from "../voice/capture";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { beginTurn } from "./turnGate";

/** AffectRead task tone → the avatar Tone used until the model's own meta
 *  tone streams in (compassionate ack, gently-positive continuation). */
const TASK_TONE_TO_TONE: Record<AffectRead["taskTone"], Tone | undefined> = {
  neutral: undefined,
  warm: "warm",
  gently_positive: "warm",
  calm: "warm",
  upbeat: "delighted",
};

export type TurnAgent = (
  history: ChatTurn[],
  opts?: {
    signal?: AbortSignal;
    stream?: TurnStreamCallbacks;
    listener?: import("../agent/client").ListenerContext;
    transcript?: import("../agent/client").TranscriptHint;
    state?: string;
  },
) => Promise<AgentResponse>;

export type TurnIO = {
  adapter: Pick<AvatarAdapter, "say" | "caps" | "playAcknowledgement" | "beginUtterance">;
  openMic: (lang?: string) => void;
  closeMic: () => void;
  /** Releases the UI's synchronous busy guard. */
  releaseBusy: () => void;
  /** Mirrors utterance speech into App's Speaking pill (streamed path —
   *  the non-streamed path goes through the delegate's say()). */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Test seam (harness/race.ts); defaults to the real client. */
  agent?: TurnAgent;
};

export type TurnOutcome = "committed" | "stale" | "error";

export async function executeUserTurn(
  text: string,
  io: TurnIO,
  meta: { sttConfidence?: number } = {},
): Promise<TurnOutcome> {
  const { adapter, openMic, closeMic, releaseBusy } = io;
  const agent = io.agent ?? liveAgentTurn;
  const ticket = beginTurn();
  metrics.commitTurn(ticket.id);
  if (conversationState() === "PRESENTING") toState("INTERRUPTED");

  // The SETTINGS pin is the one language authority for mic + speech. The
  // model's declared language never drives them — one misheard utterance
  // used to flip STT to ja-JP and lock the whole conversation there.
  const speechLang = SPEECH_LANG[useSettings.getState().language];

  const s = useStore.getState();
  s.setBusy(true);
  closeMic();
  s.addGuestTurn(text.trim());

  // STT output is a noisy observation, not truth ("Israel at the budget").
  // An uncertain hearing caps the ack at neutral-hold AND rides to the
  // model as a confirm-before-committing note (conversation/transcript.ts).
  const transcript = assessTranscript(text, meta.sttConfidence);

  // Affect inference may refine the rule-based acknowledgement, but it has a
  // fixed latency budget and cannot mutate planning state.
  const ruleDecision = listenerPolicy.decide(text, speechLang);
  metrics.mark("affectRequestStart");
  const affect = await finalRead(text, utteranceCapture.takeRecentB64(8));
  metrics.mark("affectComplete");
  if (!ticket.isCurrent()) return "stale"; // superseded during the affect wait
  const known = {
    loss: s.knownEvents.some((e) => e.type === "loss"),
    celebration: s.knownEvents.some((e) => e.type === "celebration"),
    // Fingerprints let continuity tell a NEW loss from a callback to the
    // one we already condoled — without them it silences both.
    lossFingerprints: s.knownEvents.filter((e) => e.type === "loss").map((e) => e.fingerprint),
  };
  const decision = capForUncertainTranscript(
    applyEventContinuity(fuseListenerDecision(ruleDecision, affect), known, text),
    transcript.uncertain,
  );
  metrics.mark("acknowledgementDecision");
  metrics.note("stt", `conf ${transcript.confidence.toFixed(2)}${transcript.uncertain ? " UNCERTAIN" : ""}`);
  metrics.note(
    "affect",
    affect ? `${affect.socialResponse} ${affect.salience.toFixed(2)} → ${affect.taskTone}` : "none (rules)",
  );
  const ack = adapter.playAcknowledgement?.(decision, speechLang) ?? null;
  if (ack) metrics.note("ack", `"${ack.text}" (${decision.ackCategory})`);
  else if (decision.mode === "nonverbal") metrics.note("ack", `nonverbal (${decision.motion ?? "gesture"})`);
  else metrics.note("ack", decision.ackCategory ? `${decision.ackCategory} shelf empty` : "deliberate silence");
  listenerPolicy.noteAckPlayed(ack !== null);
  // Curate the tiny event memory: a loss/celebration we just acknowledged
  // out loud becomes KNOWN — later references get continuity, not rediscovery.
  if (ack && decision.ackCategory === "compassion") {
    useStore
      .getState()
      .addKnownEvent("loss", text.trim().slice(0, 120), lossFingerprint(text));
  } else if (ack && decision.ackCategory === "celebration") {
    useStore.getState().addKnownEvent("celebration", text.trim().slice(0, 120));
  }
  toState(ack ? "ACKNOWLEDGING" : "THINKING");
  // The spoken ack is part of the conversation, not a sound effect: it goes
  // into the transcript and the model history (the server turns the trailing
  // ack into a continue-from-here note — agent/ackContext.ts), and the echo
  // guard below keeps the model from re-saying it.
  if (ack) s.addSpokenAck(ack.text);
  const echoGuard = new AckEchoGuard(ack?.text ?? null);

  // Barge-in must work through the THINKING gap too, not just while speech
  // plays: with a barge-in-capable adapter the mic reopens the moment the
  // ack fires (openMic no-ops while the user has muted the mic — the mute
  // toggle in App is the one venue-noise control).
  let micOpened = false;
  if (adapter.caps.bargeIn) {
    openMic(speechLang);
    micOpened = true;
  }

  // ── MODEL TURN ────────────────────────────────────────────────────────
  // Streamed: phrases begin speaking as soon as the model produces them.
  // Speech/mic language is the settings pin (speechLang) — the streamed meta
  // only contributes TONE; its language field is deliberately ignored.
  // Object wrapper: `utterance` is assigned inside stream callbacks, which
  // TS control-flow can't see — property reads re-widen after calls.
  const speech: { utterance: UtteranceHandle | null } = { utterance: null };
  let busyReleased = false;
  // Until the model's own meta tone streams in, the listener's read colors
  // the reply delivery (compassionate ack → warm continuation).
  let toneGuess: Tone | undefined = affect ? TASK_TONE_TO_TONE[affect.taskTone] : undefined;
  const assembler = new PhraseAssembler();

  const releaseForSpeech = () => {
    if (busyReleased) return;
    busyReleased = true;
    useStore.getState().setBusy(false);
    releaseBusy();
  };

  const speakPhrase = (raw: string) => {
    if (!ticket.isCurrent() || !adapter.beginUtterance) return;
    // Remove a leading phrase that merely repeats the acknowledgement.
    // ("Got it." → "Got it, so…" must not play twice).
    const phrase = echoGuard.filter(raw);
    if (!phrase.trim()) return;
    if (!speech.utterance) {
      speech.utterance = adapter.beginUtterance(speechLang, toneGuess);
      io.onSpeakingChange?.(true);
      toState("PRESENTING");
      // Speech is starting: busy drops so a new turn can begin (the mic is
      // already open on barge-in adapters — since ack time).
      releaseForSpeech();
      if (adapter.caps.bargeIn && !micOpened) {
        openMic(speechLang);
        micOpened = true;
      }
    }
    speech.utterance.speak(phrase);
  };

  const stream: TurnStreamCallbacks = {
    onMeta: (streamed) => {
      if (!ticket.isCurrent()) return;
      metrics.mark("llmFirstToken");
      if (streamed.tone) toneGuess = streamed.tone;
      // streamed.language intentionally unused — settings pin only.
    },
    onReplyDelta: (delta) => {
      if (!ticket.isCurrent()) return;
      metrics.mark("llmFirstToken");
      for (const phrase of assembler.push(delta)) speakPhrase(phrase);
    },
  };

  // Current-truth summary (§ContextBuilder): the model gets the DETERMINISTIC
  // present state — current outing constraints, party (+confirmation status),
  // known emotional context — instead of reverse-engineering 30 historical
  // turns. Built from store state BEFORE this turn's response lands.
  const st = useStore.getState();
  const partyBits = [
    `${st.party.adults} adults`,
    st.party.children ? `${st.party.children} children` : null,
    st.party.infants ? `${st.party.infants} infants` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const eventBits = st.knownEvents
    .map((e) =>
      e.type === "loss"
        ? `the guest told you about a loss earlier ("${e.summary}") and you already expressed sympathy`
        : `the guest shared good news earlier ("${e.summary}") and you already congratulated them`,
    )
    .join("; ");
  const stateNote = [
    `planning outing #${st.outingId}; active constraints ${JSON.stringify(st.constraints)}`,
    `party: ${partyBits}${st.partyExplicit ? "" : " (NOT explicitly stated for this outing — confirm the count before booking)"}`,
    eventBits
      ? `known emotional context: ${eventBits} — never react as if hearing it for the first time; acknowledge continuity naturally when it comes up`
      : "",
  ]
    .filter(Boolean)
    .join(". ");
  metrics.note("outing", `#${st.outingId}${st.partyExplicit ? "" : " (party unconfirmed)"}`);

  try {
    metrics.mark("llmRequestStart");
    const raw = await agent(useStore.getState().history, {
      signal: ticket.signal,
      stream,
      state: stateNote,
      // Voice is the one channel the model cannot read from the transcript; the
      // rest of the listener context shapes the continuation's feel.
      listener: listenerContextOf(affect) ?? undefined,
      // Uncertain hearing → the model must confirm critical values instead
      // of committing them (enforced by the runtime guard in agent/core.ts).
      transcript: transcript.uncertain
        ? { confidence: transcript.confidence, uncertain: true }
        : undefined,
    });
    metrics.mark("llmComplete");
    // The transcript/history version of the reply gets the same echo
    // stripping the spoken phrases got — what's stored matches what played.
    const response: AgentResponse = ack
      ? { ...raw, reply: stripAckEcho(raw.reply, ack.text) }
      : raw;
    if (!ticket.isCurrent()) {
      // A newer turn began while this one was in flight. Nothing commits:
      // no store update, no stage advance, no further audio. The newer turn
      // owns busy/mic state now — touching store busy here would stomp it.
      speech.utterance?.cancel();
      return "stale";
    }
    useStore.getState().applyAgentResponse(response);
    releaseForSpeech();
    const micLang = response.stage !== "done" ? speechLang : null;

    if (speech.utterance) {
      // Streamed path: flush the tail, wait for playback to drain.
      const tail = assembler.flush();
      if (tail) speech.utterance.speak(tail);
      if (adapter.caps.bargeIn && micLang && !micOpened) openMic(micLang);
      await speech.utterance.end();
      io.onSpeakingChange?.(false);
    } else {
      // Non-streamed fallback (no beginUtterance support, or the model
      // produced no extractable deltas): the original whole-reply path.
      if (adapter.caps.bargeIn && micLang) {
        openMic(micLang);
        micOpened = true;
      }
      toState("PRESENTING");
      await adapter.say(response.reply, response.tone, speechLang, response.motion);
    }

    if (!ticket.isCurrent()) {
      metrics.completeTurn();
      return "committed"; // spoke, but a newer turn owns the mic now
    }
    if (!adapter.caps.bargeIn && micLang) openMic(micLang);
    toState(micLang ? "LISTENING" : "IDLE");
    metrics.completeTurn();
    return "committed";
  } catch (err) {
    speech.utterance?.cancel();
    io.onSpeakingChange?.(false);
    if (!ticket.isCurrent()) return "stale"; // aborted by a newer turn — swallow silently
    useStore.getState().setBusy(false);
    releaseBusy();
    metrics.completeTurn();
    const recovery = "Let me try that again — could you tell me the region first?";
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[turn] agent error:", msg);
    // Config/billing failures are NOT transient — show the banner instead of
    // looping the spoken recovery line ("is the API down?" confusion).
    if (msg.includes("API_KEY") || /credit|billing|quota|insufficient/i.test(msg)) {
      useStore.getState().setError(msg);
      toState("IDLE");
    } else {
      useStore.getState().addAvatarLine(recovery);
      await adapter.say(recovery, "apologetic", speechLang);
      openMic(speechLang);
      toState("LISTENING");
    }
    return "error";
  }
}
