// Catalogue loader + the compact one-line serialization the system prompt
// uses. The prompt must stay byte-identical across turns of a conversation
// (prompt caching), so promptLine() is pure and the catalogue is a static
// generated artifact (scripts/generate-catalogue.mjs, seeded — see
// harness/deterministic.ts for the determinism + coverage checks).

import catalogueJson from "./activities.json";
import type { Activity } from "./activity";
import { availabilityFor, availabilitySummary } from "./availability";

export const activities = (catalogueJson as { activities: Activity[] }).activities;
export const activityById = new Map(activities.map((a) => [a.id, a]));

export function partyCostJpy(
  a: Activity,
  party: { adults: number; children?: number; infants?: number },
): number {
  return (
    party.adults * a.price.adultJpy +
    (party.children ?? 0) * (a.price.childJpy ?? a.price.adultJpy) +
    (party.infants ?? 0) * (a.price.infantJpy ?? 0)
  );
}

export function priceLabel(a: Activity): string {
  return `¥${a.price.adultJpy.toLocaleString("en-US")}`;
}

export function mapsUrl(a: Activity): string {
  return `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}`;
}

/** One activity as one stable prompt line for `date`. ~75 tokens each. */
export function promptLine(a: Activity, date: string): string {
  const f = a.family;
  const x = a.accessibility;
  const at = a.atmosphere;
  const price = `¥${a.price.adultJpy}/adult${f.infantFriendly ? " infants-free" : ""}`;
  const fam = `infant:${f.infantFriendly ? "y" : "N"} stroller:${f.strollerFriendly ? "y" : "N"} minAge:${f.minAge ?? "-"}`;
  const acc = `wheelchair:${x.wheelchairAccessible ? "y" : "N"}${x.stairs ? " stairs" : ""} intensity:${x.physicalIntensity}`;
  const atm = `quiet:${at.quiet} crowd:${at.crowdLevel} culture:${at.culturalDepth} touristy:${at.touristiness}`;
  const food = a.food?.involved ? `food:y${a.food.vegetarianFriendly ? "(veg-ok)" : ""}` : "food:n";
  const av = availabilityFor(a, date);
  const slots =
    av.status === "available"
      ? `slots:${av.slots.map((s) => s.startAt).join("/")}`
      : `slots:${av.status.toUpperCase()}`;
  const lead = a.booking.advanceMinutes ? ` book-ahead:${a.booking.advanceMinutes}min` : "";
  return [
    a.id,
    a.name,
    `${a.area} ~${a.travelMinutes}min-away`,
    a.categories.join(","),
    price,
    `${a.durationMinutes}min`,
    a.indoorOutdoor,
    `rain:${a.weather.rain} heat:${a.weather.heat}`,
    fam,
    acc,
    atm,
    `lang:${a.languages.join(",")}`,
    `${food} alcohol:${a.alcohol ? "y" : "n"}`,
    `${slots}${lead} | avail:${availabilitySummary(a)}`,
    `caveats:${a.friction.join("; ")}`,
    a.description,
  ].join(" | ");
}
