// Server-side model orchestration, retrieval, and response validation.

import { anthropicProvider } from "./providers/anthropic";
import { openaiProvider } from "./providers/openai";
import type { Provider } from "./providers/types";
import { isSystemNote, mergeAlternating, withAckContinuation } from "./ackContext";
import { buildSystemPrompt, type PromptContext, type ReplyLang } from "./prompt";
import {
  RESPONSE_JSON_SCHEMA,
  normalizeAgentResponse,
  validateAgentResponse,
  type AgentResponse,
} from "./schema";
import { activities, activityById } from "../data/activities";
import { retrieve } from "../data/retrieval";
import { findSlot } from "../plan/engine";
import { fitPlanFrom } from "./prompt";
import { DEMO_CONTEXT, DEMO_TOTAL_BUDGET_JPY, DEMO_TRIP_END, seedPlan } from "../data/demoContext";
import { mockAgentTurn } from "./mockAgent";
import type { ChatTurn, ListenerContext, TranscriptHint } from "./client";

// tsconfig.app types are browser-restricted; process is reached structurally.
// vite.config.ts seeds these from .env into process.env — server process only.
const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const MODEL = ENV.MICHI_MODEL ?? "claude-sonnet-5";
const KNOWN_IDS = new Set(activityById.keys());

// Default prompt context = the canonical demo situation (harness + any
// caller that doesn't send one). The browser sends the live one per turn.
export function demoPromptContext(): PromptContext {
  const plan = seedPlan();
  return {
    context: DEMO_CONTEXT,
    fixedItems: plan.days.flatMap((d) =>
      d.items
        .filter((i) => i.status !== "proposed")
        .map((i) => ({ title: i.title, startAt: i.startAt, endAt: i.endAt, date: d.date })),
    ),
    totalBudgetJpy: DEMO_TOTAL_BUDGET_JPY,
    tripStart: DEMO_CONTEXT.currentDate,
    tripEnd: DEMO_TRIP_END,
  };
}

// Lower effort reduces time-to-first-token for this bounded ranking task.
// EFFORT remains as a compatibility alias for older local configurations.
const EFFORT =
  ((ENV.MICHI_EFFORT ?? ENV.EFFORT) as "low" | "medium" | "high" | undefined) ?? "low";

// Provider is inferred from the model id, so MICHI_MODEL alone switches
// vendors: `claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI. MICHI_PROVIDER
// overrides when a model name doesn't follow either convention.
function providerFor(model: string): Provider {
  const forced = ENV.MICHI_PROVIDER?.toLowerCase();
  if (forced === "openai") return openaiProvider;
  if (forced === "anthropic") return anthropicProvider;
  return /^(gpt-|o[1-9])/.test(model) ? openaiProvider : anthropicProvider;
}

// The retrieval layer: prefilter the catalogue on everything the guest has
// said, then build the system prompt from that subset. Memoized on the row
// id-set so the prompt stays byte-identical across turns (prompt caching);
// it only rebuilds when the guest's brief genuinely moves the region —
// costing one cache miss on that turn, then warm again. The memo lives in
// this Node process (dev server / harness), one instance per process.
let promptMemo: { key: string; prompt: string } | null = null;

function systemPromptFor(history: ChatTurn[], replyLang: ReplyLang, pc: PromptContext): string {
  const hint = history
    .filter((t) => t.role === "user" && !isSystemNote(t))
    .map((t) => t.content)
    .join(" ");
  // Local deterministic retrieval: hard eligibility + soft relevance narrow
  // 900+ activities to ~40-56 rows (plus near-miss exclusion fodder).
  const rows = retrieve(activities, hint, pc.context, {}, fitPlanFrom(pc), pc.context.currentDate).rows;
  // Language pin and trip context are part of the prompt, so they're part of
  // the key: changing either mid-conversation is one deliberate cache miss.
  const key = `${replyLang}|${JSON.stringify(pc)}|${rows.map((r) => r.id).join(",")}`;
  if (!promptMemo || promptMemo.key !== key) {
    promptMemo = { key, prompt: buildSystemPrompt(rows, replyLang, pc) };
  }
  return promptMemo.prompt;
}

// Haiku 4.5 rejects `output_config.effort` AND explicit thinking configs
// (it runs without thinking when the field is omitted — which is what we
// want). Opus/Sonnet 5 take both. Gate per model family so MICHI_MODEL can
// swap freely.
async function callOnce(
  history: ChatTurn[],
  replyLang: ReplyLang,
  pc: PromptContext,
  signal?: AbortSignal,
  onRawDelta?: (delta: string) => void,
): Promise<string> {
  return providerFor(MODEL)(
    {
      model: MODEL,
      system: systemPromptFor(history, replyLang, pc),
      // Merge keeps roles strictly alternating: stored history legitimately
      // holds consecutive assistant turns (spoken ack, then the JSON response).
      messages: mergeAlternating(history).map((t) => ({ role: t.role, content: t.content })),
      schemaName: "michi_response",
      schema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
      effort: EFFORT,
      thinkingDisabled: ENV.MICHI_THINKING === "disabled",
    },
    { signal, onRawDelta },
  );
}

