import { create } from "zustand";
import { isKnownLoss } from "../conversation/listener/affect/salience";
import type { AgentResponse, Tone } from "../agent/schema";
import type { ChatTurn } from "../agent/client";
import type { PromptContext } from "../agent/prompt";
import type { TripContext } from "../data/activity";
import { activities, activityById, partyCostJpy } from "../data/activities";
import { inHorizon } from "../data/availability";
import { retrieve, type RetrievalResult } from "../data/retrieval";
import { DEMO_CONTEXT, DEMO_TRIP_END, seedPlan } from "../data/demoContext";
import { emptyPlan, liveContext, liveTripEnd } from "../data/liveContext";
import {
  computeBudget,
  moveItem,
  placeCandidates,
  promoteToReserved,
  toMin,
  toHHMM,
  withDay,
  withProposals,
  withProposalsExclusive,
  type MoveResult,
  type ProtectedWindow,
} from "../plan/engine";
import { computeDiff } from "../plan/diff";
import { PERSIST_KEY, loadPersisted, persistSoon } from "./persist";
import type { BudgetSummary, DecisionDiff, PlanItem, TripPlan } from "../plan/types";
import { nextStage, type AppStage } from "./machine";

export type TranscriptEntry = { who: "guest" | "avatar"; text: string };

export type Booking = { code: string; activityId: string };

/** A disposable conversation thread over the persistent trip. */
export type ChatMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  convo: {
    stage: AppStage;
    transcript: TranscriptEntry[];
    history: ChatTurn[];
    constraints: AgentResponse["constraints"];
    candidates: string[];
    excluded: { id: string; reason: string }[];
    selection?: string;
    lastTurn: TurnRecord | null;
    showTrace: boolean;
  };
};

/** DecisionDiff + the deterministic before/after money for the Inspector. */
export type TurnRecord = {
  diff: DecisionDiff;
  budgetBefore: BudgetSummary;
  budgetAfter: BudgetSummary;
  targetDate: string;
  stage: AgentResponse["stage"];
  moveOutcome?: { ok: boolean; detail: string };
};

const BUDGET_KEY = "michi-budget";

function loadBudget(): { total: number; mode: "flexible" | "firm" } {
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { total?: number; mode?: string };
      if (typeof p.total === "number" && p.total >= 1000)
        return { total: p.total, mode: p.mode === "firm" ? "firm" : "flexible" };
    }
  } catch {
    // no storage — demo default
  }
  return { total: seedPlan().totalBudgetJpy, mode: "flexible" };
}

