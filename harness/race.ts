/**
 * harness/race.ts — P1 adversarial stale-turn test. No network, no browser.
 *
 *   npm run test:race
 *
 * Scenario (the nasty ordering): a delayed revise turn A is in flight when a
 * newer turn B begins. B resolves FIRST and commits; A resolves LAST — and a
 * last-writer-wins bug would let A clobber B. The gate must ensure only B
 * updates the store, advances stage, or reaches say()/present, and that A's
 * model call was aborted.
 */
import { executeUserTurn, type TurnAgent } from '../src/flow/turn';
import { useStore } from '../src/flow/store';
import type { AgentResponse } from '../src/agent/schema';
import type { AvatarAdapter } from '../src/avatar/adapter';
import { DEMO_CONTEXT, seedPlan } from '../src/data/demoContext';
import { computeBudget, placeCandidates } from '../src/plan/engine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(pass: boolean, label: string, detail?: string) {
  if (pass) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}

function response(reply: string, candidates: string[]): AgentResponse {
  return {
    reply,
    language: 'en',
    tone: 'thinking',
    stage: 'revise',
    constraints: { quiet: 5, budget_flexible: true },
    candidates,
    excluded: [{ id: 'a006', reason: 'taiko is the loudest hour in Tokyo; not while the baby naps' }],
  };
}

function resetStore() {
  const plan = seedPlan();
  useStore.setState({
    stage: 'suggest',
    language: 'en',
    tone: 'warm',
    busy: false,
    transcript: [],
    history: [
      { role: 'user', content: 'Rainy Tokyo afternoon with the baby, around 15000.' },
      { role: 'assistant', content: JSON.stringify(response('Three ideas.', ['a001', 'a002', 'a012'])) },
    ],
    constraints: {},
    candidates: ['a001', 'a002', 'a012'],
    excluded: [],
    selection: undefined,
    error: undefined,
    context: DEMO_CONTEXT,
    plan,
    budget: computeBudget(plan),
    lastDiff: null,
  });
}

type HarnessAdapter = Pick<AvatarAdapter, 'say' | 'caps' | 'playAcknowledgement'>;

function makeAdapter(sayLog: string[]): HarnessAdapter {
  return {
    caps: { speechIn: true, speechOut: true, emotion: true, lipsync: true, bargeIn: true },
    // say() is where synthesis/present/presentWithAudio hang off in the real
    // adapters — a stale turn must never reach it. (No beginUtterance on
    // purpose: the harness exercises the whole-reply path.)
    say: async (text: string) => {
      sayLog.push(text);
    },
    playAcknowledgement: () => null,
  };
}

const io = (adapter: HarnessAdapter, agent: TurnAgent) => ({
  adapter: adapter as AvatarAdapter,
  agent,
  openMic: () => {},
  closeMic: () => {},
  releaseBusy: () => {},
});

