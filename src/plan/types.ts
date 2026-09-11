// Plan/calendar state. The application owns this — the model only expresses
// intent (stage + candidate ids); deterministic code decides what actually
// lands on the calendar, and fixed items can never be moved by a model turn.

export type PlanStatus = "proposed" | "reserved" | "fixed";

export type PlanItem = {
  id: string;
  activityId?: string;
  title: string;
  startAt: string; // "HH:MM" on the day
  endAt: string;
  status: PlanStatus;
  priceJpy: number;
  travelMinutesBefore?: number;
};

export type TripDay = {
  date: string; // ISO date
  items: PlanItem[];
};

export type TripPlan = {
  days: TripDay[];
  totalBudgetJpy: number;
};

export type BudgetSummary = {
  committedJpy: number; // fixed + reserved
  proposedJpy: number;
  totalBudgetJpy: number;
  remainingJpy: number; // after committed + proposed
  state: "within" | "near" | "over";
};

export type DecisionDiff = {
  constraintsAdded: { key: string; value: unknown }[];
  constraintsRemoved: { key: string; value: unknown }[];
  constraintsChanged: { key: string; from: unknown; to: unknown }[];
  candidatesAdded: string[];
  candidatesRemoved: string[];
  candidatesRetained: string[];
  planItemsAdded: string[]; // titles
  planItemsRemoved: string[];
  planItemsChanged: string[];
};