type State = {
  stage: AppStage;
  tone: Tone;
  busy: boolean;
  transcript: TranscriptEntry[];
  history: ChatTurn[]; // raw turns sent to the model (assistant turns are raw JSON)
  constraints: AgentResponse["constraints"];
  /** Which planning episode the constraints belong to (increments when the
   *  model declares outing_change) + per-key provenance for the HUD. */
  outingId: number;
  constraintsMeta: Record<string, { turn: number; outing: number }>;
  /** Previous outing constraints retained for debugging, with no runtime effect. */
  supersededConstraints: AgentResponse["constraints"] | null;
  /** Was the party size explicitly stated during THIS outing? When false,
   *  party falls back to trip defaults and the prompt asks before booking. */
  partyExplicit: boolean;
  /** Tiny curated conversational memory: emotional events already
   *  acknowledged, so Michi never rediscovers a known loss/celebration. */
  knownEvents: {
    type: "loss" | "celebration";
    summary: string;
    /** Identity tokens (listener/affect/salience.ts) so a SECOND, different
     *  loss is distinguishable from a callback to the first one. */
    fingerprint: string[];
    outing: number;
  }[];
  candidates: string[];
  excluded: { id: string; reason: string }[];
  selection?: string;
  booking?: Booking;
  error?: string;

  // Michi planning state: the app owns situation + calendar + money across
  // the whole horizon. The model only expresses intent; placement, moves,
  // promotion, budget and the Decision Trace are computed deterministically.
  context: TripContext;
  /** Active party used for placement, budgets, checkout, and reservations. */
  party: { adults: number; children?: number; infants?: number };
  plan: TripPlan;
  budget: BudgetSummary;
  budgetMode: "flexible" | "firm";
  selectedDate: string;
  tripStart: string;
  tripEnd: string;
  protectedWindows: ProtectedWindow[];
  lastTurn: TurnRecord | null;
  showTrace: boolean;
  lastRetrieval: RetrievalResult | null;
  /** Bookmarks only — never touch the calendar or budget. */
  savedIds: string[];
  chats: ChatMeta[];
  activeChatId: string | null;

  addGuestTurn: (text: string) => void;
  addAvatarLine: (text: string) => void;
  /** A prerecorded ack that actually played: it enters the transcript AND
   *  the model history as a real assistant utterance (agent/ackContext.ts
   *  turns the trailing ack into a continue-from-here instruction). */
  addSpokenAck: (text: string) => void;
  addKnownEvent: (type: "loss" | "celebration", summary: string, fingerprint?: string[]) => void;
  applyAgentResponse: (r: AgentResponse) => void;
  setBusy: (b: boolean) => void;
  setError: (e?: string) => void;
  setBooking: (b: Booking) => void;
  pushHistory: (turn: ChatTurn) => void;
  promptContext: () => PromptContext;

  setSelectedDate: (date: string) => void;
  setTripDates: (start: string, end: string) => void;
  setBudget: (totalJpy: number, mode: "flexible" | "firm") => void;
  addEvent: (date: string, title: string, startAt: string, endAt: string) => void;
  addProtectedWindow: (w: ProtectedWindow) => void;
  /** UI + conversational moves both land here → engine.moveItem. */
  requestMove: (itemId: string, toDate: string, toTime?: string) => MoveResult;
  toggleSaved: (id: string) => void;
  /** NEW CHAT ≠ NEW TRIP: resets the thread, preserves the whole trip. */
  newChat: () => void;
  /** DEMO TOOL: back to a first-visit session — trip AND conversation.
   *  `newChat` deliberately keeps the trip (plan, party, booking); running
   *  the booking demo then the affect demo needs the trip gone too. */
  resetDemo: () => void;
  /** Leave confirm/checkout without paying. Records a system note so the
   *  next model turn doesn't believe something was reserved. */
  cancelCheckout: () => void;
  switchChat: (id: string) => void;
};

// Safe hydration: read → parse → validate → hydrate; malformed state is
// discarded and the default demo state applies. Budget is recomputed
// from the hydrated plan, never trusted from storage.
const hydrated = loadPersisted();
const legacyBudget = loadBudget(); // pre-v1 key, still honored if no v1 state
// Demo furniture (fixed dinner, rainy 2026-08-08, infant along) only for
// the harness (Node), ?mockagent and ?demo — a real visitor starts neutral:
// today's date, two adults, empty calendar (src/data/liveContext.ts).
const demoMode =
  typeof window === "undefined" ||
  new URLSearchParams(window.location.search).has("mockagent") ||
  new URLSearchParams(window.location.search).has("demo");
const baseContext = demoMode ? DEMO_CONTEXT : liveContext();
const baseTripEnd = demoMode ? DEMO_TRIP_END : liveTripEnd(baseContext.currentDate);
const basePlan = () => (demoMode ? seedPlan() : emptyPlan());

const initialPlan: TripPlan = hydrated?.plan ?? { ...basePlan(), totalBudgetJpy: legacyBudget.total };

