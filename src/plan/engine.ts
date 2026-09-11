// Deterministic scheduling and constraint checks. Model output is treated as
// a proposal; this module owns time, availability, conflicts, age rules, and
// budget calculations.

import type { Activity, TripContext } from "../data/activity";
import { activityById, partyCostJpy } from "../data/activities";
import { availabilityFor, inHorizon } from "../data/availability";
import type { AgentResponse } from "../agent/schema";
import type { BudgetSummary, PlanItem, TripPlan } from "./types";

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

type Constraints = AgentResponse["constraints"];

// "around ¥X" is soft by nature — a hard budget violation needs real headroom.
const HARD_BUDGET_TOLERANCE = 1.25;
const DAY_END_MIN = toMin("21:30");
const DAY_START_MIN = toMin("09:00");

export type ProtectedWindow = {
  recurrence?: "daily";
  date?: string; // for one-off windows
  startTime: string;
  endTime: string;
  reason: string;
};

export function dayOf(plan: TripPlan, date: string) {
  return plan.days.find((d) => d.date === date);
}

/** Ensure a TripDay exists for `date` (multi-day plans grow on demand). */
export function withDay(plan: TripPlan, date: string): TripPlan {
  if (dayOf(plan, date)) return plan;
  return {
    ...plan,
    days: [...plan.days, { date, items: [] }].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

function protectedSpansFor(windows: ProtectedWindow[], date: string): PlanItem[] {
  return windows
    .filter((w) => w.recurrence === "daily" || w.date === date)
    .map((w, i) => ({
      id: `protected-${i}`,
      title: w.reason,
      startAt: w.startTime,
      endAt: w.endTime,
      status: "fixed" as const,
      priceJpy: 0,
    }));
}

/** Immovable spans (fixed + reserved + protected windows) plus extras. */
function blockedSpans(
  plan: TripPlan,
  date: string,
  extra: PlanItem[] = [],
  windows: ProtectedWindow[] = [],
  ignoreItemId?: string,
): PlanItem[] {
  const items = dayOf(plan, date)?.items ?? [];
  return [
    ...items.filter((i) => i.status !== "proposed" && i.id !== ignoreItemId),
    ...protectedSpansFor(windows, date),
    ...extra,
  ].sort((x, y) => toMin(x.startAt) - toMin(y.startAt));
}

/** Minutes from "now" (ctx date+time) until `date` at `hhmm`. */
function minutesUntil(ctx: TripContext, date: string, hhmm: string): number {
  const now = new Date(`${ctx.currentDate}T${ctx.nowTime}:00`);
  const then = new Date(`${date}T${hhmm}:00`);
  return Math.round((then.getTime() - now.getTime()) / 60000);
}

/**
 * Earliest slot for `a` on `date` that is in the future, respects booking
 * lead time, fits its duration plus return-travel before the next immovable
 * item, and does not overlap blocked spans. Null when nothing fits.
 */
export function findSlot(
  a: Activity,
  ctx: TripContext,
  plan: TripPlan,
  occupied: PlanItem[] = [],
  date: string = ctx.currentDate,
  windows: ProtectedWindow[] = [],
): { startAt: string; endAt: string } | null {
  if (!inHorizon(date) || date < ctx.currentDate) return null;
  const avail = availabilityFor(a, date);
  if (avail.status !== "available") return null;
  const isToday = date === ctx.currentDate;
  const now = toMin(ctx.nowTime);
  const blocked = blockedSpans(plan, date, occupied, windows);

  for (const { startAt } of avail.slots) {
    const start = toMin(startAt);
    if (start < DAY_START_MIN) continue;
    if (isToday && start < now + a.travelMinutes) continue; // can't get there in time
    if (minutesUntil(ctx, date, startAt) < a.booking.advanceMinutes) continue; // lead time
    const end = start + a.durationMinutes;
    if (end > DAY_END_MIN) continue;

    let ok = true;
    for (const b of blocked) {
      const bs = toMin(b.startAt);
      const be = toMin(b.endAt);
      if (start < be && end > bs) {
        ok = false;
        break;
      }
      if (b.status !== "proposed" && bs >= end && end + a.travelMinutes > bs) {
        ok = false; // would arrive late to the fixed booking
        break;
      }
      if (be <= start && start < be + a.travelMinutes) {
        ok = false; // can't travel from the preceding engagement in time
        break;
      }
    }
    if (ok) return { startAt: toHHMM(start), endAt: toHHMM(end) };
  }
  return null;
}

/**
 * Hard impossibilities for this traveler on `date`. Empty array = allowed.
 * Soft fit (quiet, crowds, culture, distance, price preference…) is the
 * model's territory and is deliberately NOT judged here.
 */
export function hardViolations(
  a: Activity,
  ctx: TripContext,
  constraints: Constraints,
  plan: TripPlan,
  date: string = ctx.currentDate,
  windows: ProtectedWindow[] = [],
): string[] {
  const v: string[] = [];
  const infants = constraints.infants ?? ctx.party.infants ?? 0;
  const children = constraints.children ?? ctx.party.children ?? 0;

  // Weather is only a known fact for the current day.
  if (date === ctx.currentDate && ctx.weather?.rain && a.weather.rain === "cancelled")
    v.push("cancelled in rain");
  if (infants > 0 && !a.family.infantFriendly) v.push("not possible with an infant");
  if (infants > 0 && (a.family.minAge ?? 0) >= 1) v.push(`minimum age ${a.family.minAge}`);
  if (children > 0 && (a.family.minAge ?? 0) > 12) v.push(`minimum age ${a.family.minAge}`);

  const budget = constraints.budget_jpy;
  if (budget && !constraints.budget_flexible) {
    const cost = partyCostJpy(a, {
      adults: constraints.adults ?? ctx.party.adults,
      children,
      infants,
    });
    if (cost > budget * HARD_BUDGET_TOLERANCE)
      v.push(`¥${cost.toLocaleString("en-US")} for your party — over the stated budget`);
  }

  const avail = availabilityFor(a, date);
  if (avail.status === "sold_out") v.push(`sold out on ${date}`);
  else if (avail.status === "closed") v.push(`closed on ${date}`);
  else if (!findSlot(a, ctx, plan, [], date, windows))
    v.push("no bookable slot fits your window today");

  return v;
}

/**
 * Place candidates on `date`, in the model's preference order, greedily and
 * without overlaps. Fixed/reserved items are never touched.
 */
export function placeCandidates(
  candidateIds: string[],
  ctx: TripContext,
  plan: TripPlan,
  date: string = ctx.currentDate,
  windows: ProtectedWindow[] = [],
): { placed: PlanItem[]; unplaced: { id: string; reason: string }[] } {
  const placed: PlanItem[] = [];
  const unplaced: { id: string; reason: string }[] = [];
  for (const id of candidateIds) {
    const a = activityById.get(id);
    if (!a) {
      unplaced.push({ id, reason: "unknown activity" });
      continue;
    }
    const slot = findSlot(a, ctx, plan, placed, date, windows);
    if (!slot) {
      unplaced.push({ id, reason: "no non-conflicting slot" });
      continue;
    }
    placed.push({
      id: `prop-${id}`,
      activityId: id,
      title: a.name,
      startAt: slot.startAt,
      endAt: slot.endAt,
      status: "proposed",
      priceJpy: partyCostJpy(a, ctx.party),
      travelMinutesBefore: a.travelMinutes,
    });
  }
  return { placed, unplaced };
}

/** Replace `date`'s proposed items; fixed/reserved always survive. */
export function withProposals(plan: TripPlan, date: string, proposals: PlanItem[]): TripPlan {
  const grown = withDay(plan, date);
  return {
    ...grown,
    days: grown.days.map((d) =>
      d.date === date
        ? {
            ...d,
            items: [...d.items.filter((i) => i.status !== "proposed"), ...proposals].sort(
              (x, y) => toMin(x.startAt) - toMin(y.startAt),
            ),
          }
        : d,
    ),
  };
}

/** Promote the proposed item for `activityId` to reserved; drop other proposals. */
export function promoteToReserved(plan: TripPlan, date: string, activityId: string): TripPlan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.date === date
        ? {
            ...d,
            items: d.items
              .filter((i) => i.status !== "proposed" || i.activityId === activityId)
              .map((i) =>
                i.status === "proposed" && i.activityId === activityId
                  ? { ...i, status: "reserved" as const }
                  : i,
              ),
          }
        : d,
    ),
  };
}

