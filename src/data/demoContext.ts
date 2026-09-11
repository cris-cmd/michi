// The canonical demo situation: Tokyo, rainy Saturday, two adults + an
// eight-month-old, fixed dinner at 18:00, ¥50,000 activity budget, and it is
// 13:30 right now. One constant shared by the app, the mock agent, the eval
// harness, and the deterministic tests — so placement and budget math are
// reproducible everywhere.

import type { TripContext } from "./activity";
import type { TripPlan } from "../plan/types";

export const DEMO_CONTEXT: TripContext = {
  location: "Tokyo",
  currentDate: "2026-08-08",
  nowTime: "13:30",
  party: { adults: 2, infants: 1 },
  weather: { condition: "rain", rain: true, temperatureC: 27 },
};

export const DEMO_TOTAL_BUDGET_JPY = 50000;
export const DEMO_TRIP_END = "2026-08-11";

export function seedPlan(): TripPlan {
  return {
    totalBudgetJpy: DEMO_TOTAL_BUDGET_JPY,
    days: [
      {
        date: DEMO_CONTEXT.currentDate,
        items: [
          {
            id: "fixed-dinner",
            title: "Dinner — Kagurazaka (reservation)",
            startAt: "18:00",
            endAt: "19:30",
            status: "fixed",
            priceJpy: 11500,
          },
        ],
      },
    ],
  };
}