export const useStore = create<State>((set, get) => ({
  stage: (hydrated?.stage as AppStage) ?? "greet",
  tone: "warm",
  busy: false,
  transcript: hydrated?.transcript ?? [],
  history: hydrated?.history ?? [],
  constraints: hydrated?.constraints ?? {},
  outingId: 0,
  constraintsMeta: {},
  supersededConstraints: null,
  partyExplicit: false,
  knownEvents: [],
  candidates: hydrated?.candidates ?? [],
  excluded: hydrated?.excluded ?? [],
  selection: hydrated?.selection,
  booking: hydrated?.booking,

  context: baseContext,
  party: hydrated?.party ?? baseContext.party,
  plan: initialPlan,
  budget: computeBudget(initialPlan, hydrated?.selection),
  budgetMode: hydrated?.budgetMode ?? legacyBudget.mode,
  selectedDate: hydrated?.selectedDate ?? baseContext.currentDate,
  tripStart: hydrated?.tripStart ?? baseContext.currentDate,
  tripEnd: hydrated?.tripEnd ?? baseTripEnd,
  protectedWindows: hydrated?.protectedWindows ?? [],
  lastTurn: hydrated?.lastTurn ?? null,
  showTrace: hydrated?.showTrace ?? false,
  lastRetrieval: null,
  savedIds: hydrated?.savedIds ?? [],
  chats: hydrated?.chats ?? [],
  activeChatId: hydrated?.activeChatId ?? null,

  addGuestTurn: (text) =>
    set((s) => ({
      transcript: [...s.transcript, { who: "guest", text }],
      history: [...s.history, { role: "user", content: text }],
    })),

  addAvatarLine: (text) =>
    set((s) => ({ transcript: [...s.transcript, { who: "avatar", text }] })),

  addSpokenAck: (text) =>
    set((s) => ({
      transcript: [...s.transcript, { who: "avatar", text }],
      history: [...s.history, { role: "assistant", content: text }],
    })),

  addKnownEvent: (type, summary, fingerprint = []) =>
    set((s) => {
      // Losses are kept per EVENT (a cat and a mother are not one grief);
      // celebrations stay one-per-conversation. Either way the list is
      // capped — this is a conversational memory, not a log.
      const known = s.knownEvents.filter((e) => e.type === "loss").map((e) => e.fingerprint);
      const duplicate =
        type === "loss"
          ? isKnownLoss(fingerprint, known)
          : s.knownEvents.some((e) => e.type === type);
      if (duplicate) return {};
      return {
        knownEvents: [...s.knownEvents.slice(-3), { type, summary, fingerprint, outing: s.outingId }],
      };
    }),

  pushHistory: (turn) => set((s) => ({ history: [...s.history, turn] })),

  applyAgentResponse: (r) =>
    set((s) => {
      const budgetBefore = s.budget;
      // Constraint lifetime: while the outing is the same, new values merge
      // over old (refinement). When the model declares outing_change, the
      // subject moved — the new set REPLACES the old one entirely. Nothing
      // from a "quiet solo evening" survives into "fun weekend with my
      // sister" unless the model restated it.
      const fresh = r.outing_change === true;
      const mergedConstraints0 = fresh ? { ...r.constraints } : { ...s.constraints, ...r.constraints };
      const outingId = fresh ? s.outingId + 1 : s.outingId;
      const turnNo = s.history.length;
      const constraintsMeta: Record<string, { turn: number; outing: number }> = fresh ? {} : { ...s.constraintsMeta };
      for (const [k, v] of Object.entries(r.constraints)) {
        if (v !== undefined) constraintsMeta[k] = { turn: turnNo, outing: outingId };
      }
      const partyExplicit = fresh
        ? r.constraints.adults !== undefined
        : s.partyExplicit || r.constraints.adults !== undefined;
      // One authoritative party: context defaults ⊕ conversational changes.
      const party = {
        adults: mergedConstraints0.adults ?? s.context.party.adults,
        children: mergedConstraints0.children ?? s.context.party.children,
        infants: mergedConstraints0.infants ?? s.context.party.infants,
      };
      const effCtx: TripContext = { ...s.context, party };
      const pi = r.plan_intent;
      const targetDate =
        pi?.target_date && inHorizon(pi.target_date) && pi.target_date >= s.context.currentDate
          ? pi.target_date
          : s.context.currentDate;

      const proposedBefore =
        s.plan.days.find((d) => d.date === targetDate)?.items.filter((i) => i.status === "proposed") ??
        [];

      let plan = s.plan;
      let proposedAfter: PlanItem[] = proposedBefore;
      let moveOutcome: TurnRecord["moveOutcome"];

      // 1. Conversational move — resolved by id or title, validated by the
      //    engine. Fixed items are refused there, not here.
      if (pi?.action === "move" && pi.move_to_date) {
        const target = [...plan.days]
          .flatMap((d) => d.items)
          .find(
            (i) =>
              (pi.move_activity_id && i.activityId === pi.move_activity_id) ||
              (pi.move_title && i.title.toLowerCase().includes(pi.move_title.toLowerCase())),
          );
        if (!target) {
          moveOutcome = { ok: false, detail: "item not found on the calendar" };
        } else {
          const res = moveItem(plan, effCtx, target.id, pi.move_to_date, pi.move_to_time, s.protectedWindows);
          moveOutcome = res.ok
            ? {
                ok: true,
                detail: `${target.title} → ${pi.move_to_date} ${res.startAt}${res.rebooking ? " (rebooking)" : ""}`,
              }
            : { ok: false, detail: res.reason };
          if (res.ok) plan = res.plan;
        }
      }

      // 2. Placement — the calendar only moves on suggest/revise, on the
      //    intent's target date. Fixed/reserved items are untouchable by
      //    construction (withProposals only swaps "proposed" items).
      if ((r.stage === "suggest" || r.stage === "revise") && r.candidates.length === 3) {
        const { placed } = placeCandidates(r.candidates, effCtx, plan, targetDate, s.protectedWindows);
        // Exclusive: exactly ONE candidate set exists at a time — options
        // proposed for another day in an earlier episode disappear.
        plan = withProposalsExclusive(plan, targetDate, placed);
        proposedAfter = placed;
      }

      // Party changes reprice EVERY open proposal deterministically — the
      // model never does pricing arithmetic.
      plan = {
        ...plan,
        days: plan.days.map((d) => ({
          ...d,
          items: d.items.map((i) => {
            if (i.status !== "proposed" || !i.activityId) return i;
            const a = activityById.get(i.activityId);
            return a ? { ...i, priceJpy: partyCostJpy(a, party) } : i;
          }),
        })),
      };

      const mergedConstraints = mergedConstraints0;
      const diff = computeDiff(
        { constraints: s.constraints, candidates: s.candidates, proposed: proposedBefore },
        {
          constraints: mergedConstraints,
          candidates: r.candidates.length === 3 ? r.candidates : s.candidates,
          proposed: proposedAfter,
        },
      );
      const budgetAfter = computeBudget(plan, r.selection ?? s.selection);
      // (plan already repriced above, so this total reflects the party.)

      // Inspector evidence: the same deterministic retrieval the server ran,
      // recomputed client-side with the model's own constraint state.
      const hint = [...s.history, { role: "user" as const, content: "" }]
        .filter((t) => t.role === "user")
        .map((t) => t.content)
        .join(" ");
      const lastRetrieval = retrieve(
        activities,
        hint,
        effCtx,
        mergedConstraints,
        plan,
        targetDate,
        s.protectedWindows,
      );

      return {
        stage: nextStage(s.stage, r.stage),
        tone: r.tone,
        constraints: mergedConstraints,
        outingId,
        constraintsMeta,
        supersededConstraints: fresh ? s.constraints : s.supersededConstraints,
        partyExplicit,
        candidates: r.candidates.length === 3 ? r.candidates : s.candidates,
        excluded: r.excluded.length > 0 ? r.excluded : s.excluded,
        selection: r.selection ?? s.selection,
        transcript: [...s.transcript, { who: "avatar", text: r.reply }],
        history: [...s.history, { role: "assistant", content: JSON.stringify(r) }],
        error: undefined,
        party,
        plan,
        budget: budgetAfter,
        selectedDate: targetDate,
        lastTurn: { diff, budgetBefore, budgetAfter, targetDate, stage: r.stage, moveOutcome },
        showTrace: r.stage === "revise" || pi?.action === "move",
        lastRetrieval,
      };
    }),

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),

  setBooking: (booking) =>
    set((s) => {
      // Duplicate guard: an already-reserved activity can never double-book
      // or double-charge — repeated confirms are no-ops.
      const alreadyReserved = s.plan.days.some((d) =>
        d.items.some((i) => i.status === "reserved" && i.activityId === booking.activityId),
      );
      if (alreadyReserved) return { stage: "done" as const, booking: s.booking ?? booking };

      // Engine-verified path: promote the existing proposal; if the model
      // confirmed an unplaced candidate, place it through the engine first —
      // findSlot re-checks availability, travel, and the fixed calendar.
      let day = s.plan.days.find((d) =>
        d.items.some((i) => i.status === "proposed" && i.activityId === booking.activityId),
      );
      let basePlan = s.plan;
      if (!day) {
        const effCtx: TripContext = { ...s.context, party: s.party };
        const { placed } = placeCandidates([booking.activityId], effCtx, s.plan, s.selectedDate, s.protectedWindows);
        if (placed.length) {
          basePlan = withProposals(s.plan, s.selectedDate, [
            ...(s.plan.days.find((d) => d.date === s.selectedDate)?.items.filter((i) => i.status === "proposed") ?? []),
            ...placed,
          ]);
          day = basePlan.days.find((d) => d.date === s.selectedDate);
        }
      }
      let plan = day ? promoteToReserved(basePlan, day.date, booking.activityId) : basePlan;
      const act = activityById.get(booking.activityId);
      if (act) {
        // The reservation is charged at the authoritative party price.
        plan = {
          ...plan,
          days: plan.days.map((d) => ({
            ...d,
            items: d.items.map((i) =>
              i.activityId === booking.activityId && i.status === "reserved"
                ? { ...i, priceJpy: partyCostJpy(act, s.party) }
                : i,
            ),
          })),
        };
      }
      return { booking, stage: "done", plan, budget: computeBudget(plan, s.selection) };
    }),

  promptContext: () => {
    const s = get();
    return {
      context: { ...s.context, party: s.party },
      fixedItems: s.plan.days.flatMap((d) =>
        d.items
          .filter((i) => i.status !== "proposed")
          .map((i) => ({ title: i.title, startAt: i.startAt, endAt: i.endAt, date: d.date })),
      ),
      totalBudgetJpy: s.plan.totalBudgetJpy,
      tripStart: s.tripStart,
      tripEnd: s.tripEnd,
    };
  },

  setSelectedDate: (selectedDate) => set({ selectedDate }),

  setTripDates: (tripStart, tripEnd) =>
    set((s) => ({
      tripStart,
      tripEnd: tripEnd >= tripStart ? tripEnd : tripStart,
      selectedDate:
        s.selectedDate >= tripStart && s.selectedDate <= tripEnd ? s.selectedDate : tripStart,
    })),

  setBudget: (totalJpy, mode) =>
    set((s) => {
      const plan = { ...s.plan, totalBudgetJpy: totalJpy };
      try {
        localStorage.setItem(BUDGET_KEY, JSON.stringify({ total: totalJpy, mode }));
      } catch {
        // private mode — setting just doesn't survive reload
      }
      return { plan, budgetMode: mode, budget: computeBudget(plan, get().selection) };
    }),

  addEvent: (date, title, startAt, endAt) =>
    set((s) => {
      const grown = withDay(s.plan, date);
      const end = toMin(endAt) > toMin(startAt) ? endAt : toHHMM(toMin(startAt) + 60);
      const plan: TripPlan = {
        ...grown,
        days: grown.days.map((d) =>
          d.date === date
            ? {
                ...d,
                items: [
                  ...d.items,
                  {
                    id: `user-${Date.now()}`,
                    title,
                    startAt,
                    endAt: end,
                    status: "fixed" as const,
                    priceJpy: 0,
                  },
                ].sort((x, y) => toMin(x.startAt) - toMin(y.startAt)),
              }
            : d,
        ),
      };
      return { plan, budget: computeBudget(plan, get().selection) };
    }),

  addProtectedWindow: (w) => set((s) => ({ protectedWindows: [...s.protectedWindows, w] })),

  requestMove: (itemId, toDate, toTime) => {
    const s = get();
    const res = moveItem(s.plan, s.context, itemId, toDate, toTime, s.protectedWindows);
    if (res.ok) {
      set({
        plan: res.plan,
        budget: computeBudget(res.plan, get().selection),
        selectedDate: toDate,
      });
    }
    return res;
  },

  toggleSaved: (id) =>
    set((s) => ({
      savedIds: s.savedIds.includes(id) ? s.savedIds.filter((x) => x !== id) : [...s.savedIds, id],
    })),

  newChat: () =>
    set((s) => {
      const chats = archiveCurrent(s);
      return {
        chats,
        activeChatId: `chat-${Date.now()}`,
        // thread resets…
        stage: "greet" as const,
        transcript: [],
        history: [],
        constraints: {},
        outingId: 0,
        constraintsMeta: {},
        supersededConstraints: null,
        partyExplicit: false,
        knownEvents: [],
        candidates: [],
        excluded: [],
        selection: undefined,
        lastTurn: null,
        showTrace: false,
        lastRetrieval: null,
        // …the TRIP survives untouched: plan, party, budget, saved, dates,
        // protected windows, booking all stay exactly as they are.
      };
    }),

  resetDemo: () => {
    try {
      localStorage.removeItem(PERSIST_KEY); // don't let a reload rehydrate it
    } catch {
      /* no localStorage (tests/node) — nothing to clear */
    }
    const plan = { ...basePlan(), totalBudgetJpy: legacyBudget.total };
    set({
      // conversation
      stage: "greet",
      tone: "warm",
      busy: false,
      transcript: [],
      history: [],
      constraints: {},
      outingId: 0,
      constraintsMeta: {},
      supersededConstraints: null,
      partyExplicit: false,
      knownEvents: [],
      candidates: [],
      excluded: [],
      selection: undefined,
      lastTurn: null,
      showTrace: false,
      lastRetrieval: null,
      // trip — the part newChat deliberately preserves
      booking: undefined,
      party: baseContext.party,
      plan,
      budget: computeBudget(plan, undefined),
      budgetMode: legacyBudget.mode,
      selectedDate: baseContext.currentDate,
      tripStart: baseContext.currentDate,
      tripEnd: baseTripEnd,
      protectedWindows: [],
      savedIds: [],
      chats: [],
      activeChatId: null,
    });
  },

  cancelCheckout: () =>
    set((s) => {
      if (s.stage !== "confirm" && s.stage !== "checkout") return {};
      return {
        stage: s.candidates.length > 0 ? ("suggest" as const) : ("gather" as const),
        history: [
          ...s.history,
          {
            role: "user" as const,
            content:
              "[system note: the guest closed the booking form without booking. " +
              "NOTHING was reserved and no payment was taken. Do not congratulate " +
              "them or refer to a booking; pick up where the conversation was.]",
          },
        ],
      };
    }),

  switchChat: (id) =>
    set((s) => {
      const target = s.chats.find((c) => c.id === id);
      if (!target) return {};
      const chats = archiveCurrent(s).filter((c) => c.id !== id);
      return {
        chats: [target, ...chats].slice(0, 10),
        activeChatId: id,
        ...target.convo,
        lastRetrieval: null,
      };
    }),
}));

