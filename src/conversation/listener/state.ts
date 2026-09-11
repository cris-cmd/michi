// Tiny conversation state machine — makes turn behavior observable and
// testable without another framework. Transitions are asserted (invalid ones
// are coerced with a debug warning, never thrown: a demo must not die on a
// state hiccup). Subscribers: the debug HUD and Stage status text.

import type { ConversationTurnState } from "./types";

const ALLOWED: Record<ConversationTurnState, ConversationTurnState[]> = {
  IDLE: ["LISTENING", "THINKING", "ACKNOWLEDGING"], // text mode jumps straight to thinking
  LISTENING: ["USER_ENDING", "IDLE", "ACKNOWLEDGING", "THINKING", "INTERRUPTED"],
  USER_ENDING: ["ACKNOWLEDGING", "THINKING", "LISTENING", "IDLE"],
  ACKNOWLEDGING: ["THINKING", "PRESENTING", "INTERRUPTED", "IDLE"],
  THINKING: ["PRESENTING", "INTERRUPTED", "IDLE", "ACKNOWLEDGING"],
  PRESENTING: ["IDLE", "LISTENING", "INTERRUPTED", "THINKING"],
  INTERRUPTED: ["LISTENING", "THINKING", "IDLE", "ACKNOWLEDGING"],
};

type Listener = (state: ConversationTurnState, prev: ConversationTurnState) => void;

let current: ConversationTurnState = "IDLE";
const listeners = new Set<Listener>();

export function conversationState(): ConversationTurnState {
  return current;
}

export function toState(next: ConversationTurnState): void {
  if (next === current) return;
  if (!ALLOWED[current].includes(next)) {
    console.debug(`[listener] unusual transition ${current} → ${next}`);
  }
  const prev = current;
  current = next;
  for (const l of [...listeners]) l(next, prev);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("michi:conversation-state", { detail: next }));
  }
}

export function onStateChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
