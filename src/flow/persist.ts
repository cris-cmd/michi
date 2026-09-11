// Local persistence — versioned namespace `michi:v1:app`, localStorage only.
// The persistent object is the TRIP (plan, party, budget, saved, protected
// windows, dates) plus the conversation thread state and recent chats.
// Never persisted: any key/token/credential, audio buffers, presenter or
// recognition objects, AbortControllers, in-flight state, retrieval caches.
// Money is NOT persisted as totals — budget is recomputed from the plan on
// hydration (deterministic code owns truth, even across reloads).

import type { AgentResponse } from "../agent/schema";
import type { TripPlan } from "../plan/types";
import type { ProtectedWindow } from "../plan/engine";
import type { ChatTurn } from "../agent/client";
import type { TranscriptEntry, Booking, TurnRecord, ChatMeta } from "./store";

export const PERSIST_KEY = "michi:v1:app";

export type PersistedV1 = {
  version: 1;
  // conversation thread
  stage: string;
  transcript: TranscriptEntry[];
  history: ChatTurn[];
  constraints: AgentResponse["constraints"];
  candidates: string[];
  excluded: { id: string; reason: string }[];
  selection?: string;
  lastTurn: TurnRecord | null;
  showTrace: boolean;
  // trip
  party: { adults: number; children?: number; infants?: number };
  plan: TripPlan;
  budgetMode: "flexible" | "firm";
  selectedDate: string;
  tripStart: string;
  tripEnd: string;
  protectedWindows: ProtectedWindow[];
  savedIds: string[];
  booking?: Booking;
  // threads
  chats: ChatMeta[];
  activeChatId: string | null;
};

type Snapshotable = Omit<PersistedV1, "version">;

export function snapshotState(s: Snapshotable): PersistedV1 {
  return {
    version: 1,
    stage: s.stage,
    transcript: s.transcript,
    history: s.history,
    constraints: s.constraints,
    candidates: s.candidates,
    excluded: s.excluded,
    selection: s.selection,
    lastTurn: s.lastTurn,
    showTrace: s.showTrace,
    party: s.party,
    plan: s.plan,
    budgetMode: s.budgetMode,
    selectedDate: s.selectedDate,
    tripStart: s.tripStart,
    tripEnd: s.tripEnd,
    protectedWindows: s.protectedWindows,
    savedIds: s.savedIds,
    booking: s.booking,
    chats: s.chats.slice(0, 10),
    activeChatId: s.activeChatId,
  };
}

/** Parse and validate; malformed input returns null. */
export function restoreState(raw: string | null): PersistedV1 | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PersistedV1;
    if (p.version !== 1) return null;
    if (!p.plan || !Array.isArray(p.plan.days) || typeof p.plan.totalBudgetJpy !== "number")
      return null;
    if (!p.party || typeof p.party.adults !== "number") return null;
    for (const list of [p.transcript, p.history, p.candidates, p.excluded, p.savedIds, p.chats])
      if (!Array.isArray(list)) return null;
    if (typeof p.stage !== "string" || typeof p.selectedDate !== "string") return null;
    return p;
  } catch {
    if (typeof console !== "undefined") console.warn("[persist] malformed michi:v1 state — starting fresh");
    return null;
  }
}

export function loadPersisted(): PersistedV1 | null {
  try {
    return restoreState(localStorage.getItem(PERSIST_KEY));
  } catch {
    return null; // localStorage is unavailable in tests and Node
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function persistSoon(get: () => Snapshotable): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(snapshotState(get())));
    } catch {
      // storage full / private mode — persistence is best-effort
    }
  }, 350);
}