/** Snapshot the live thread into the recent list (max 10, newest first). */
function archiveCurrent(s: State): ChatMeta[] {
  const firstUser = s.history.find((t) => t.role === "user")?.content?.trim();
  if (!firstUser) return s.chats.slice(0, 10);
  const existing = s.chats.find((c) => c.id === s.activeChatId);
  const meta: ChatMeta = {
    id: s.activeChatId ?? `chat-${Date.now()}`,
    title: firstUser.replace(/\s+/g, " ").slice(0, 42) + (firstUser.length > 42 ? "…" : ""),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    convo: {
      stage: s.stage,
      transcript: s.transcript,
      history: s.history,
      constraints: s.constraints,
      candidates: s.candidates,
      excluded: s.excluded,
      selection: s.selection,
      lastTurn: s.lastTurn,
      showTrace: s.showTrace,
    },
  };
  return [meta, ...s.chats.filter((c) => c.id !== meta.id)].slice(0, 10);
}

// Best-effort persistence: any store change schedules a debounced write of
// the whitelisted snapshot (src/flow/persist.ts). No-op without localStorage.
useStore.subscribe(() => persistSoon(() => useStore.getState()));

/** Convenience for UI: the display name behind a plan item / candidate. */
export function activityName(id: string): string {
  return activityById.get(id)?.name ?? id;
}