// The values where a mishearing does real damage — an uncertain transcript
// may not change these without a confirmation question.
const CRITICAL_CONSTRAINTS = ["budget_jpy", "budget_flexible", "adults", "children", "infants"] as const;

/** The most recent validated response in history — baseline for the
 *  uncertain-transcript guard (constraints) and the revise guard
 *  (candidates). */
function lastResponseState(history: ChatTurn[]): {
  constraints: Record<string, unknown>;
  candidates: string[];
} {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role !== "assistant" || !t.content.trimStart().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(t.content) as {
        constraints?: Record<string, unknown>;
        candidates?: string[];
      };
      return {
        constraints: parsed.constraints ?? {},
        candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      };
    } catch {
      continue;
    }
  }
  return { constraints: {}, candidates: [] };
}

/** Distinctive tokens of an activity name for revise-narration matching —
 *  shared with harness/run.ts so the runtime guard and the eval check can
 *  never drift apart. ≥3 chars keeps short proper nouns ("Ozu"). */
const GENERIC_NAME_WORDS = new Set([
  "workshop", "studio", "atelier", "class", "session", "tour", "experience",
  "making", "private", "tokyo", "with", "walk", "visit",
  "gallery", "galleries", "the", "and", "for", "off", "day", "one",
]);
export function distinctiveNameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
}

type UncertainGuard = { confidence: number; prev: Record<string, unknown> };

function parseAndValidate(
  raw: string,
  pc: PromptContext,
  uncertain?: UncertainGuard,
  prevCandidates?: string[],
  finalAttempt = false,
): AgentResponse {
  // Structured outputs should return bare JSON; strip fences defensively anyway.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const err = validateAgentResponse(parsed, KNOWN_IDS);
  if (err) throw new Error(`invalid agent response: ${err}`);
  const response = normalizeAgentResponse(parsed);

  // Deterministic truth guard: TODAY's candidates must actually fit today's
  // calendar — the same findSlot the prompt's "today: fits/DOES-NOT-FIT"
  // column came from. A violation triggers the one-shot retry with the
  // offending ids named (models at low effort occasionally slip one in).
  const targetsToday =
    (response.stage === "suggest" || response.stage === "revise") &&
    (!response.plan_intent?.target_date || response.plan_intent.target_date === pc.context.currentDate);
  if (targetsToday) {
    const fitPlan = fitPlanFrom(pc);
    const misfits = response.candidates.filter((id) => {
      const a = activityById.get(id);
      return a && !findSlot(a, pc.context, fitPlan);
    });
    if (misfits.length > 0) {
      throw new Error(
        `invalid agent response: candidates [${misfits.join(", ")}] have no bookable slot today — propose only activities whose catalogue line says "today: fits"`,
      );
    }
  }

  // Uncertain-hearing guard: critical values may not silently change off a
  // transcript the STT engine itself flagged. Changing them is fine — but
  // only alongside a confirmation question the guest will hear.
  if (uncertain) {
    const constraints = (response.constraints ?? {}) as Record<string, unknown>;
    const changed = CRITICAL_CONSTRAINTS.filter(
      (f) => constraints[f] !== undefined && constraints[f] !== uncertain.prev[f],
    );
    if (changed.length > 0 && !response.question) {
      throw new Error(
        `invalid agent response: the transcript was flagged as possibly misheard (STT confidence ${uncertain.confidence.toFixed(2)}), yet [${changed.join(", ")}] changed without a confirmation question — restate what you heard as a "question" instead of committing it`,
      );
    }
  }

  // Visible-revision guard: the revise beat IS the product differentiator.
  // The set must actually change, and the reply must SPEAK the drop by name
  // (the guest hears which option disappeared) — measured ~50% compliance
  // from prompting alone at effort-low, so it's enforced like the slot
  // guard: violation → the one-shot retry with the reason named.
  if (response.stage === "revise" && prevCandidates && prevCandidates.length === 3) {
    const dropped = prevCandidates.filter((id) => !response.candidates.includes(id));
    if (dropped.length === 0) {
      throw new Error(
        "invalid agent response: a revise turn must visibly change the candidate set — re-rank and let at least the weakest previous pick give way to a sharper fit",
      );
    }
    const reply = response.reply.toLowerCase();
    const named = dropped.some((id) =>
      distinctiveNameWords(activityById.get(id)?.name ?? "").some((w) => reply.includes(w)),
    );
    if (!named) {
      const names = dropped.map((id) => activityById.get(id)?.name ?? id).join(" / ");
      // SOFT on the final attempt: the model sometimes paraphrases a name
      // ("the calligraphy session" for "Shodo with a Master") in a way token
      // matching can't see — a reply that misses the drop-name is a lesser
      // failure than killing the whole turn over style.
      if (!finalAttempt) {
        throw new Error(
          `invalid agent response: the revise reply must name the dropped activity out loud, using its actual name — say that "${names}" falls off and why, not only what came in`,
        );
      }
      console.warn(`[core] revise reply still doesn't literally name the drop ("${names}") — accepting the retry as-is`);
    }
  }
  return response;
}