export type MoveResult =
  | { ok: true; plan: TripPlan; startAt: string; endAt: string; rebooking: boolean }
  | { ok: false; reason: string };

/**
 * Move a plan item to another date/time. EVERY movement — conversational or
 * UI — runs through here. Fixed items never move. Reserved items move but
 * are flagged as a rebooking. Validity = the same findSlot rules.
 */
export function moveItem(
  plan: TripPlan,
  ctx: TripContext,
  itemId: string,
  toDate: string,
  toTime?: string,
  windows: ProtectedWindow[] = [],
): MoveResult {
  let fromDate: string | undefined;
  let item: PlanItem | undefined;
  for (const d of plan.days)
    for (const i of d.items)
      if (i.id === itemId) {
        fromDate = d.date;
        item = i;
      }
  if (!item || !fromDate) return { ok: false, reason: "item not found" };
  if (item.status === "fixed") return { ok: false, reason: "fixed items never move automatically" };
  if (!inHorizon(toDate)) return { ok: false, reason: "outside the trip horizon" };
  if (toDate < ctx.currentDate) return { ok: false, reason: "cannot schedule in the past" };

  // Custom (non-activity) items can go anywhere conflict-free; activities
  // must land on a real availability slot.
  const without: TripPlan = {
    ...plan,
    days: plan.days.map((d) =>
      d.date === fromDate ? { ...d, items: d.items.filter((i) => i.id !== itemId) } : d,
    ),
  };
  const a = item.activityId ? activityById.get(item.activityId) : undefined;

  let slot: { startAt: string; endAt: string } | null = null;
  if (a) {
    const s = findSlot(a, ctx, without, [], toDate, windows);
    if (toTime) {
      const avail = availabilityFor(a, toDate);
      const exact = avail.slots.find((x) => x.startAt === toTime);
      if (!exact) return { ok: false, reason: `no ${toTime} slot on ${toDate}` };
      const probe = findSlot(
        { ...a, availability: { ...a.availability, times: [toTime] } },
        ctx,
        without,
        [],
        toDate,
        windows,
      );
      if (!probe) return { ok: false, reason: `${toTime} on ${toDate} conflicts with the calendar` };
      slot = probe;
    } else slot = s;
    if (!slot) return { ok: false, reason: `no valid slot on ${toDate}` };
  } else {
    // custom event: keep its duration, keep time unless specified
    const start = toTime ?? item.startAt;
    const dur = toMin(item.endAt) - toMin(item.startAt);
    const end = toHHMM(toMin(start) + dur);
    const blocked = blockedSpans(without, toDate, [], windows, itemId);
    for (const b of blocked) {
      if (toMin(start) < toMin(b.endAt) && toMin(end) > toMin(b.startAt))
        return { ok: false, reason: `conflicts with ${b.title}` };
    }
    slot = { startAt: start, endAt: end };
  }

  const moved: PlanItem = { ...item, startAt: slot.startAt, endAt: slot.endAt };
  const target = withDay(without, toDate);
  return {
    ok: true,
    rebooking: item.status === "reserved",
    startAt: slot.startAt,
    endAt: slot.endAt,
    plan: {
      ...target,
      days: target.days.map((d) =>
        d.date === toDate
          ? { ...d, items: [...d.items, moved].sort((x, y) => toMin(x.startAt) - toMin(y.startAt)) }
          : d,
      ),
    },
  };
}

