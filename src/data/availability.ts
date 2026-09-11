// Deterministic date-indexed availability, computed — never stored. Each
// activity carries a compact pattern; this module expands it for any date in
// the horizon. Same inputs → same output, everywhere (generator, engine,
// retrieval, UI, tests), so the 30-day horizon costs no catalogue bytes.

import type { Activity } from "./activity";

export const HORIZON_START = "2026-08-08";
export const HORIZON_DAYS = 31;

export type AvailabilityStatus = "available" | "sold_out" | "closed";

export type ActivityAvailability = {
  date: string;
  status: AvailabilityStatus;
  slots: { startAt: string; capacityRemaining: number }[];
};

export function addDays(iso: string, n: number): string {
  // Local-time arithmetic + local formatting — toISOString() would shift the
  // date across the UTC boundary (JST is +9; Aug 8 would become Aug 7).
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function horizonDates(): string[] {
  return Array.from({ length: HORIZON_DAYS }, (_, i) => addDays(HORIZON_START, i));
}

export function inHorizon(date: string): boolean {
  return date >= HORIZON_START && date <= addDays(HORIZON_START, HORIZON_DAYS - 1);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00`).getDay(); // 0=Sun … 6=Sat
}

/** Small deterministic hash → [0, 1). Stable across runtimes. */
export function detHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export type AvailabilityPattern = Activity["availability"];

function openOn(p: AvailabilityPattern, id: string, date: string): boolean {
  const wd = weekday(date);
  switch (p.kind) {
    case "daily":
      return true;
    case "weekends":
      return wd === 0 || wd === 6;
    case "weekdays":
      return wd >= 1 && wd <= 5;
    case "closed_monday":
      return wd !== 1;
    case "sparse":
      return detHash(`open|${id}|${date}`) < 0.34;
  }
}

export function availabilityFor(a: Activity, date: string): ActivityAvailability {
  const p = a.availability;
  if (!inHorizon(date) || !openOn(p, a.id, date)) return { date, status: "closed", slots: [] };
  if (p.soldOutRate > 0 && detHash(`sold|${a.id}|${date}`) < p.soldOutRate)
    return { date, status: "sold_out", slots: [] };
  return {
    date,
    status: "available",
    slots: p.times.map((startAt) => ({
      startAt,
      capacityRemaining: 1 + Math.floor(detHash(`cap|${a.id}|${date}|${startAt}`) * 6),
    })),
  };
}

/** Compact human/prompt summary of the pattern, e.g. "weekends 10:00/14:00". */
export function availabilitySummary(a: Activity): string {
  const p = a.availability;
  const kind =
    p.kind === "daily"
      ? "daily"
      : p.kind === "weekends"
        ? "weekends-only"
        : p.kind === "weekdays"
          ? "weekdays-only"
          : p.kind === "closed_monday"
            ? "closed-Mondays"
            : "irregular";
  return `${kind} ${p.times.join("/")}${p.soldOutRate >= 0.2 ? " (often sold out)" : ""}`;
}