async function caseStaleResolvesLast() {
  console.log('\n\x1b[1mcase 1\x1b[0m  delayed turn A superseded by turn B; A resolves last');
  resetStore();
  const sayLog: string[] = [];
  const adapter = makeAdapter(sayLog);

  const A = response('Dropping the wagashi — quieter set.', ['a003', 'a001', 'a012']);
  const B = response('Protecting the nap — the printing studio leads now.', ['a008', 'a001', 'a012']);

  let signalA: AbortSignal | undefined;
  // Adversarial: A RESOLVES (with a valid response) even after being aborted
  // — a real fetch would reject, but a resolved stale result is the harder
  // case and must still be discarded.
  const agentA: TurnAgent = async (_h, opts) => {
    signalA = opts?.signal;
    await sleep(300);
    return A;
  };
  const agentB: TurnAgent = async () => {
    await sleep(80);
    return B;
  };

  const pA = executeUserTurn('make it quieter', io(adapter, agentA));
  await sleep(30);
  const pB = executeUserTurn('actually, cheaper please', io(adapter, agentB));
  const [rA, rB] = await Promise.all([pA, pB]);

  const s = useStore.getState();
  check(rA === 'stale', 'turn A reported stale', `got ${rA}`);
  check(rB === 'committed', 'turn B committed', `got ${rB}`);
  check(signalA?.aborted === true, "turn A's model call was aborted");
  check(
    JSON.stringify(s.candidates) === JSON.stringify(B.candidates),
    'store candidates are B (not A)',
    s.candidates.join(','),
  );
  check(s.stage === 'revise', 'stage advanced per B', s.stage);
  const assistants = s.history.filter((t) => t.role === 'assistant');
  const lastAssistant = JSON.parse(assistants[assistants.length - 1].content) as AgentResponse;
  check(assistants.length === 2, 'exactly one new assistant turn in history', `got ${assistants.length - 1} new`);
  check(lastAssistant.reply === B.reply, "history's new assistant turn is B");
  check(!JSON.stringify(s.history).includes(A.reply), "A's reply is nowhere in history");
  check(!s.transcript.some((t) => t.text === A.reply), "A's reply is nowhere in the transcript");
  check(JSON.stringify(sayLog) === JSON.stringify([B.reply]), 'say()/present received only B', sayLog.join(' | '));
  check(s.busy === false, 'busy cleared by B');
  // P1 for the calendar: a stale response must never mutate the plan — the
  // proposed items must be exactly B's deterministic placement.
  const expectedPlacement = placeCandidates(B.candidates, DEMO_CONTEXT, seedPlan())
    .placed.map((p) => p.activityId)
    .sort();
  const actualProposed = s.plan.days[0].items
    .filter((i) => i.status === 'proposed')
    .map((i) => i.activityId)
    .sort();
  check(
    JSON.stringify(actualProposed) === JSON.stringify(expectedPlacement),
    "calendar proposals are B's placement (stale A never touched the plan)",
    JSON.stringify({ actual: actualProposed, expected: expectedPlacement }),
  );
  check(
    s.plan.days[0].items.some((i) => i.id === 'fixed-dinner' && i.status === 'fixed'),
    'fixed dinner untouched through the race',
  );
  const guests = s.transcript.filter((t) => t.who === 'guest').map((t) => t.text);
  check(
    JSON.stringify(guests) === JSON.stringify(['make it quieter', 'actually, cheaper please']),
    'both guest utterances kept (the user really said both)',
  );
}

async function caseStaleAbortRejection() {
  console.log('\n\x1b[1mcase 2\x1b[0m  superseded turn rejects with AbortError — swallowed silently');
  resetStore();
  const sayLog: string[] = [];
  const adapter = makeAdapter(sayLog);

  const B = response('Fresh set.', ['a008', 'a001', 'a012']);
  // A behaves like a real aborted fetch: rejects once its signal fires.
  const agentA: TurnAgent = (_h, opts) =>
    new Promise((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      setTimeout(() => rej(new Error('should have aborted first')), 1000);
    });
  const agentB: TurnAgent = async () => {
    await sleep(40);
    return B;
  };

  const pA = executeUserTurn('slow one', io(adapter, agentA));
  await sleep(20);
  const pB = executeUserTurn('newer one', io(adapter, agentB));
  const [rA, rB] = await Promise.all([pA, pB]);

  const s = useStore.getState();
  check(rA === 'stale', 'aborted turn A reported stale (not error)', `got ${rA}`);
  check(rB === 'committed', 'turn B committed', `got ${rB}`);
  check(
    !s.transcript.some((t) => t.text.startsWith('Let me try that again')),
    'no recovery line spoken for the aborted turn',
  );
  check(s.error === undefined, 'no error banner from the aborted turn');
  check(JSON.stringify(sayLog) === JSON.stringify([B.reply]), 'say() received only B', sayLog.join(' | '));
}

async function main() {
  await caseStaleResolvesLast();
  await caseStaleAbortRejection();
  console.log(failed ? `\n\x1b[31m${failed} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
  process.exit(failed ? 1 : 0);
}

void main();
