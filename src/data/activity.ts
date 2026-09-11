// The Michi domain: activities/experiences, trip context, and preferences.
// Constraint density is the point — every activity carries enough structure
// for the deterministic engine (src/plan/engine.ts) to rule on hard
// impossibilities while the model reasons about soft fit.

export type Activity = {
  id: string;
  name: string;
  operator: string;
  region: string;
  area: string;
  lat: number;
  lng: number;
  categories: string[];
  description: string;
  price: { adultJpy: number; childJpy?: number; infantJpy?: number };
  durationMinutes: number;
  indoorOutdoor: "indoor" | "outdoor" | "mixed";
  weather: { rain: "good" | "okay" | "bad" | "cancelled"; heat: "good" | "okay" | "bad" };
  family: {
    infantFriendly: boolean;
    strollerFriendly: boolean;
    minAge?: number;
    changingTable?: boolean;
  };
  accessibility: {
    wheelchairAccessible: boolean;
    stairs: boolean;
    physicalIntensity: 1 | 2 | 3 | 4 | 5;
  };
  atmosphere: {
    quiet: 1 | 2 | 3 | 4 | 5;
    crowdLevel: 1 | 2 | 3 | 4 | 5;
    culturalDepth: 1 | 2 | 3 | 4 | 5;
    touristiness: 1 | 2 | 3 | 4 | 5;
  };
  languages: string[];
  food?: { involved: boolean; vegetarianFriendly?: boolean; allergySupport?: boolean };
  alcohol: boolean;
  booking: {
    advanceMinutes: number;
    cancellable: boolean;
  };
  /** Compact pattern; src/data/availability.ts expands it per date, deterministically. */
  availability: {
    kind: "daily" | "weekends" | "weekdays" | "closed_monday" | "sparse";
    times: string[];
    soldOutRate: number;
  };
  friction: string[];
  /** Minutes from the traveler's hotel — used for travel buffers. */
  travelMinutes: number;
  provenance: { type: "synthetic" } | { type: "real"; source?: string };
};

// Situational context: what is true for this traveler RIGHT NOW — as opposed
// to preferences, which are what they want. Sent with every /turn request and
// baked into the system prompt (stable within a session → prompt cache holds).
export type TripContext = {
  location: string;
  currentDate: string; // ISO date
  nowTime: string; // "HH:MM" — the demo clock
  party: { adults: number; children?: number; infants?: number };
  weather?: { condition: string; rain?: boolean; temperatureC?: number };
};