/**
 * One call per turn. On a parse/guard failure, retries once with the raw
 * text appended and an instruction to return valid JSON only. On a second
 * failure, throws — the caller speaks a graceful recovery line and holds stage.
 *
 * With onRawDelta set, the first attempt streams: the caller receives the
 * structured-output JSON incrementally (extract the reply with
 * streamExtract.ts) while this function still returns the fully validated
 * response. The retry attempt is NEVER streamed — by then the reply may
 * already have been spoken, so only the validated state matters.
 */
/** Sensory context the planning model cannot get from the transcript.
 *  phrased as delivery guidance — the model must never diagnose the guest's
 *  feelings back at them off a classifier's opinion. */
function listenerNote(l: ListenerContext): string {
  const parts: string[] = [];
  if (l.socialResponse !== "none") parts.push(`the listener read this turn as a ${l.socialResponse} moment`);
  if (l.voiceSubdued) parts.push("the guest's VOICE sounded subdued/low-energy regardless of their words");
  const tone = { neutral: "neutral", warm: "warm", gently_positive: "warm and gently positive", upbeat: "upbeat", calm: "calm and low-pressure" }[l.taskTone];
  parts.push(`let the reply FEEL ${tone}`);
  return `[system note: ${parts.join("; ")}. Let this shape word choice and pacing only — do not name, diagnose, or ask about the guest's emotional state beyond what they said in words.]`;
}

export async function agentTurn(
  history: ChatTurn[],
  opts: {
    signal?: AbortSignal;
    language?: ReplyLang;
    promptContext?: PromptContext;
    listener?: ListenerContext;
    transcript?: TranscriptHint;
    /** Deterministic current-truth summary from the app (current outing
     *  constraints, party, known events) — supersedes anything different
     *  that the model might read out of older conversation turns. */
    state?: string;
    onRawDelta?: (delta: string) => void;
  } = {},
): Promise<AgentResponse> {
  if (ENV.MOCK_AGENT === "1") return mockAgentTurn(history);

  // A trailing spoken ack becomes an explicit continue-from-here note. Done
  // HERE (not in requestParams) so the validation-retry path inherits it.
  history = withAckContinuation(history);

  // The affect listener's confident read rides along the same way — the
  // guest's VOICE is invisible in the transcript, and the continuation's
  // feel (compassionate ack → gently positive plan) shouldn't be re-guessed.
  if (opts.listener) {
    history = [...history, { role: "user", content: listenerNote(opts.listener) }];
  }

  // Current truth beats archaeology: the app's deterministic state summary
  // rides as a note so the model never treats a superseded constraint from
  // an old turn as still active.
  if (opts.state) {
    history = [
      ...history,
      {
        role: "user",
        content: `[system note: deterministic app state, authoritative RIGHT NOW — anything different in earlier messages is superseded: ${opts.state}]`,
      },
    ];
  }

  // A suspect STT hearing rides along too; the guard in parseAndValidate
  // enforces confirm-before-committing for critical values.
  const prevState = lastResponseState(history);
  const uncertainGuard: UncertainGuard | undefined = opts.transcript
    ? { confidence: opts.transcript.confidence, prev: prevState.constraints }
    : undefined;
  if (opts.transcript) {
    history = [
      ...history,
      {
        role: "user",
        content: `[system note: the speech-to-text engine flagged the guest's last utterance as possibly misheard (confidence ${opts.transcript.confidence.toFixed(2)}). If any money, date, time, party-size or place detail in it reads garbled or contextually surprising, ask the guest to confirm what they meant instead of acting on it.]`,
      },
    ];
  }

  // English is the working default; the browser sends the gear-panel setting.
  const replyLang = opts.language ?? "en";
  const pc = opts.promptContext ?? demoPromptContext();
  const raw = await callOnce(history, replyLang, pc, opts.signal, opts.onRawDelta);
  try {
    return parseAndValidate(raw, pc, uncertainGuard, prevState.candidates);
  } catch (firstError) {
    const retryHistory: ChatTurn[] = [
      ...history,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `[system note: your last message failed validation (${String(
          firstError,
        )}). Respond again with ONLY a valid JSON object matching the required schema — same intent, corrected format.]`,
      },
    ];
    const retryRaw = await callOnce(retryHistory, replyLang, pc, opts.signal);
    return parseAndValidate(retryRaw, pc, uncertainGuard, prevState.candidates, true); // final attempt: naming goes soft, structure stays hard
  }
}

/**
 * Harness entry point (harness/run.ts): same loop, explicit user text,
 * caller owns the history. Defaults to the canonical demo context.
 */
export async function runTurn(opts: {
  history: ChatTurn[];
  userText: string;
  signal?: AbortSignal;
  language?: ReplyLang;
  promptContext?: PromptContext;
}): Promise<AgentResponse> {
  return agentTurn([...opts.history, { role: "user", content: opts.userText }], {
    signal: opts.signal,
    language: opts.language,
    promptContext: opts.promptContext,
  });
}
