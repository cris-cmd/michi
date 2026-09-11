// The GENERAL visitor context — what a fresh end-user session starts from.
// DEMO_CONTEXT (rainy 2026-08-08, two adults + an eight-month-old, fixed
// Kagurazaka dinner) is rehearsal furniture: it stays the deterministic
// baseline for the harness, the mock agent, and ?demo/?mockagent runs, but a
// real visitor gets a neutral party, an empty calendar, and TODAY's date.
//
// Date/time are LOCAL-formatted (never toISOString — a JST date shifts a
// day, already bitten once). Weather is an assumption, not data — there is
// no weather API in this build, so the general context claims mild clear
// weather and the model treats it as such. Wire a real forecast before
// weather-sensitive picks matter for the public.

import type { TripContext } from "./activity";
import type { TripPlan } from "../plan/types";
import { addDays } from "./availability";

export const LIVE_TRIP_DAYS = 13; // planning window: today + ~2 weeks
export const LIVE_TOTAL_BUDGET_JPY = 100000;

const pad = (n: number) => String(n).padStart(2, "0");

export function liveContext(now: Date = new Date()): TripContext {
  return {
    location: "Tokyo",
    currentDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    nowTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    party: { adults: 2 },
    weather: { condition: "clear", rain: false, temperatureC: 24 },
  };
}

export function liveTripEnd(currentDate: string): string {
  return addDays(currentDate, LIVE_TRIP_DAYS);
}

/** A visitor starts with nothing scheduled — the calendar fills only from
 *  their own conversation. */
export function emptyPlan(): TripPlan {
  return { totalBudgetJpy: LIVE_TOTAL_BUDGET_JPY, days: [] };
}
