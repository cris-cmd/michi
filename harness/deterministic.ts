/**
 * harness/deterministic.ts — the no-API test suite. Verifies everything the
 * app trusts deterministic code for: catalogue generation (repeatable, rich,
 * schema-clean), the constraint/scheduling engine, budget math, the decision
 * diff, and the full mock-agent canonical demo.
 *
 *   npm run test:plan
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { activities, activityById, partyCostJpy } from '../src/data/activities';
import { availabilityFor, horizonDates } from '../src/data/availability';
import { retrieve } from '../src/data/retrieval';
import { DEMO_CONTEXT, seedPlan } from '../src/data/demoContext';
import {
  computeBudget,
  computeDayBudget,
  findSlot,
  hardViolations,
  moveItem,
  placeCandidates,
  promoteToReserved,
  toMin,
  withProposals,
} from '../src/plan/engine';
import { computeDiff } from '../src/plan/diff';
import { endpointDelayMs } from '../src/voice/endpoint';
import { useStore } from '../src/flow/store';
import { restoreState, snapshotState } from '../src/flow/persist';
import { DeterministicListenerPolicy } from '../src/conversation/listener/policy';
import { PhraseAssembler } from '../src/conversation/phrases';
import { ReplyStreamExtractor } from '../src/agent/streamExtract';
import { isSystemNote, mergeAlternating, withAckContinuation } from '../src/agent/ackContext';
import { AckEchoGuard, stripAckEcho } from '../src/conversation/ackEcho';
import { segmentUtterance } from '../src/conversation/listener/affect/segment';
import { hasLossMarker, lossFingerprint, scoreSegment } from '../src/conversation/listener/affect/salience';
import {
  applyEventContinuity,
  capForUncertainTranscript,
  fuseListenerDecision,
  fuseUtterance,
  listenerContextOf,
} from '../src/conversation/listener/affect/fusion';
import { AcknowledgementLibrary } from '../src/conversation/listener/acks';
import type { VoiceEngine } from '../src/voice/types';
import type { ListenerDecision } from '../src/conversation/listener/types';
import { assessTranscript } from '../src/conversation/transcript';
import { buildTurnHistory, historyBytes } from '../src/agent/contextBuilder';
import { MotionSelector } from '../src/avatar/motionSelector';
import { speakable } from '../src/voice/speakable';
import type { ChatTurn } from '../src/agent/client';
import { MESSAGES, GREETINGS_CHECK, SPEECH_LANG, STT_LOCALE } from './i18nCheck';
import { DEMO_TRIP_END } from '../src/data/demoContext';
import { mockAgentTurn } from '../src/agent/mockAgent';
import type { AgentResponse } from '../src/agent/schema';

let failed = 0;
function check(pass: boolean, label: string, detail?: string) {
  if (pass) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── 1. Catalogue: deterministic, heterogeneous, schema-clean ─────────────
section('catalogue');
{
  const path = 'src/data/activities.json';
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  execFileSync('node', ['scripts/generate-catalogue.mjs'], { stdio: 'pipe' });
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');
  check(before === after, 'generation is deterministic (same seed → same bytes)');

  const n = activities.length;
  const c = (f: (a: (typeof activities)[number]) => boolean) => activities.filter(f).length;
  check(n >= 800 && n <= 1500, `size ${n} in 800–1500`);
  check(new Set(activities.map((a) => a.id)).size === n, 'ids unique');
  check(activities.every((a) => a.provenance.type === 'synthetic'), 'all provenance synthetic');

  // Coverage floors AND ceilings — catches accidentally homogeneous output.
  const between = (label: string, count: number, lo: number, hi: number) =>
    check(count >= lo && count <= hi, `${label}: ${count} in [${lo}, ${hi}]`);
  between('infant-friendly', c((a) => a.family.infantFriendly), 60, n - 60);
  between('stroller-friendly', c((a) => a.family.strollerFriendly), 60, n - 60);
  between('minimum ages', c((a) => (a.family.minAge ?? 0) > 0), 60, n - 60);
  between('wheelchair accessible', c((a) => a.accessibility.wheelchairAccessible), 80, n - 60);
  between('rain-cancelled', c((a) => a.weather.rain === 'cancelled'), 8, 60);
  between('rain-bad', c((a) => a.weather.rain === 'bad'), 12, 200);
  between('heat-sensitive', c((a) => a.weather.heat === 'bad'), 10, 100);
  between('quiet (4-5)', c((a) => a.atmosphere.quiet >= 4), 60, n - 60);
  between('loud (1-2)', c((a) => a.atmosphere.quiet <= 2), 40, n - 60);
  between('crowded (4-5)', c((a) => a.atmosphere.crowdLevel >= 4), 40, n - 60);
  between('very touristy', c((a) => a.atmosphere.touristiness >= 4), 25, n - 60);
  between('deep culture', c((a) => a.atmosphere.culturalDepth >= 4), 60, n - 30);
  between('high intensity (4-5)', c((a) => a.accessibility.physicalIntensity >= 4), 10, 120);
  between('food involved', c((a) => a.food?.involved === true), 40, n - 60);
  between('alcohol', c((a) => a.alcohol), 10, 150),
  between('Japanese-only', c((a) => !a.languages.includes('en')), 20, 350);
  between('closed today (patterns)', c((a) => availabilityFor(a, DEMO_CONTEXT.currentDate).status === 'closed'), 60, 500);
  between('sold out today', c((a) => availabilityFor(a, DEMO_CONTEXT.currentDate).status === 'sold_out'), 15, 250);
  between('cash only', c((a) => a.friction.includes('cash only')), 20, 400);
  between('long lead time (1d)', c((a) => a.booking.advanceMinutes >= 1440), 20, 400);
  check(Math.min(...activities.map((a) => a.price.adultJpy)) < 1500, 'cheap options exist');
  check(Math.max(...activities.map((a) => a.price.adultJpy)) > 12000, 'premium options exist');
  check(new Set(activities.map((a) => a.durationMinutes)).size >= 5, 'duration variety');
  check(activities.every((a) => a.friction.length >= 1), 'every activity has ≥1 honest caveat');

  // Structural schema pass over every record.
  const bad = activities.filter(
    (a) =>
      !a.id || !a.name || !a.operator || !a.area ||
      typeof a.price.adultJpy !== 'number' ||
      !['indoor', 'outdoor', 'mixed'].includes(a.indoorOutdoor) ||
      !['good', 'okay', 'bad', 'cancelled'].includes(a.weather.rain) ||
      a.atmosphere.quiet < 1 || a.atmosphere.quiet > 5 ||
      a.accessibility.physicalIntensity < 1 || a.accessibility.physicalIntensity > 5 ||
      !Array.isArray(a.availability.times) ||
      !['daily', 'weekends', 'weekdays', 'closed_monday', 'sparse'].includes(a.availability.kind) ||
      typeof a.travelMinutes !== 'number',
  );
  check(bad.length === 0, 'all records pass schema', bad.map((b) => b.id).join(','));
}

// ── 2. Engine: slots, placement, hard rules ──────────────────────────────
section('engine');
{
  const plan = seedPlan();
  const a001 = activityById.get('a001')!;

  // advance lead (60min from 13:30) skips the 14:00 slot → 16:00.
  const slot = findSlot(a001, DEMO_CONTEXT, plan);
  check(slot?.startAt === '16:00', 'a001: lead time pushes to 16:00 slot', JSON.stringify(slot));

  const { placed, unplaced } = placeCandidates(['a001', 'a002', 'a012'], DEMO_CONTEXT, plan);
  check(placed.length === 2, 'canonical t1 places 2 of 3', placed.map((p) => `${p.activityId}@${p.startAt}`).join(','));
  check(placed.some((p) => p.activityId === 'a012' && p.startAt === '14:00'), 'washi lands 14:00');
  check(unplaced.some((u) => u.id === 'a002'), 'wagashi cannot fit alongside the others');

  // no overlaps among placements ∪ fixed
  const day = withProposals(plan, DEMO_CONTEXT.currentDate, placed).days[0];
  const spans = day.items.map((i) => [toMin(i.startAt), toMin(i.endAt)] as const).sort((x, y) => x[0] - y[0]);
  const overlap = spans.some(([, e], i) => i + 1 < spans.length && e > spans[i + 1][0]);
  check(!overlap, 'no overlapping calendar items');
  check(day.items.some((i) => i.id === 'fixed-dinner' && i.startAt === '18:00'), 'fixed dinner untouched');

  // hard rules
  const noConstraints = {};
  const v004 = hardViolations(activityById.get('a004')!, DEMO_CONTEXT, noConstraints, plan);
  check(v004.some((x) => x.includes('rain')), 'cycling: cancelled in rain', v004.join(';'));
  check(v004.some((x) => x.includes('minimum age') || x.includes('infant')), 'cycling: age/infant violation');
  const v007 = hardViolations(activityById.get('a007')!, DEMO_CONTEXT, noConstraints, plan);
  check(v007.some((x) => x.includes('minimum age') || x.includes('infant')), 'sake: 20+ blocked with infant party');
  const v003budget = hardViolations(activityById.get('a003')!, DEMO_CONTEXT, { budget_jpy: 5000 }, plan);
  check(v003budget.some((x) => x.includes('budget')), 'firm ¥5,000 budget blocks ¥26,000 kintsugi');
  const v003flex = hardViolations(activityById.get('a003')!, DEMO_CONTEXT, { budget_jpy: 5000, budget_flexible: true, infants: 0 }, plan);
  check(!v003flex.some((x) => x.includes('budget')), 'flexible budget lifts the block');
  const closedToday = activities.find((a) => availabilityFor(a, DEMO_CONTEXT.currentDate).status === 'closed')!;
  check(
    hardViolations(closedToday, DEMO_CONTEXT, noConstraints, plan).some((x) => x.includes('closed')),
    `closed-today activity (${closedToday.id}) is a violation`,
  );
  const soldOutToday = activities.find((a) => availabilityFor(a, DEMO_CONTEXT.currentDate).status === 'sold_out')!;
  check(
    hardViolations(soldOutToday, DEMO_CONTEXT, noConstraints, plan).some((x) => x.includes('sold out')),
    `sold-out-today activity (${soldOutToday.id}) is a violation`,
  );
  const evening = activityById.get('a011')!; // 19:30 start vs 18:00 dinner
  check(
    hardViolations(evening, DEMO_CONTEXT, noConstraints, plan).some((x) => x.includes('window')),
    'evening-only walk cannot fit before fixed dinner… it conflicts',
  );

  // promotion: booking keeps the chosen one, drops other proposals, dinner intact
  const promoted = promoteToReserved(withProposals(plan, DEMO_CONTEXT.currentDate, placed), DEMO_CONTEXT.currentDate, 'a001');
  const items = promoted.days[0].items;
  check(items.some((i) => i.activityId === 'a001' && i.status === 'reserved'), 'booking promotes proposed → reserved');
  check(!items.some((i) => i.status === 'proposed'), 'other proposals cleared on booking');
  check(items.some((i) => i.id === 'fixed-dinner' && i.status === 'fixed'), 'fixed dinner survives booking');
}

// ── 3. Budget: deterministic money ───────────────────────────────────────
section('budget');
{
  const plan = seedPlan();
  const { placed } = placeCandidates(['a001', 'a002', 'a012'], DEMO_CONTEXT, plan);
  const withProps = withProposals(plan, DEMO_CONTEXT.currentDate, placed);
  // Candidates are OPTIONS, not spending: three mutually-exclusive
  // recommendations must never sum into "over budget".
  const b = computeBudget(withProps);
  check(b.committedJpy === 11500, `committed = dinner ¥11,500 (got ¥${b.committedJpy})`);
  check(b.proposedJpy === 0, `candidates alone consume NO budget (got ¥${b.proposedJpy})`);
  check(b.state === 'within', `state within (got ${b.state})`);
  const bSel = computeBudget(withProps, 'a001');
  check(
    bSel.proposedJpy === partyCostJpy(activityById.get('a001')!, DEMO_CONTEXT.party),
    `only the SELECTED candidate counts as proposed spend (got ¥${bSel.proposedJpy})`,
  );

  const booked = computeBudget(promoteToReserved(withProps, DEMO_CONTEXT.currentDate, 'a001'));
  check(booked.committedJpy === 11500 + partyCostJpy(activityById.get('a001')!, DEMO_CONTEXT.party), 'booking moves cost proposed → committed');
  check(booked.proposedJpy === 0, 'no proposed spend after booking');
}

// ── 4. Decision diff ─────────────────────────────────────────────────────
section('decision diff');
{
  const plan = seedPlan();
  const t1 = placeCandidates(['a001', 'a002', 'a012'], DEMO_CONTEXT, plan).placed;
  const t2 = placeCandidates(['a008', 'a001', 'a012'], DEMO_CONTEXT, plan).placed;
  const diff = computeDiff(
    { constraints: { quiet: 3, budget_jpy: 15000 }, candidates: ['a001', 'a002', 'a012'], proposed: t1 },
    { constraints: { quiet: 5, budget_jpy: 15000, budget_flexible: true }, candidates: ['a008', 'a001', 'a012'], proposed: t2 },
  );
  check(diff.constraintsChanged.some((c) => c.key === 'quiet' && c.from === 3 && c.to === 5), 'quiet 3 → 5 detected');
  check(diff.constraintsAdded.some((c) => c.key === 'budget_flexible'), 'budget_flexible added');
  check(JSON.stringify(diff.candidatesRemoved) === '["a002"]', 'a002 removed');
  check(JSON.stringify(diff.candidatesAdded) === '["a008"]', 'a008 added');
  check(diff.candidatesRetained.length === 2, 'two retained');
  check(diff.planItemsRemoved.length + diff.planItemsAdded.length + diff.planItemsChanged.length > 0, 'calendar visibly changes', JSON.stringify({ add: diff.planItemsAdded, rm: diff.planItemsRemoved }));
}

// ── 4b. 30-day horizon ───────────────────────────────────────────────────
section('horizon');
{
  const dates = horizonDates();
  check(dates.length === 31 && dates[0] === '2026-08-08' && dates[30] === '2026-09-07', '31 days, Aug 8 → Sep 7', `${dates[0]}..${dates[30]}`);
  const openCounts = dates.map((d) => activities.filter((a) => availabilityFor(a, d).status === 'available').length);
  check(Math.min(...openCounts) > 150, `every date has real availability (min ${Math.min(...openCounts)} open)`);
  check(dates.some((d) => activities.some((a) => availabilityFor(a, d).status === 'sold_out')), 'sold-out dates exist');
  check(activities.some((a) => a.availability.kind === 'weekends'), 'weekend-only patterns exist');
  check(activities.some((a) => a.availability.kind === 'weekdays'), 'weekday-only patterns exist');
  check(activities.some((a) => a.availability.kind === 'sparse'), 'sparse/irregular patterns exist');
  check(activities.some((a) => a.availability.times.length === 1), 'fixed-single-slot activities exist');
  const a001 = activityById.get('a001')!;
  check(dates.every((d) => availabilityFor(a001, d).status === 'available'), 'hero a001 open all 31 days (demo anchor)');
  const x = activities.find((a) => a.availability.kind === 'sparse')!;
  check(
    JSON.stringify(availabilityFor(x, '2026-08-20')) === JSON.stringify(availabilityFor(x, '2026-08-20')),
    'availability is a pure function (deterministic)',
  );
}

// ── 4c. Retrieval ────────────────────────────────────────────────────────
section('retrieval');
{
  const hint = "four hours before dinner raining eight-month-old local cultural 15000 nothing crowded tea craft";
  const plan = seedPlan();
  const r1 = retrieve(activities, hint, DEMO_CONTEXT, { infants: 1, budget_jpy: 15000 }, plan);
  const r2 = retrieve(activities, hint, DEMO_CONTEXT, { infants: 1, budget_jpy: 15000 }, plan);
  check(r1.rows.length >= 30 && r1.rows.length <= 64, `bounded: ${r1.rows.length} rows sent (not ${activities.length})`);
  check(JSON.stringify(r1.rows.map((a) => a.id)) === JSON.stringify(r2.rows.map((a) => a.id)), 'deterministic row set');
  const ids = new Set(r1.rows.map((a) => a.id));
  check(ids.has('a001') && ids.has('a012') && ids.has('a008'), 'canonical heroes survive retrieval');
  check(r1.stats.hardValid < r1.stats.catalogue, `hard-eligibility filters (${r1.stats.hardValid}/${r1.stats.catalogue} valid)`);
  const ineligibleSent = r1.rows.filter((a) => !r1.traces.find((t) => t.activityId === a.id)?.eligible);
  check(ineligibleSent.length > 0 && ineligibleSent.length <= 20, `near-miss exclusion fodder rides along (${ineligibleSent.length} incl. ineligible heroes)`);
  const cyclingTrace = r1.traces.find((t) => t.activityId === 'a004')!;
  check(!cyclingTrace.eligible && cyclingTrace.hardFailures.some((f) => f.includes('rain')), 'rain-cancelled cycling marked ineligible with the reason');
  check(r1.traces.every((t, i) => i === 0 || r1.traces[i - 1].scores.total >= t.scores.total), 'traces ranked by score');
}

// ── 4d. Calendar: moves ──────────────────────────────────────────────────
section('calendar moves');
{
  const plan0 = seedPlan();
  const { placed } = placeCandidates(['a001', 'a002', 'a012'], DEMO_CONTEXT, plan0);
  const plan = withProposals(plan0, DEMO_CONTEXT.currentDate, placed);

  const fixedMove = moveItem(plan, DEMO_CONTEXT, 'fixed-dinner', '2026-08-09');
  check(!fixedMove.ok && fixedMove.reason.includes('fixed'), 'fixed dinner cannot move', String((fixedMove as { reason?: string }).reason));

  const washiItem = plan.days[0].items.find((i) => i.activityId === 'a012')!;
  const mv = moveItem(plan, DEMO_CONTEXT, washiItem.id, '2026-08-09');
  check(mv.ok, 'proposed washi moves to tomorrow');
  if (mv.ok) {
    check(mv.plan.days.find((d) => d.date === '2026-08-09')!.items.some((i) => i.activityId === 'a012'), 'washi lands on Aug 9');
    check(!mv.plan.days[0].items.some((i) => i.activityId === 'a012'), 'washi left Aug 8');
    check(computeBudget(mv.plan).proposedJpy === computeBudget(plan).proposedJpy, 'moving days does not change trip total');
    check(!mv.rebooking, 'proposed move is not a rebooking');
  }

  const past = moveItem(plan, DEMO_CONTEXT, washiItem.id, '2026-08-01');
  check(!past.ok, 'cannot move outside horizon/past');

  const badTime = moveItem(plan, DEMO_CONTEXT, washiItem.id, '2026-08-09', '05:00');
  check(!badTime.ok, 'invalid slot time rejected', String((badTime as { reason?: string }).reason));

  const monthEdge = moveItem(plan, DEMO_CONTEXT, plan.days[0].items.find((i) => i.activityId === 'a001')!.id, '2026-09-01');
  check(monthEdge.ok, 'month-boundary move works (Sep 1)');

  const booked = promoteToReserved(plan, DEMO_CONTEXT.currentDate, 'a001');
  const reservedItem = booked.days[0].items.find((i) => i.activityId === 'a001')!;
  const rmv = moveItem(booked, DEMO_CONTEXT, reservedItem.id, '2026-08-10');
  check(rmv.ok && rmv.rebooking, 'reserved move works but is flagged as rebooking');
  if (rmv.ok)
    check(
      rmv.plan.days.find((d) => d.date === '2026-08-10')!.items.find((i) => i.activityId === 'a001')!.status === 'reserved',
      'reserved state survives the move',
    );

  // protected window: daily nap 13:00–15:00 blocks the 14:00 washi slot
  const nap = [{ recurrence: 'daily' as const, startTime: '13:00', endTime: '15:00', reason: 'Baby nap' }];
  const napPlace = placeCandidates(['a012'], DEMO_CONTEXT, plan0, DEMO_CONTEXT.currentDate, nap);
  check(!napPlace.placed.some((p) => p.startAt === '14:00'), 'protected nap window blocks the 14:00 slot', JSON.stringify(napPlace.placed.map((p) => p.startAt)));
}

// ── 4e. Budget v2 ────────────────────────────────────────────────────────
section('budget v2');
{
  const plan0 = seedPlan();
  const { placed } = placeCandidates(['a001', 'a012'], DEMO_CONTEXT, plan0);
  const plan = withProposals(plan0, DEMO_CONTEXT.currentDate, placed);
  const day = computeDayBudget(plan, DEMO_CONTEXT.currentDate);
  const trip = computeBudget(plan);
  check(day.committedJpy === 11500 && day.proposedJpy === trip.proposedJpy, 'day totals match trip on a one-day plan');

  const washiItem = plan.days[0].items.find((i) => i.activityId === 'a012')!;
  const mv = moveItem(plan, DEMO_CONTEXT, washiItem.id, '2026-08-09');
  if (mv.ok) {
    const d8 = computeDayBudget(mv.plan, '2026-08-08');
    const d9 = computeDayBudget(mv.plan, '2026-08-09');
    check(d8.proposedJpy + d9.proposedJpy === trip.proposedJpy, 'daily split sums to trip after a move');
  }

  const cleared = withProposals(plan, DEMO_CONTEXT.currentDate, []);
  check(computeBudget(cleared).proposedJpy === 0, 'removing proposals zeroes proposed spend');

  const replanned = withProposals(plan, DEMO_CONTEXT.currentDate, placeCandidates(['a001', 'a012'], DEMO_CONTEXT, plan0).placed);
  check(computeBudget(replanned).proposedJpy === trip.proposedJpy, 'no duplicated spend after re-plan');

  const firm = hardViolations(activityById.get('a003')!, DEMO_CONTEXT, { budget_jpy: 5000, infants: 0 }, plan0);
  const flex = hardViolations(activityById.get('a003')!, DEMO_CONTEXT, { budget_jpy: 5000, budget_flexible: true, infants: 0 }, plan0);
  check(firm.some((x) => x.includes('budget')) && !flex.some((x) => x.includes('budget')), 'firm vs flexible budget semantics');
}

// ── 4f. Party / price consistency (P0) ───────────────────────────────────
section('party pricing');
{
  const a001 = activityById.get('a001')!; // ¥6,500/adult, child half, infants free
  check(partyCostJpy(a001, { adults: 2 }) === 13000, 'two adults → ¥13,000');
  check(partyCostJpy(a001, { adults: 1 }) === 6500, 'one adult → ¥6,500');
  check(partyCostJpy(a001, { adults: 2, infants: 1 }) === 13000, 'two adults + infant → ¥13,000 (infant free)');
  check(
    partyCostJpy(a001, { adults: 2, children: 1 }) === 13000 + (a001.price.childJpy ?? a001.price.adultJpy),
    'children priced from childJpy',
  );

  // Store-level regression: "Actually it's just me." must converge party,
  // placement prices, budget, and the checkout amount — one source of truth.
  const plan0 = seedPlan();
  useStore.setState({
    stage: 'greet', language: 'en', tone: 'warm', busy: false, transcript: [], history: [],
    constraints: {}, candidates: [], excluded: [], selection: undefined, booking: undefined,
    context: DEMO_CONTEXT, party: DEMO_CONTEXT.party, plan: plan0, budget: computeBudget(plan0),
    budgetMode: 'flexible', selectedDate: DEMO_CONTEXT.currentDate,
    tripStart: DEMO_CONTEXT.currentDate, tripEnd: DEMO_TRIP_END,
    protectedWindows: [], lastTurn: null, showTrace: false, lastRetrieval: null,
  });
  const resp = (over: Partial<AgentResponse>): AgentResponse => ({
    reply: 'x', language: 'en', tone: 'neutral', stage: 'suggest',
    constraints: { adults: 2, infants: 1 }, candidates: ['a001', 'a002', 'a012'], excluded: [],
    ...over,
  });

  const placedSum = (x: ReturnType<typeof useStore.getState>) =>
    x.plan.days.flatMap((d) => d.items).filter((i) => i.status === 'proposed').reduce((n, i) => n + i.priceJpy, 0);
  useStore.getState().applyAgentResponse(resp({}));
  let st = useStore.getState();
  check(placedSum(st) === 24000, 'family placement priced ¥24,000 (2 adults + infant)', String(placedSum(st)));
  check(st.budget.proposedJpy === 0, 'unselected candidates carry no proposed spend', String(st.budget.proposedJpy));

  useStore.getState().applyAgentResponse(resp({ stage: 'revise', constraints: { adults: 1, infants: 0 } }));
  st = useStore.getState();
  check(st.party.adults === 1 && !(st.party.infants ?? 0), "party converges after \"it's just me\"", JSON.stringify(st.party));
  check(placedSum(st) === 12000, 'open proposals repriced to solo ¥12,000', String(placedSum(st)));
  check(partyCostJpy(a001, st.party) === 6500, 'checkout amount derives from the same party state');

  useStore.getState().applyAgentResponse(resp({ stage: 'confirm', candidates: [], selection: 'a001', constraints: { adults: 1, infants: 0 } }));
  useStore.getState().setBooking({ code: 'MCH-TEST', activityId: 'a001' });
  st = useStore.getState();
  const reserved = st.plan.days[0].items.find((i) => i.activityId === 'a001')!;
  check(reserved.status === 'reserved' && reserved.priceJpy === 6500, 'reservation charged at solo price', String(reserved.priceJpy));
  check(st.budget.committedJpy === 11500 + 6500, 'committed = dinner + solo booking', String(st.budget.committedJpy));
  check(st.budget.proposedJpy === 0, 'no phantom proposed spend after booking');
}

// ── 4g. Endpointing heuristics (P1) ──────────────────────────────────────
section('endpointing');
{
  check(endpointDelayMs('book that') === 450, 'clear command commits fast');
  check(endpointDelayMs('yes') === 450, '"yes" commits fast');
  check(endpointDelayMs('the first one') === 450, '"the first one" commits fast');
  check(endpointDelayMs('move it to monday') === 450, 'move command commits fast');
  check(endpointDelayMs('we want something cultural and') === 1500, 'trailing "and" earns patience');
  check(endpointDelayMs('maybe something quiet,') === 1500, 'trailing comma earns patience');
  check(endpointDelayMs('nothing too crowded because') === 1500, 'trailing "because" earns patience');
  check(endpointDelayMs('we have about four hours before dinner') === 800, 'normal utterance ~800ms');
  check(endpointDelayMs('') === 1500, 'no words yet → wait');
}


// Full store reset for section isolation.
function resetMichiStore() {
  const plan0 = seedPlan();
  useStore.setState({
    stage: 'greet', language: 'en', tone: 'warm', busy: false, transcript: [], history: [],
    constraints: {}, candidates: [], excluded: [], selection: undefined, booking: undefined,
    context: DEMO_CONTEXT, party: DEMO_CONTEXT.party, plan: plan0, budget: computeBudget(plan0),
    budgetMode: 'flexible', selectedDate: DEMO_CONTEXT.currentDate,
    tripStart: DEMO_CONTEXT.currentDate, tripEnd: DEMO_TRIP_END,
    protectedWindows: [], lastTurn: null, showTrace: false, lastRetrieval: null,
    savedIds: [], chats: [], activeChatId: null,
  });
}

// ── 4h. Saved (P0) ───────────────────────────────────────────────────────
section('saved');
{
  resetMichiStore();
  const before = { plan: JSON.stringify(useStore.getState().plan), budget: JSON.stringify(useStore.getState().budget) };
  useStore.getState().toggleSaved('a001');
  useStore.getState().toggleSaved('a005');
  let st = useStore.getState();
  check(st.savedIds.length === 2 && st.savedIds.includes('a001'), 'save adds to the collection');
  check(JSON.stringify(st.plan) === before.plan, 'saving never touches the calendar');
  check(JSON.stringify(st.budget) === before.budget, 'saving never touches the budget');
  useStore.getState().toggleSaved('a001');
  st = useStore.getState();
  check(!st.savedIds.includes('a001') && st.savedIds.includes('a005'), 'unsave removes only that item');
  const snap = snapshotState(useStore.getState());
  const back = restoreState(JSON.stringify(snap));
  check(!!back && back.savedIds.includes('a005'), 'saved state survives serialize→restore');
}

// ── 4i. Booking hardening (P0) ───────────────────────────────────────────
section('booking');
{
  resetMichiStore();
  const resp = (over: Partial<AgentResponse>): AgentResponse => ({
    reply: 'x', language: 'en', tone: 'neutral', stage: 'suggest',
    constraints: { adults: 2, infants: 1 }, candidates: ['a001', 'a002', 'a012'], excluded: [],
    ...over,
  });
  useStore.getState().applyAgentResponse(resp({}));
  useStore.getState().applyAgentResponse(resp({ stage: 'confirm', candidates: [], selection: 'a001' }));
  const checkoutAmount = partyCostJpy(activityById.get('a001')!, useStore.getState().party);
  useStore.getState().setBooking({ code: 'MCH-T1', activityId: 'a001' });
  let st = useStore.getState();
  const reservedItems = st.plan.days.flatMap((d) => d.items.filter((i) => i.status === 'reserved'));
  check(reservedItems.length === 1 && reservedItems[0].activityId === 'a001', 'proposed → reserved (exactly one)');
  check(reservedItems[0].priceJpy === checkoutAmount, 'checkout amount equals reservation amount');
  check(st.budget.committedJpy === 11500 + checkoutAmount, 'committed includes the booking');
  check(st.budget.proposedJpy === 0, 'proposed cleared on booking');

  // duplicate booking cannot double-charge or duplicate state
  const committedBefore = st.budget.committedJpy;
  useStore.getState().setBooking({ code: 'MCH-T2', activityId: 'a001' });
  st = useStore.getState();
  check(
    st.plan.days.flatMap((d) => d.items.filter((i) => i.status === 'reserved')).length === 1,
    'duplicate Reserve cannot double-book',
  );
  check(st.budget.committedJpy === committedBefore, 'duplicate Reserve cannot double-charge');
  check(st.booking?.code === 'MCH-T1', 'original booking code retained');

  // booking an unplaced-but-valid candidate goes through the engine
  resetMichiStore();
  useStore.getState().applyAgentResponse(resp({ stage: 'confirm', candidates: [], selection: 'a012' }));
  useStore.getState().setBooking({ code: 'MCH-T3', activityId: 'a012' });
  st = useStore.getState();
  const placedRes = st.plan.days.flatMap((d) => d.items.filter((i) => i.status === 'reserved' && i.activityId === 'a012'));
  check(placedRes.length === 1, 'unplaced candidate is engine-placed then reserved', JSON.stringify(placedRes.map((i) => i.startAt)));

  // refresh persistence of the reservation
  const snap = restoreState(JSON.stringify(snapshotState(useStore.getState())));
  check(
    !!snap && snap.plan.days.some((d) => d.items.some((i) => i.status === 'reserved' && i.activityId === 'a012')),
    'reservation survives serialize→restore',
  );
}

// ── 4j. Persistence (P0) ─────────────────────────────────────────────────
section('persistence');
{
  resetMichiStore();
  const resp = (over: Partial<AgentResponse>): AgentResponse => ({
    reply: 'x', language: 'en', tone: 'neutral', stage: 'suggest',
    constraints: { adults: 1, infants: 0, budget_jpy: 12000 }, candidates: ['a001', 'a012', 'a008'], excluded: [{ id: 'a006', reason: 'too loud for a nap' }],
    ...over,
  });
  useStore.getState().applyAgentResponse(resp({}));
  useStore.getState().setBudget(80000, 'firm');
  useStore.getState().toggleSaved('a005');
  useStore.getState().addEvent('2026-08-09', 'Train to Kamakura', '09:00', '10:00');
  useStore.getState().applyAgentResponse(resp({ stage: 'confirm', candidates: [], selection: 'a001' }));
  useStore.getState().setBooking({ code: 'MCH-P1', activityId: 'a001' });

  const raw = JSON.stringify(snapshotState(useStore.getState()));
  const back = restoreState(raw)!;
  check(!!back, 'round-trip parses');
  check(back.party.adults === 1, 'party (1 adult) survives');
  check(back.plan.totalBudgetJpy === 80000 && back.budgetMode === 'firm', 'custom firm budget survives');
  check(back.savedIds.includes('a005'), 'saved activity survives');
  check(back.plan.days.some((d) => d.items.some((i) => i.status === 'reserved' && i.activityId === 'a001')), 'reservation survives');
  check(back.plan.days[0].items.some((i) => i.id === 'fixed-dinner'), 'fixed dinner survives');
  check(back.plan.days.some((d) => d.date === '2026-08-09' && d.items.some((i) => i.title.includes('Kamakura'))), 'user fixed event survives');
  check(back.history.length > 0 && back.excluded.length > 0, 'conversation + Not right now survive');
  check(raw.length < 200000 && !/sk-ant-|xi-api-key|NGROK|PERXONA_/.test(raw), 'no secrets or bloat in the snapshot');

  // malformed data safely resets
  check(restoreState('{not json') === null, 'malformed JSON → null (fresh state)');
  check(restoreState(JSON.stringify({ version: 2 })) === null, 'wrong version → null');
  check(restoreState(JSON.stringify({ version: 1, plan: 'nope' })) === null, 'wrong shape → null');
  check(restoreState(null) === null, 'missing → null');
}

// ── 4k. New Chat ≠ New Trip (P0.5) ───────────────────────────────────────
section('new chat');
{
  resetMichiStore();
  const resp = (over: Partial<AgentResponse>): AgentResponse => ({
    reply: 'x', language: 'en', tone: 'neutral', stage: 'suggest',
    constraints: { adults: 2, infants: 1 }, candidates: ['a001', 'a002', 'a012'], excluded: [{ id: 'a006', reason: 'loud' }],
    ...over,
  });
  useStore.getState().addGuestTurn('We have four hours before dinner and the baby is asleep.');
  useStore.getState().applyAgentResponse(resp({}));
  useStore.getState().toggleSaved('a005');
  useStore.getState().applyAgentResponse(resp({ stage: 'confirm', candidates: [], selection: 'a001' }));
  useStore.getState().setBooking({ code: 'MCH-N1', activityId: 'a001' });
  const budgetBefore = useStore.getState().budget.committedJpy;

  useStore.getState().newChat();
  const st = useStore.getState();
  check(st.transcript.length === 0 && st.history.length === 0, 'conversation cleared');
  check(st.candidates.length === 0 && st.excluded.length === 0 && !st.selection, 'cards + Not right now + selection cleared');
  check(st.stage === 'greet' && st.lastTurn === null, 'stage + trace reset');
  check(st.party.adults === 2 && (st.party.infants ?? 0) === 1, 'party preserved');
  check(st.budget.committedJpy === budgetBefore, 'budget + reservations preserved');
  check(st.savedIds.includes('a005'), 'saved preserved');
  check(st.plan.days[0].items.some((i) => i.id === 'fixed-dinner'), 'calendar preserved');
  check(st.chats.length === 1 && st.chats[0].title.startsWith('We have four hours'), 'recent chat archived with utterance title');

  const archivedId = st.chats[0].id;
  useStore.getState().switchChat(archivedId);
  const st2 = useStore.getState();
  check(st2.history.length > 0 && st2.candidates.length === 3, 'switching back restores the thread');
  check(st2.budget.committedJpy === budgetBefore, 'trip unchanged across switch');
}

// ── 4l. Localization (P1) ────────────────────────────────────────────────
section('i18n');
{
  const locales = Object.keys(MESSAGES);
  check(JSON.stringify(locales.sort()) === JSON.stringify(['en', 'ja', 'zh-TW'].sort()), 'exactly en/ja/zh-TW');
  const enKeys = Object.keys(MESSAGES.en).sort();
  for (const loc of ['ja', 'zh-TW'] as const)
    check(JSON.stringify(Object.keys(MESSAGES[loc]).sort()) === JSON.stringify(enKeys), `${loc} dictionary complete (${enKeys.length} keys)`);
  const zh = MESSAGES['zh-TW'];
  check(zh.saved.includes('儲') && zh.bookings.includes('預約') && zh.prioritiesUpdated.includes('優先順序'), 'zh-TW uses Traditional forms (儲/預約/優先順序)');
  check(!/[简体优储预]/.test(JSON.stringify(zh)), 'no obvious Simplified-only characters in zh-TW');
  check(MESSAGES.ja.today === '今日' && MESSAGES.ja.saved === '保存済み', 'ja nav strings per spec');
  check(STT_LOCALE['zh-TW'] === 'zh-TW' && STT_LOCALE.ja === 'ja-JP' && STT_LOCALE.en === 'en-US', 'STT locale map per spec');
  check(SPEECH_LANG['zh-TW'] === 'zh', 'speech/wire code stays language-neutral zh');
  check(GREETINGS_CHECK['zh-TW'].includes('點') && !GREETINGS_CHECK['zh-TW'].includes('点'), 'zh-TW greeting is Traditional');
}

// ── 5. Mock agent: the full canonical demo, offline ──────────────────────
section('mock canonical demo');
{
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const say = async (text: string): Promise<AgentResponse> => {
    history.push({ role: 'user', content: text });
    const res = await mockAgentTurn(history);
    history.push({ role: 'assistant', content: JSON.stringify(res) });
    return res;
  };

  const t1 = await say("We have about four hours before dinner. It's raining and our eight-month-old is with us. We'd like something genuinely local and cultural, around ¥15,000. Nothing too crowded.");
  check(t1.stage === 'suggest' && t1.candidates.length === 3, 't1 suggests 3', t1.stage);
  check(t1.excluded.length >= 2, 't1 excludes 2');
  for (const id of t1.candidates)
    check(hardViolations(activityById.get(id)!, DEMO_CONTEXT, t1.constraints, seedPlan()).length === 0, `t1 ${id} passes hard rules`);

  const t2 = await say('Actually, the baby just fell asleep. Quiet matters more than the budget now.');
  check(t2.stage === 'revise' && t2.motion === 'correction', 't2 revises with correction motion');
  check(!t2.candidates.includes('a002') && t2.candidates.includes('a008'), 't2 drops wagashi, adds ukiyo-e');
  check((t2.constraints.quiet ?? 0) >= 5 && t2.constraints.budget_flexible === true, 't2 quiet↑ budget flexible');
  check(/wagashi/i.test(t2.reply), 't2 reply names the dropped activity');

  const t3 = await say('Book the new first choice.');
  check(t3.stage === 'confirm' && t3.selection === 'a008', 't3 confirms a008', t3.selection);

  const t4 = await say('Yes — please reserve it.');
  check(t4.stage === 'checkout', 't4 checkout');

  const t5 = await say('[system note: payment succeeded, booking code MCH-TEST00. Give a short farewell in the guest\'s language and set stage to "done".]');
  check(t5.stage === 'done', 't5 done');
}

// ── Listener policy: deterministic intent/emotion/ack classification ─────
section('listener policy');
{
  const p = new DeterministicListenerPolicy();
  const d = (text: string) => p.decide(text, 'en');

  let r = d('No, I meant Saturday.');
  check(r.intent === 'correction', 'correction intent', r.intent);
  check(r.ackCategory === 'correction' && r.motion === 'correction', 'correction ack + motion');

  r = d("Oh that's perfect!");
  check(r.intent === 'positive' && r.emotion === 'excited', 'positive + excited', `${r.intent}/${r.emotion}`);
  check(r.ackCategory === 'positive', 'positive ack shelf');

  r = d('Actually I only have 5,000 yen.');
  check(r.intent === 'constraint', "bare 'actually' + budget → constraint, not correction", r.intent);
  check(r.ackCategory === 'processing', 'constraint → processing ack');

  r = d('What time does it open?');
  check(r.intent === 'question' && r.emotion === 'curious', 'question + curious');

  r = d('Yes, book it.');
  check(r.intent === 'confirmation', 'confirmation intent', r.intent);

  r = d('Hmm, maybe...');
  check(r.intent === 'uncertain' && r.ackCategory === null, 'uncertain → NO ack (user still thinking)');

  r = d('Can we swap the tea ceremony for something else?');
  check(r.intent === 'revision' && r.motion === 'correction', 'revision + calming motion', r.intent);

  r = d('Tokyo.');
  check(r.ackCategory === null, 'tiny statement → no verbal ack');

  check(d('違う、土曜日のことだよ').intent === 'correction', 'ja correction');
  check(d('嗯，我看看，不確定').intent === 'uncertain', 'zh uncertain');
  check(d('予算は5000円しかないんです').intent === 'constraint', 'ja constraint');

  // Breathing: after two acked low-salience turns, the third goes silent —
  // but an emotionally salient turn still acks.
  const p2 = new DeterministicListenerPolicy();
  const roll = (text: string) => {
    const dec = p2.decide(text, 'en');
    p2.noteAckPlayed(dec.ackCategory !== null);
    return dec;
  };
  roll('We want something cultural this afternoon downtown.');
  const second = roll('We would prefer somewhere on the quieter side please.');
  check(second.ackCategory === null, 'second consecutive neutral ack goes silent');
  const salient = roll("No wait, that's not what I asked for.");
  check(salient.ackCategory === 'correction', 'salient ack still fires after silence');
}

// ── Phrase assembler: streamed reply → speakable phrases ─────────────────
section('phrase assembler');
{
  const a = new PhraseAssembler();
  const phrases: string[] = [];
  for (const delta of ['Yeah — quieter ', 'works. Let me swap', ' the taiko for the print studio, and keep the', ' teahouse for later. Sound good?']) {
    phrases.push(...a.push(delta));
  }
  const tail = a.flush();
  check(phrases.length >= 1 && phrases[0] === 'Yeah — quieter works.', 'first phrase cut at first sentence end', phrases[0]);
  const all = [...phrases, ...(tail ? [tail] : [])].join(' ');
  check(all.replace(/\s+/g, ' ') === 'Yeah — quieter works. Let me swap the taiko for the print studio, and keep the teahouse for later. Sound good?', 'no text lost or reordered', all);

  const b = new PhraseAssembler();
  const decimals = b.push('It runs about 3.5 hours total. Perfect for the afternoon. ');
  check(decimals.every((ph) => !/^5 hours/.test(ph)), 'decimal point never splits a phrase', JSON.stringify(decimals));

  const j = new PhraseAssembler();
  const ja = j.push('はい、かしこまりました。今日は雨ですので、屋内の体験を三つご提案しますね。');
  check(ja.length >= 1 && ja[0].endsWith('。'), 'CJK sentence enders cut phrases', JSON.stringify(ja));
}

// ── Reply stream extractor: speakable fields from partial JSON ───────────
section('reply stream extractor');
{
  const full = '{"language": "en", "tone": "warm", "reply": "Got it \\u2014 a quiet \\"local\\" plan.\\nGive me a second.", "stage": "suggest", "candidates": ["a001"]}';
  // adversarial chunking: 3-char pieces so escapes split across pushes
  const ex = new ReplyStreamExtractor();
  let reply = '';
  let lang = '';
  let tone = '';
  let done = false;
  for (let i = 0; i < full.length; i += 3) {
    const ev = ex.push(full.slice(i, i + 3));
    if (ev.language) lang = ev.language;
    if (ev.tone) tone = ev.tone;
    if (ev.replyDelta) reply += ev.replyDelta;
    if (ev.replyDone) done = true;
  }
  check(lang === 'en' && tone === 'warm', 'language + tone extracted before reply', `${lang}/${tone}`);
  check(reply === 'Got it — a quiet "local" plan.\nGive me a second.', 'reply decoded across split escapes', JSON.stringify(reply));
  check(done, 'reply close detected');

  const ex2 = new ReplyStreamExtractor();
  const ev2 = ex2.push('{"language": "ja", "tone": "thinking", "reply": "はい。');
  check(ev2.language === 'ja' && ev2.replyDelta === 'はい。', 'immediate partial reply extraction');
}

// ── Ack continuity: context weaving + duplicate-lead guard (P12/P13) ─────
section('ack continuity');
{
  // Context weaving: a trailing spoken ack earns a continue-from-here note.
  const woven = withAckContinuation([
    { role: 'user', content: 'Actually, I only have 3000 yen.' },
    { role: 'assistant', content: 'Ah, got it.' },
  ]);
  check(
    woven.length === 3 &&
      woven[2].role === 'user' &&
      woven[2].content.includes('"Ah, got it."') &&
      woven[2].content.startsWith('[system note:'),
    'trailing spoken ack → continuation note appended',
  );
  check(isSystemNote(woven[2]), 'continuation note is filtered from retrieval hints');

  const plain = withAckContinuation([{ role: 'user', content: 'Find me dinner.' }]);
  check(plain.length === 1, 'no trailing ack → history untouched');

  const jsonTail = withAckContinuation([
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: '{"reply":"…","stage":"suggest"}' },
  ]);
  check(jsonTail.length === 2, 'trailing JSON state turn is NOT treated as an ack');

  // Alternation: ack + JSON response are consecutive assistant turns in
  // stored history — the API mapping must merge them.
  const merged = mergeAlternating([
    { role: 'user', content: 'My cat died and I want somewhere peaceful.' },
    { role: 'assistant', content: "I'm really sorry to hear that." },
    { role: 'assistant', content: '{"reply":"Let\'s keep it quiet."}' },
    { role: 'user', content: 'thanks' },
  ]);
  check(
    merged.length === 3 &&
      merged[1].role === 'assistant' &&
      merged[1].content.startsWith("I'm really sorry to hear that.\n"),
    'consecutive assistant turns merge (roles stay alternating)',
  );

  // Acceptance case 1: budget revision. "Got it, …" must not play twice.
  const a1 = stripAckEcho("Got it, with a ¥3,000 budget we can still do well. I found three options.", 'Ah, got it.');
  check(a1.startsWith('with a ¥3,000 budget'), 'acceptance: "Got it," lead stripped after "Ah, got it." ack', a1);

  // Acceptance case 2: compassion. Paraphrased re-apology must be caught.
  const a2 = stripAckEcho("I'm sorry you're going through that. Let's keep things quiet and easy tonight. Here are three.", "I'm really sorry to hear that.");
  check(a2.startsWith("Let's keep things quiet"), 'acceptance: re-apology paraphrase stripped after compassion ack', a2);

  const kept = stripAckEcho('Tonight is doable, and quiet. I found three places.', 'Ah, got it.');
  check(kept.startsWith('Tonight is doable'), 'non-echo lead is untouched');
  check(stripAckEcho('Got it.', 'Got it.') === 'Got it.', 'whole-reply echo keeps the original (never speak nothing)');
  const noAck = stripAckEcho('Got it. Three places coming up.', null);
  check(noAck.startsWith('Got it.'), 'no ack spoken → natural "Got it." lead survives');
  const ja = stripAckEcho('承知しました。では静かな場所を三つご紹介しますね。', '承知しました。');
  check(ja.startsWith('では静かな'), 'ja: duplicated 承知しました stripped', ja);

  // Streaming guard: the first phrase can be a pure echo (swallowed), the
  // real content phrase must pass through untouched.
  const g = new AckEchoGuard('Ah, got it.');
  check(g.filter('Got it.') === '', 'stream: pure-echo first phrase swallowed');
  check(g.filter("Let's keep it under ¥3,000 then.") === "Let's keep it under ¥3,000 then.", 'stream: content phrase passes after swallowed echo');
  check(g.filter('Sure.') === 'Sure.', 'stream: guard disarms after content begins');
  const g2 = new AckEchoGuard('Okay, let me adjust that.');
  check(g2.filter("Sure — moving it to Monday frees the afternoon.") === 'moving it to Monday frees the afternoon.', 'stream: partial echo trimmed in place');
  const g3 = new AckEchoGuard(null);
  check(g3.filter('Got it. Three options.') === 'Got it. Three options.', 'stream: no ack → guard inert');

  // The spoken ack lands in BOTH the transcript and the model history.
  const st0 = useStore.getState();
  const before = { t: st0.transcript.length, h: st0.history.length };
  st0.addSpokenAck("I'm really sorry to hear that.");
  const st1 = useStore.getState();
  check(
    st1.transcript.length === before.t + 1 &&
      st1.history.length === before.h + 1 &&
      st1.history[st1.history.length - 1].role === 'assistant' &&
      st1.history[st1.history.length - 1].content === "I'm really sorry to hear that.",
    'addSpokenAck: transcript line + assistant history turn',
  );
}

// ── Affect: segmentation, salience, fusion (pure rules — the ML layer's
//    deterministic half; the models themselves run in harness/affect.ts) ──
section('affect rules');
{
  // Segmentation: contrast markers isolate emotional clauses.
  const segs = segmentUtterance(
    "My cat died yesterday, which has been awful, but my sister is visiting this weekend and I want somewhere fun.",
  );
  check(segs.length >= 2 && segs.some((s) => s.startsWith('but my sister')), 'EN contrast clause split at "but"', JSON.stringify(segs));
  const ja = segmentUtterance('猫が死んじゃって、本当に悲しい。でも妹が来るので楽しい場所に行きたい。');
  check(ja.length >= 2 && ja.some((s) => s.startsWith('でも')), 'JA でも clause isolated', JSON.stringify(ja));
  const jaInline = segmentUtterance('静かな場所がいいけど、でも予算は少ないです。');
  check(jaInline.length >= 2, 'JA mid-sentence でも split', JSON.stringify(jaInline));
  check(segmentUtterance('Find me dinner in Shinjuku.').length === 1, 'simple utterance stays one segment');
  check(segmentUtterance('').length === 0, 'empty input → no segments');

  // Salience: obligation ≠ intensity.
  const grief = scoreSegment('my cat died yesterday', { grief: 0.6, sadness: 0.3 });
  check(grief.socialResponse === 'compassion' && grief.salience >= 0.55, 'grief → compassion obligation', JSON.stringify(grief));
  const lossWeakModel = scoreSegment('our dog passed away last night', { neutral: 0.7, sadness: 0.15 });
  check(lossWeakModel.socialResponse === 'compassion' && lossWeakModel.salience >= 0.55, 'loss marker overrides a distracted model', JSON.stringify(lossWeakModel));
  check(hasLossMarker('うちの猫が亡くなった'), 'JA loss marker');
  const joy = scoreSegment('I just got promoted!', { joy: 0.5, excitement: 0.4, pride: 0.3 });
  check(joy.socialResponse === 'celebration', 'joy/pride → celebration', JSON.stringify(joy));
  check(scoreSegment('find me dinner', { neutral: 0.95 }).socialResponse === 'none', 'neutral → no obligation');

  // Fusion: mixed emotion never averages; loss outranks stronger joy.
  const mixed = fuseUtterance(
    [
      scoreSegment('my cat died yesterday', { grief: 0.5, sadness: 0.4 }),
      scoreSegment('but my sister visits and I want somewhere fun', { joy: 0.8, excitement: 0.6 }),
    ],
    undefined,
    {},
  );
  check(mixed.socialResponse === 'compassion', 'mixed: loss beats stronger positive emotion', JSON.stringify({ social: mixed.socialResponse, salience: mixed.salience }));
  check(mixed.taskTone === 'gently_positive', `mixed: task tone gently positive (got ${mixed.taskTone})`);

  // Audio interplay.
  const toneOnly = fuseUtterance(
    [scoreSegment('can you find somewhere quiet for me', { neutral: 0.8 })],
    { labels: { sad: 0.6, neu: 0.3 }, energy: 0.03, confidence: 0.6 },
    {},
  );
  check(toneOnly.socialResponse === 'warmth', 'tone-only sadness → warmth, never compassion', toneOnly.socialResponse);
  const damped = fuseUtterance(
    [scoreSegment("that's great, I'm so happy", { joy: 0.8, excitement: 0.5 })],
    { labels: { neu: 0.6, sad: 0.2, hap: 0.1 }, energy: 0.05, confidence: 0.6 },
    {},
  );
  check(damped.socialResponse !== 'celebration', 'flat voice damps text celebration', damped.socialResponse);

  // Decision overlay: routing beats keep their shelf; perception recolors.
  const statement: ListenerDecision = { intent: 'statement', emotion: 'neutral', ackCategory: 'neutral', mode: 'spoken', motion: null, confidence: 0.5 };
  const compassionRead = fuseUtterance([scoreSegment('my cat died', { grief: 0.7 })], undefined, {});
  const d1 = fuseListenerDecision(statement, compassionRead);
  check(d1.ackCategory === 'compassion' && d1.emotion === 'compassionate', 'strong grief re-shelves a statement to compassion');
  const weakRead = fuseUtterance([scoreSegment('somewhere quiet I guess', { sadness: 0.2, neutral: 0.6 })], undefined, {});
  const d2 = fuseListenerDecision(statement, weakRead);
  check(d2.ackCategory !== 'compassion' && d2.emotion !== 'compassionate', 'weak evidence under-reacts (no condolence)');
  const silent: ListenerDecision = { intent: 'uncertain', emotion: 'curious', ackCategory: null, mode: 'none', motion: null, confidence: 0.7 };
  const weakPositive = fuseUtterance([scoreSegment('nice I guess', { joy: 0.3, neutral: 0.5 })], undefined, {});
  check(fuseListenerDecision(silent, weakPositive).ackCategory === null, 'weak positive never breaks a deliberate silence');
  const correction: ListenerDecision = { intent: 'correction', emotion: 'concerned', ackCategory: 'correction', mode: 'nonverbal', motion: 'correction', confidence: 0.85 };
  const d3 = fuseListenerDecision(correction, compassionRead);
  check(d3.ackCategory === 'correction' && d3.emotion === 'compassionate', 'correction routing survives, delivery softens');
  check(fuseListenerDecision(statement, null) === statement, 'no affect read → rule decision untouched');

  // Only confident listener reads reach the planning model.
  check(listenerContextOf(compassionRead)?.socialResponse === 'compassion', 'strong read → listener context');
  check(listenerContextOf(weakRead) === null, 'weak read → no listener context');
  check(listenerContextOf(null) === null, 'no read → no listener context');
}

// ── Transcript uncertainty: STT output is observation, not truth ─────────
section('transcript uncertainty');
{
  const garbled = assessTranscript('Israel at the budget', 0.48);
  check(garbled.uncertain, 'low-confidence hearing is flagged');
  const criticalMid = assessTranscript('keep Wednesday under 5000 yen', 0.62);
  check(criticalMid.criticalSlots && criticalMid.uncertain, 'mid-confidence + money/date → uncertain');
  const criticalGood = assessTranscript('keep Wednesday under 5000 yen', 0.93);
  check(!criticalGood.uncertain, 'confident critical hearing passes');
  const casual = assessTranscript('somewhere fun would be nice', 0.62);
  check(!casual.uncertain, 'mid-confidence small talk is NOT nagged about');
  check(!assessTranscript('somewhere quiet please').uncertain, 'unreported confidence → benign default');

  // The listener must not assert understanding of a suspect hearing.
  const confirm: ListenerDecision = { intent: 'confirmation', emotion: 'warm', ackCategory: 'confirmation', mode: 'spoken', motion: null, confidence: 0.85 };
  const capped = capForUncertainTranscript(confirm, true);
  check(capped.ackCategory === 'processing' && capped.emotion === 'warm', 'uncertain: assertive ack → neutral hold');
  const neutral: ListenerDecision = { intent: 'statement', emotion: 'neutral', ackCategory: 'neutral', mode: 'spoken', motion: null, confidence: 0.5 };
  check(capForUncertainTranscript(neutral, true).ackCategory === 'neutral', 'uncertain: neutral ack passes through');
  check(capForUncertainTranscript(confirm, false) === confirm, 'certain transcript → untouched');

  // Rules-only fallback may never celebrate ("…would be great" ≠ great news).
  const positive: ListenerDecision = { intent: 'positive', emotion: 'happy', ackCategory: 'positive', motion: null, confidence: 0.8 };
  const degraded = fuseListenerDecision(positive, null);
  check(degraded.ackCategory === 'neutral' && degraded.emotion === 'neutral', 'no ML read → positive rules degrade to neutral');
}

// ── ContextBuilder: bounded prompt context (30 turns must not grow forever) ─
section('context builder');
{
  const json = (n: number, constraints = '{"adults":2}') =>
    `{"reply":"Here are three options for round ${n}.","language":"en","tone":"warm","stage":"suggest","constraints":${constraints},"candidates":["a001","a002","a003"],"excluded":[],"question":null,"motion":null,"plan_intent":null}`;
  const long: ChatTurn[] = [];
  for (let i = 0; i < 30; i++) {
    long.push({ role: 'user', content: `user turn ${i} with some words about plans` });
    long.push({ role: 'assistant', content: 'Okay.' });
    long.push({ role: 'assistant', content: json(i, i === 29 ? '{"adults":2,"budget_jpy":8000}' : '{"adults":2}') });
  }
  const window = buildTurnHistory(long);
  check(window.length <= 24, `window capped (${window.length} ≤ 24)`);
  check(historyBytes(window) < historyBytes(long) / 3, `size collapsed (${historyBytes(long)} → ${historyBytes(window)} chars)`);
  const lastJson = [...window].reverse().find((t) => t.content.trimStart().startsWith('{'));
  check(!!lastJson && lastJson.content.includes('"budget_jpy":8000'), 'latest JSON state turn survives verbatim');
  const olderJsonCount = window.filter((t) => t.content.trimStart().startsWith('{')).length;
  check(olderJsonCount === 1, `older JSON blobs reduced to spoken replies (${olderJsonCount} JSON turn in window)`);
  check(window.some((t) => t.content === 'Here are three options for round 28.'), 'reduced turns keep their spoken words');

  const short: ChatTurn[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: json(0) },
  ];
  check(buildTurnHistory(short).length === 2 && buildTurnHistory(short)[1].content === json(0), 'short history passes through, JSON intact');
}

// ── Speakable: what reaches the TTS voice must be sayable ────────────────
section('speakable');
{
  check(speakable('That runs about ¥15,000 for two.', 'en') === 'That runs about 15,000 yen for two.', 'en: ¥ becomes spoken yen', speakable('That runs about ¥15,000 for two.', 'en'));
  check(speakable('お二人で¥15,000ほどです。', 'ja') === 'お二人で15,000円ほどです。', 'ja: ¥ becomes 円');
  check(speakable('大約¥3,000。', 'zh') === '大約3,000日圓。', 'zh: ¥ becomes 日圓');
  check(speakable('The session on 2026-08-11 starts at 15:00.', 'en') === 'The session on August 11 starts at 3 pm.', 'en: ISO date + 24h time spoken', speakable('The session on 2026-08-11 starts at 15:00.', 'en'));
  check(speakable('Dinner is 18:00-19:30.', 'en') === 'Dinner is 6 pm to 7:30 pm.', 'en: time range gets a spoken connective', speakable('Dinner is 18:00-19:30.', 'en'));
  check(speakable('18:30開始です。', 'ja') === '18時30分開始です。', 'ja: 24h time → 時/分');
  check(speakable('Tea & wagashi', 'en') === 'Tea and wagashi', 'en: ampersand spoken');
  check(speakable("Let's keep tonight simple, quiet, and close by.", 'en') === "Let's keep tonight simple, quiet, and close by.", 'clean text passes through untouched');
  check(speakable('A 3.5 rating and 2,000 steps', 'en') === 'A 3.5 rating and 2,000 steps', 'plain numbers left alone');
}

// ── Motion variation: no robotic loops ───────────────────────────────────
section('motion selector');
{
  const sel = new MotionSelector();
  const picks = Array.from({ length: 6 }, () => sel.pick('listening')?.name ?? '(none)');
  const repeats = picks.filter((p, i) => i > 0 && p === picks[i - 1]).length;
  check(repeats === 0, 'consecutive listening picks never repeat', JSON.stringify(picks));
  const correctionPicks = new Set(Array.from({ length: 8 }, () => sel.pick('correction')?.name));
  check(correctionPicks.size >= 2, 'correction beat rotates through variants');
  const processing = Array.from({ length: 9 }, () => sel.pick('processing'));
  check(processing.some((p) => p === null) && processing.some((p) => p !== null), 'processing beat sometimes gestures, sometimes deliberately does not');
}

// ── Outing scope: the torture conversation (state lifetime/supersession) ──
section('outing scope (torture conversation)');
{
  const plan0 = seedPlan();
  useStore.setState({
    stage: 'greet', language: 'en', tone: 'warm', busy: false, transcript: [], history: [],
    constraints: {}, outingId: 0, constraintsMeta: {}, supersededConstraints: null,
    partyExplicit: false, knownEvents: [], candidates: [], excluded: [], selection: undefined,
    booking: undefined, context: DEMO_CONTEXT, party: DEMO_CONTEXT.party, plan: plan0,
    budget: computeBudget(plan0), budgetMode: 'flexible', selectedDate: DEMO_CONTEXT.currentDate,
    tripStart: DEMO_CONTEXT.currentDate, tripEnd: DEMO_TRIP_END,
    protectedWindows: [], lastTurn: null, showTrace: false, lastRetrieval: null,
  });
  const resp = (over: Partial<AgentResponse>): AgentResponse => ({
    reply: 'x', language: 'en', tone: 'neutral', stage: 'suggest',
    constraints: {}, candidates: ['a001', 'a002', 'a012'], excluded: [],
    ...over,
  });
  const st = () => useStore.getState();

  // Episode A: "three of us, four hours, something fun"
  useStore.getState().applyAgentResponse(resp({
    constraints: { adults: 3, time_available_minutes: 240, priorities: ['fun'] },
  }));
  check(st().constraints.adults === 3 && st().party.adults === 3, 'A: adults=3 active for THIS outing');
  check(st().partyExplicit, 'A: party explicitly stated');

  // Episode B: "sad, something calming, alone" — new outing
  useStore.getState().applyAgentResponse(resp({
    outing_change: true,
    constraints: { adults: 1, quiet: 5, crowd_tolerance: 1, energy: 'low', priorities: ['calm'] },
  }));
  check(st().outingId === 1 && st().constraints.quiet === 5 && st().party.adults === 1, 'B: fresh outing — calm/solo active');
  check(st().constraints.time_available_minutes === undefined, 'B: old 4-hour window did NOT leak in');
  check(st().supersededConstraints?.adults === 3, 'B: superseded set kept for debugging only');

  // Episode D: "sister visiting this weekend, somewhere fun" — new outing, party unstated
  useStore.getState().applyAgentResponse(resp({
    outing_change: true,
    constraints: { priorities: ['fun'] },
  }));
  check(
    st().constraints.quiet === undefined && st().constraints.crowd_tolerance === undefined && st().constraints.energy === undefined,
    'D: quiet/crowd/energy DIED with the solo outing (no stale contamination)',
  );
  check(st().constraints.adults === undefined && st().party.adults === DEMO_CONTEXT.party.adults, 'D: party reverts to trip default, not 3, not 1');
  check(!st().partyExplicit, 'D: party marked NOT explicitly stated (confirm before booking)');

  // Episode E: "I just got promoted — somewhere nice to celebrate" — same outing refined
  useStore.getState().applyAgentResponse(resp({
    constraints: { priorities: ['celebration', 'fun', 'nice'] },
  }));
  check(st().outingId === 2 && (st().constraints.priorities ?? []).includes('celebration'), 'E: celebration refines the SAME outing');
  check(st().constraints.quiet === undefined, 'E: still no calm ghost from two episodes ago');
  check(st().constraintsMeta.priorities?.outing === 2, 'E: provenance records outing #2 for priorities');
}

// ── Demo tools: full reset + checkout cancel ─────────────────────────────
section('demo tools');
{
  const st = () => useStore.getState();
  const plan0 = seedPlan();

  // Dirty the session the way running the booking demo does.
  useStore.setState({
    stage: 'done', transcript: [{ who: 'guest', text: 'book it' }],
    history: [{ role: 'user', content: 'book it' }],
    constraints: { adults: 4 }, knownEvents: [{ type: 'loss', summary: 'cat', fingerprint: ['cat'], outing: 0 }],
    candidates: ['a001'], excluded: [{ id: 'a002', reason: 'x' }], selection: 'a001',
    booking: { code: 'MCH-TEST01', activityId: 'a001' }, savedIds: ['a003'],
    plan: plan0, budget: computeBudget(plan0, 'a001'), protectedWindows: [],
  });

  st().resetDemo();
  check(st().stage === 'greet', 'resetDemo: back to greet');
  check(st().transcript.length === 0 && st().history.length === 0, 'resetDemo: conversation cleared');
  check(st().booking === undefined, 'resetDemo: booking cleared — newChat would have KEPT this');
  check(st().selection === undefined && st().candidates.length === 0, 'resetDemo: selection + candidates cleared');
  check(st().knownEvents.length === 0, 'resetDemo: emotional memory cleared (demo half 2 starts fresh)');
  check(st().savedIds.length === 0, 'resetDemo: saved items cleared');
  check(
    st().plan.days.every((d) => d.items.every((i) => i.status !== 'reserved')),
    'resetDemo: no reserved items survive into the next run',
  );

  // Cancelling checkout must not look like a booking to the next model turn.
  useStore.setState({ stage: 'checkout', candidates: ['a001', 'a002', 'a012'], history: [] });
  st().cancelCheckout();
  check(st().stage === 'suggest', 'cancelCheckout: returns to suggest when candidates are live');
  const note = st().history[st().history.length - 1];
  check(note?.role === 'user' && note.content.startsWith('[system note:'), 'cancelCheckout: leaves a system note');
  check(/NOTHING was reserved/.test(note?.content ?? ''), 'cancelCheckout: the note says nothing was booked');
  check(st().booking === undefined, 'cancelCheckout: no booking is created');

  useStore.setState({ stage: 'confirm', candidates: [], history: [] });
  st().cancelCheckout();
  check(st().stage === 'gather', 'cancelCheckout: falls back to gather with no candidates');

  useStore.setState({ stage: 'suggest', history: [] });
  st().cancelCheckout();
  check(st().stage === 'suggest' && st().history.length === 0, 'cancelCheckout: no-op outside confirm/checkout');
}

// ── Invariants: continuity, ack modes, memory hygiene ────────────────────
section('invariants');
{
  // Known emotional events are acknowledged ONCE — later references get a
  // continuity LINE (never silence, never a second first-time condolence).
  const compassion: ListenerDecision = { intent: 'statement', emotion: 'compassionate', ackCategory: 'compassion', mode: 'spoken', motion: 'compassion', confidence: 0.9 };
  const cont = applyEventContinuity(compassion, { loss: true });
  check(cont.ackCategory === 'continuity' && cont.mode === 'spoken' && cont.motion === 'compassion', 'known loss → spoken continuity, no re-condolence');
  check(cont.mode !== 'nonverbal', 'continuity never fires a comforting gesture into silence');
  check(applyEventContinuity(compassion, {}) === compassion, 'unknown loss → first-time condolence untouched');
  const congrats: ListenerDecision = { intent: 'positive', emotion: 'excited', ackCategory: 'celebration', mode: 'spoken', motion: 'celebration', confidence: 0.9 };
  check(applyEventContinuity(congrats, { celebration: true }).ackCategory === 'continuity', 'known celebration → no second "Congratulations!"');

  // A DIFFERENT loss is a different event — the failure this guard used to
  // have was silencing "my mom died" because a cat was already mourned.
  const catFp = [lossFingerprint('my cat died yesterday I want to do something calming')];
  check(
    applyEventContinuity(compassion, { loss: true, lossFingerprints: catFp }, 'my cat died yesterday but my girlfriend is coming over').ackCategory === 'continuity',
    'same loss referenced again → continuity',
  );
  check(
    applyEventContinuity(compassion, { loss: true, lossFingerprints: catFp }, 'my mom died but my girlfriend is coming over') === compassion,
    'a NEW loss → full condolence, not swallowed by the first one',
  );
  check(
    applyEventContinuity(compassion, { loss: true, lossFingerprints: catFp }, "I don't know man I'm just sad").ackCategory === 'continuity',
    'no new subject ("just sad") → continuity, not a re-condolence',
  );
  check(
    applyEventContinuity(compassion, { loss: true }, 'my mom died').ackCategory === 'continuity',
    'without fingerprints the old type-only behaviour still stands',
  );

  // Event memory: deduped per EVENT for losses, still capped.
  useStore.getState().addKnownEvent('loss', 'my cat died yesterday', lossFingerprint('my cat died yesterday'));
  useStore.getState().addKnownEvent('loss', 'my cat died, as I said', lossFingerprint('my cat died, as I said'));
  check(useStore.getState().knownEvents.filter((e) => e.type === 'loss').length === 1, 'the same loss twice → one event');
  useStore.getState().addKnownEvent('loss', 'my mom died too', lossFingerprint('my mom died too'));
  check(useStore.getState().knownEvents.filter((e) => e.type === 'loss').length === 2, 'a second, different loss → its own event');

  // Minor corrections do not require speech — a gesture is the ack.
  const pol = new DeterministicListenerPolicy();
  const corr = pol.decide("no wait, that's not what I meant", 'en');
  check(corr.mode === 'nonverbal' && corr.motion === 'correction', 'correction → nonverbal ack (nod-equivalent gesture)');
  const confirmD = pol.decide('yes, book it please', 'en');
  check(confirmD.mode === 'spoken', 'confirmation still speaks');

  // Candidate recommendations never consume committed budget.
  const plan = seedPlan();
  const { placed } = placeCandidates(['a001', 'a002', 'a012'], DEMO_CONTEXT, plan);
  const wp = withProposals(plan, DEMO_CONTEXT.currentDate, placed);
  check(computeBudget(wp).proposedJpy === 0 && computeBudget(wp).committedJpy === 11500, 'candidates: informational only');
  check(computeBudget(wp, 'a012').proposedJpy === partyCostJpy(activityById.get('a012')!, DEMO_CONTEXT.party), 'selection: proposed spend');
  const dayB = computeDayBudget(wp, DEMO_CONTEXT.currentDate);
  check(dayB.proposedJpy === 0, 'day budget follows the same candidate rule');

  // Ack library: no "Got it. Got it. Alright." loops across shelves.
  const fakeVoice: VoiceEngine = { synth: async () => new ArrayBuffer(4) } as VoiceEngine;
  const lib = new AcknowledgementLibrary();
  await lib.prewarm(fakeVoice, ['en']);
  const picks = Array.from({ length: 8 }, () => lib.pick('en', 'neutral')?.text ?? '(none)');
  const adjacentRepeats = picks.filter((p, i) => i > 0 && p === picks[i - 1]).length;
  check(adjacentRepeats === 0, 'no adjacent ack repeats', JSON.stringify(picks));
  const windows = picks.slice(0, 6).every((_, i) => i > 3 || new Set(picks.slice(i, i + 3)).size === 3);
  check(windows, 'any 3 consecutive neutral acks are all distinct', JSON.stringify(picks));
}

console.log(failed ? `\n\x1b[31m${failed} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failed ? 1 : 0);
