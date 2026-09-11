// Shared contracts for the fast listener loop. The listener does not
// depend on the planning model; everything here is deterministic and runs in
// microseconds on the final (or partial) transcript.

/** What kind of conversational move the user just made. */
export type ListenerIntent =
  | "statement"
  | "question"
  | "confirmation"
  | "correction"
  | "revision"
  | "constraint"
  | "positive"
  | "negative"
  | "uncertain";

/** The listener's read of the user's emotional register. One shared scale —
 *  ack selection, presenter emotion options, and UI all map from this
 *  (see ../emotion.ts) so subsystems can't invent emotions independently. */
export type ListenerEmotion =
  | "neutral"
  | "warm"
  | "happy"
  | "curious"
  | "concerned"
  | "compassionate"
  | "apologetic"
  | "excited";

/** Which shelf of the prerecorded acknowledgement library to pick from.
 *  null = deliberately say nothing (humans don't ack every sentence). */
export type AckCategory =
  | "neutral"
  | "processing"
  | "positive"
  | "celebration"
  | "concerned"
  | "compassion"
  | "correction"
  | "revision"
  | "confirmation"
  | "curious"
  /** Second reference to a loss/celebration we ALREADY acknowledged aloud:
   *  hold the floor without re-condoling or re-congratulating. */
  | "continuity";

/** How the acknowledgement is delivered: a spoken clip, a gesture only
 *  ("I heard you" without words — minor corrections don't need speech), or
 *  nothing at all. */
export type AckMode = "spoken" | "nonverbal" | "none";

export interface ListenerDecision {
  intent: ListenerIntent;
  emotion: ListenerEmotion;
  /** Ack shelf to play from, or null for silence. */
  ackCategory: AckCategory | null;
  /** Delivery mode — "nonverbal" fires the beat motion without a clip. */
  mode: AckMode;
  /** Conversational beat to gesture on at ack time — the avatar layer maps
   *  it to a rotating motion variant (avatar/motionSelector.ts). */
  motion: "correction" | "compassion" | "celebration" | "processing" | null;
  /** 0..1 — how confident the rule match is. Low confidence → neutral ack. */
  confidence: number;
}

/** The interface the deterministic policy implements today and a small local
 *  classifier could implement later (ONNX/WebGPU) without touching callers. */
export interface ListenerPolicy {
  /** Classify a final transcript and decide the immediate reaction. */
  decide(text: string, lang: string): ListenerDecision;
  /** Feedback so the policy can breathe (skip acks after consecutive ones). */
  noteAckPlayed(played: boolean): void;
}

/** Conversation turn states for the listener state machine. */
export type ConversationTurnState =
  | "IDLE"
  | "LISTENING"
  | "USER_ENDING"
  | "ACKNOWLEDGING"
  | "THINKING"
  | "PRESENTING"
  | "INTERRUPTED";