/** Deterministic money — whole trip. Never trust model-generated totals.
 *
 *  Proposed items are RECOMMENDATION CANDIDATES — mutually exclusive options
 *  on display, not planned spending. They count toward proposedJpy only when
 *  `selection` names one (the guest is about to commit it). Without this,
 *  three alternatives once summed into "over budget" nonsense (¥100,500
 *  proposed against a ¥50,000 trip). */
export function computeBudget(plan: TripPlan, selection?: string): BudgetSummary {
  let committedJpy = 0;
  let proposedJpy = 0;
  for (const d of plan.days)
    for (const i of d.items) {
      if (i.status === "proposed") {
        if (selection && i.activityId === selection) proposedJpy += i.priceJpy;
      } else committedJpy += i.priceJpy;
    }
  const total = committedJpy + proposedJpy;
  const remainingJpy = plan.totalBudgetJpy - total;
  const state: BudgetSummary["state"] =
    remainingJpy < 0 ? "over" : remainingJpy < plan.totalBudgetJpy * 0.12 ? "near" : "within";
  return { committedJpy, proposedJpy, totalBudgetJpy: plan.totalBudgetJpy, remainingJpy, state };
}

/** Deterministic money — one day (same candidate-vs-selected rule). */
export function computeDayBudget(
  plan: TripPlan,
  date: string,
  selection?: string,
): { committedJpy: number; proposedJpy: number } {
  let committedJpy = 0;
  let proposedJpy = 0;
  for (const i of dayOf(plan, date)?.items ?? []) {
    if (i.status === "proposed") {
      if (selection && i.activityId === selection) proposedJpy += i.priceJpy;
    } else committedJpy += i.priceJpy;
  }
  return { committedJpy, proposedJpy };
}

/** Place a NEW recommendation set: proposed candidates from every other date
 *  are cleared first — exactly one candidate set exists at a time, so a past
 *  episode's options can never linger on other days as phantom spending or
 *  stale calendar clutter. Fixed/reserved items always survive. */
export function withProposalsExclusive(plan: TripPlan, date: string, proposals: PlanItem[]): TripPlan {
  const cleared: TripPlan = {
    ...plan,
    days: plan.days.map((d) =>
      d.date === date ? d : { ...d, items: d.items.filter((i) => i.status !== "proposed") },
    ),
  };
  return withProposals(cleared, date, proposals);
}
