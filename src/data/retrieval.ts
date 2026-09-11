// Local candidate retrieval — deterministic, no vector DB, no service.
// 922 activities never reach the model: hard eligibility (engine truth) plus
// soft relevance scoring narrows the catalogue to ~40–56 rows per turn, and
// a handful of deliberately-close INELIGIBLE near-misses ride along as honest
// exclusion fodder ("perfect, but sold out Saturday"). Every scored activity
// keeps a RetrievalTrace — that is what the Decision Inspector shows.
// Pure function of its inputs: the server (prompt build) and the browser
// (inspector) compute identical results.

import type { Activity, TripContext } from './activity';
import { partyCostJpy } from './activities';
import { availabilityFor } from './availability';
import { hardViolations, type ProtectedWindow } from '../plan/engine';
import type { AgentResponse } from '../agent/schema';
import type { TripPlan } from '../plan/types';

export type RetrievalTrace = {
  activityId: string;
  name: string;
  eligible: boolean;
  hardFailures: string[];
  scores: {
    total: number;
    keywords?: number;
    quiet?: number;
    culture?: number;
    crowd?: number;
    family?: number;
    budget?: number;
    travel?: number;
    availability?: number;
    language?: number;
  };
  rank: number;
};

export type RetrievalResult = {
  rows: Activity[];
  traces: RetrievalTrace[];
  stats: { catalogue: number; hardValid: number; sent: number; date: string };
};

const MAX_ELIGIBLE = 44;
const MAX_NEAR_MISS = 8;
const HERO_RE = /^a0(0\d|1[0-2])$/;

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4);

export function retrieve(
  all: Activity[],
  hint: string,
  ctx: TripContext,
  constraints: AgentResponse['constraints'],
  plan: TripPlan,
  date: string = ctx.currentDate,
  windows: ProtectedWindow[] = [],
): RetrievalResult {
  const words = new Set(tokens(hint));
  const round = (n: number) => Math.round(n * 10) / 10;

  const scored = all.map((a) => {
    const hardFailures = hardViolations(a, ctx, constraints, plan, date, windows);
    const s: RetrievalTrace['scores'] = { total: 0 };

    let kw = 0;
    for (const c of a.categories) for (const t of tokens(c)) if (words.has(t)) kw += 3;
    for (const w of tokens(a.name)) if (words.has(w)) kw += 2;
    if (words.has(a.area.toLowerCase())) kw += 2;
    for (const w of tokens(a.description)) if (words.has(w)) kw += 0.5;
    if (kw) s.keywords = round(kw);

    if ((constraints.quiet ?? 0) >= 4) s.quiet = a.atmosphere.quiet - 3;
    if ((constraints.culture ?? 0) >= 4) s.culture = a.atmosphere.culturalDepth - 3;
    if ((constraints.crowd_tolerance ?? 5) <= 2) s.crowd = 2 - a.atmosphere.crowdLevel;
    if ((constraints.infants ?? ctx.party.infants ?? 0) > 0)
      s.family = a.family.infantFriendly ? 1.5 : -1.5;
    if (!a.languages.includes('en')) s.language = -1;

    const budget = constraints.budget_jpy;
    if (budget) {
      const cost = partyCostJpy(a, ctx.party);
      s.budget = cost <= budget ? 1.5 : cost <= budget * 1.25 ? 0 : -2;
    }
    s.travel = round(-a.travelMinutes / 60);
    const avail = availabilityFor(a, date);
    s.availability = avail.status === 'available' ? 1 : -1;
    if (ctx.weather?.rain && date === ctx.currentDate) {
      if (a.weather.rain === 'good') s.availability += 1;
      else if (a.weather.rain === 'bad' || a.weather.rain === 'cancelled') s.availability -= 1;
    }
    if (HERO_RE.test(a.id)) s.availability += 0.5; // curated anchors

    s.total = round(
      (s.keywords ?? 0) + (s.quiet ?? 0) + (s.culture ?? 0) + (s.crowd ?? 0) +
      (s.family ?? 0) + (s.language ?? 0) + (s.budget ?? 0) + (s.travel ?? 0) +
      (s.availability ?? 0),
    );
    return { a, eligible: hardFailures.length === 0, hardFailures, scores: s };
  });

  scored.sort((x, y) => y.scores.total - x.scores.total || (x.a.id < y.a.id ? -1 : 1));
  const traces: RetrievalTrace[] = scored.map((r, i) => ({
    activityId: r.a.id,
    name: r.a.name,
    eligible: r.eligible,
    hardFailures: r.hardFailures,
    scores: r.scores,
    rank: i + 1,
  }));

  const chosen = new Map<string, Activity>();
  for (const r of scored) if (HERO_RE.test(r.a.id)) chosen.set(r.a.id, r.a);
  let eligibleCount = 0;
  for (const r of scored) {
    if (!r.eligible || chosen.has(r.a.id)) continue;
    if (eligibleCount++ >= MAX_ELIGIBLE) break;
    chosen.set(r.a.id, r.a);
  }
  // Near-misses: the highest-scoring INELIGIBLE ones — the model needs them
  // to say "perfect, but sold out Saturday" honestly.
  let nearMiss = 0;
  for (const r of scored) {
    if (r.eligible || chosen.has(r.a.id)) continue;
    if (nearMiss++ >= MAX_NEAR_MISS) break;
    chosen.set(r.a.id, r.a);
  }

  return {
    // Stable order for the prompt: by id, so the byte-identical memo holds.
    rows: [...chosen.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
    traces,
    stats: {
      catalogue: all.length,
      hardValid: scored.filter((r) => r.eligible).length,
      sent: chosen.size,
      date,
    },
  };
}
