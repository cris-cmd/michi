/**
 * harness/run.ts — text-only replay of the Michi conversation loop.
 * No avatar, no speech, no browser.
 *
 *   npm run eval              # all scenarios (live API)
 *   npm run eval demo_path    # one
 *   npm run eval -- --verbose # print every reply
 *   MOCK_AGENT=1 npm run eval demo_path   # offline canonical demo
 *
 * Semantic checks come from the model contract; POSSIBILITY checks come from
 * the deterministic engine (src/plan/engine.ts) — the same code that owns
 * the calendar in the app rules on every candidate the model returns.
 */
import { distinctiveNameWords, runTurn } from '../src/agent/core';
import { activities, activityById } from '../src/data/activities';
import { DEMO_CONTEXT, seedPlan } from '../src/data/demoContext';
import { hardViolations, placeCandidates } from '../src/plan/engine';
import scenarios from './scenarios.json';

type Check = { pass: boolean; label: string; detail?: string };

const byId = activityById;
const verbose = process.argv.includes('--verbose');
const only = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];

// A reason is only worth having if it's relational: a concrete activity
// property tied to THIS traveler's situation. Bare-property reasons are the
// filter pretending to think.
const GENERIC =
  /^(too (loud|crowded|expensive|far|touristy)|bad weather( fit)?|not (quiet|available|possible|suitable)( enough)?|doesn'?t (match|fit)|wrong (time|place|fit)|closed|unavailable|no slots?)\.?$/i;
const RELATIONAL =
  /(rain|wet|weather|pour|baby|infant|month-old|asleep|nap|sleep|wake|stroller|quiet|loud|noise|racket|crowd|mob|packed|shared table|budget|yen|¥|\d{2}:\d{2}|hour|time|dinner|before|minimum age|\b(six|6|twelve|12|twenty|20)\b|wheelchair|stairs|far|travel|sold out|cancel|\b(you|your|her|him|she|he)\b)/i;

function checkTurn(res: any, expect: any, prev: any): Check[] {
  const c: Check[] = [];
  if (!expect) return c;

  const want = (k: string) => expect[k] !== undefined;
  const push = (pass: boolean, label: string, detail?: string) =>
    c.push({ pass, label, detail });

  if (want('stage')) {
    const ok = Array.isArray(expect.stage)
      ? expect.stage.includes(res.stage)
      : res.stage === expect.stage;
    push(ok, `stage=${expect.stage}`, `got ${res.stage}`);
  }

  if (want('candidateCount'))
    push(
      res.candidates?.length === expect.candidateCount,
      `${expect.candidateCount} candidates`,
      `got ${res.candidates?.length}`,
    );

  if (want('maxQuestions')) {
    const n = res.question ? 1 : 0;
    push(n <= expect.maxQuestions, `<=${expect.maxQuestions} questions`, `asked ${n}`);
  }

  if (want('constraints'))
    for (const [k, v] of Object.entries(expect.constraints))
      push(res.constraints?.[k] === v, `constraint ${k}=${v}`, `got ${res.constraints?.[k]}`);

  if (want('outingChange'))
    push(
      (res.outing_change === true) === expect.outingChange,
      `outing_change=${expect.outingChange}`,
      `got ${res.outing_change === true}`,
    );

  // Supersession: these keys must NOT appear in the response constraints —
  // a new outing may not inherit the old outing's hard filters.
  if (expect.constraintsAbsent)
    for (const k of expect.constraintsAbsent)
      push(res.constraints?.[k] === undefined, `constraint ${k} absent`, `got ${res.constraints?.[k]}`);

  if (want('constraintsMin'))
    for (const [k, v] of Object.entries(expect.constraintsMin))
      push(
        (res.constraints?.[k] ?? 0) >= (v as number),
        `constraint ${k}>=${v}`,
        `got ${res.constraints?.[k]}`,
      );

  // "budget matters less now" can surface as an explicit flag, a raised
  // number, or a dropped budget — all count as softened.
  if (expect.budgetSoftened) {
    const prevBudget = prev?.constraints?.budget_jpy ?? 0;
    const softened =
      res.constraints?.budget_flexible === true ||
      res.constraints?.budget_jpy == null ||
      (prevBudget > 0 && (res.constraints?.budget_jpy ?? 0) > prevBudget);
    push(softened, 'budget softened', JSON.stringify({ budget_jpy: res.constraints?.budget_jpy, flexible: res.constraints?.budget_flexible }));
  }

  if (want('excludedMin'))
    push(
      (res.excluded?.length ?? 0) >= expect.excludedMin,
      `>=${expect.excludedMin} excluded`,
      `got ${res.excluded?.length ?? 0}`,
    );

  if (expect.reasonsAreSpecific)
    for (const e of res.excluded ?? [])
      push(!GENERIC.test(e.reason.trim()), `reason for ${e.id} is specific`, e.reason);

  if (expect.reasonsAreRelational)
    for (const e of res.excluded ?? [])
      push(RELATIONAL.test(e.reason), `reason for ${e.id} is relational`, e.reason);

  // The wow-guard: every candidate must survive the deterministic engine —
  // no rain-cancelled picks in rain, no minimum-age violations, no blown
  // hard budget, no impossible schedule.
  if (expect.candidatesPassHardRules)
    for (const id of res.candidates ?? []) {
      const a = byId.get(id);
      if (!a) {
        push(false, `candidate ${id} exists`);
        continue;
      }
      const v = hardViolations(a, DEMO_CONTEXT, res.constraints ?? {}, seedPlan());
      push(v.length === 0, `candidate ${id} passes hard rules`, v.join('; '));
    }

  if (want('minPlaced')) {
    const { placed } = placeCandidates(res.candidates ?? [], DEMO_CONTEXT, seedPlan());
    push(
      placed.length >= expect.minPlaced,
      `>=${expect.minPlaced} candidates land on the calendar`,
      `placed ${placed.length}: ${placed.map((p) => `${p.title}@${p.startAt}`).join(', ')}`,
    );
  }

  if (expect.candidatesChanged)
    push(
      JSON.stringify(res.candidates) !== JSON.stringify(prev?.candidates),
      'candidate set changed',
      `${prev?.candidates} -> ${res.candidates}`,
    );

  // Revise must NAME what it dropped — match any distinctive word of a
  // dropped activity's name (generic words excluded).
  if (expect.replyNamesADroppedActivity) {
    const dropped = (prev?.candidates ?? []).filter(
      (id: string) => !res.candidates?.includes(id),
    );
    // Same tokenization as the runtime guard in agent/core.ts (shared
    // helper) — the eval and the guard can never drift apart.
    const named = dropped.some((id: string) =>
      distinctiveNameWords(byId.get(id)?.name ?? '').some((w: string) =>
        res.reply.toLowerCase().includes(w),
      ),
    );
    push(named, 'reply names a dropped activity', res.reply.slice(0, 140));
  }

  if (want('motion')) push(res.motion === expect.motion, `motion=${expect.motion}`, `got ${res.motion}`);

  if (want('replyMentions'))
    for (const term of expect.replyMentions)
      push(new RegExp(term, 'i').test(res.reply), `reply mentions "${term}"`, res.reply.slice(0, 120));

  if (expect.selectionSet) push(!!res.selection, 'selection set');
  if (expect.selectionInCandidates) {
    // confirm turns may legitimately return an empty candidates array —
    // judge the selection against the last non-empty set.
    const pool = res.candidates?.length ? res.candidates : (prev?.candidates ?? []);
    push(
      !!res.selection && pool.includes(res.selection),
      'selection is one of the candidates',
      `${res.selection} vs [${pool.join(',')}]`,
    );
  }

  return c;
}

async function main() {
  console.log(`catalogue: ${activities.length} activities`);
  let failed = 0;

  for (const s of (scenarios as any).scenarios) {
    if (only && s.id !== only) continue;
    console.log(`\n\x1b[1m${s.id}\x1b[0m  ${s.why}`);

    const history: any[] = [];
    let prev: any = null;

    for (const turn of s.turns) {
      // Report model latency on every turn; speech adds a separate hop.
      const t0 = Date.now();
      const res = await runTurn({ history, userText: turn.say });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      history.push({ role: 'user', content: turn.say }, { role: 'assistant', content: JSON.stringify(res) });

      console.log(`  \x1b[2m> ${turn.say}  (${secs}s)\x1b[0m`);
      if (verbose) console.log(`    ${res.reply}`);

      for (const c of checkTurn(res, turn.expect, prev)) {
        if (c.pass) console.log(`    \x1b[32m✓\x1b[0m ${c.label}`);
        else {
          failed++;
          console.log(`    \x1b[31m✗\x1b[0m ${c.label}${c.detail ? `  \x1b[2m${c.detail}\x1b[0m` : ''}`);
        }
      }
      prev = res;
    }
  }

  console.log(failed ? `\n\x1b[31m${failed} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
  process.exit(failed ? 1 : 0);
}

main();
