// The single response contract between the model and the app.
// One call per turn: the reply and the state update come from the same call.
// Michi edition: constraints carry situational priorities (quiet, budget
// flexibility, time window) on top of the party facts; candidates/excluded
// reference activity ids. The model expresses intent — deterministic code
// (src/plan/engine.ts) owns money, time, conflicts, and the calendar.

export type Tone = "neutral" | "warm" | "thinking" | "apologetic" | "delighted";
export type Language = "en" | "ja" | "zh";
export type ModelStage = "gather" | "suggest" | "revise" | "confirm" | "checkout" | "done";
// Exactly two motions, deliberately: a specified motion overrides the kit's
// default behaviour states, so tagging every turn would replace Behavior AI
// (the thing XRSPACE is proud of) with puppeteering.
export type MotionKind = "greeting" | "correction";

export type AgentResponse = {
  reply: string;
  language: Language;
  tone: Tone;
  stage: ModelStage;
  constraints: {
    adults?: number;
    children?: number;
    infants?: number;
    /** Preferred spend for the activities being discussed, JPY. */
    budget_jpy?: number;
    /** True when the guest has said budget matters less than something else. */
    budget_flexible?: boolean;
    /** Minutes the guest actually has right now. */
    time_available_minutes?: number;
    /** 1–5 priority weights, set only when the guest has expressed them. */
    quiet?: number;
    culture?: number;
    crowd_tolerance?: number;
    energy?: "low" | "medium" | "high";
    priorities?: string[];
  };
  candidates: string[]; // activity ids, exactly 3 when stage is suggest/revise
  excluded: { id: string; reason: string }[]; // the "Not right now" list
  selection?: string;
  question?: string; // the ONE thing still unknown
  motion?: MotionKind; // greeting or candidate-revision turns
  /** Multi-day intent: which date candidates target, or a move request.
   *  The app VALIDATES everything through the deterministic engine. */
  /** TRUE when the SUBJECT of planning changed (new companions, new date,
   *  new purpose — "solo calm evening" → "fun weekend with my sister").
   *  The app then treats `constraints` as the complete fresh set for the
   *  new outing; nothing merges forward from the old one. */
  outing_change?: boolean;
  plan_intent?: {
    action: "none" | "propose" | "move";
    target_date?: string; // ISO date
    move_activity_id?: string;
    move_title?: string;
    move_to_date?: string;
    move_to_time?: string;
  };
};

const TONES = new Set(["neutral", "warm", "thinking", "apologetic", "delighted"]);
const LANGS = new Set(["en", "ja", "zh"]);
const STAGES = new Set(["gather", "suggest", "revise", "confirm", "checkout", "done"]);
const ENERGY = new Set(["low", "medium", "high"]);

// JSON Schema for structured outputs (output_config.format). Structured
// outputs can't express "exactly 3 items", so the runtime guard enforces it.
// PROPERTY ORDER IS DELIBERATE: language and tone come BEFORE reply so the
// streaming path (agent/streamExtract.ts) knows the TTS language and the
// avatar emotion before the first reply words arrive.
export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    language: { type: "string", enum: ["en", "ja", "zh"] },
    tone: { type: "string", enum: ["neutral", "warm", "thinking", "apologetic", "delighted"] },
    reply: { type: "string", description: "What Michi says aloud. Plain speech, no markdown." },
    stage: { type: "string", enum: ["gather", "suggest", "revise", "confirm", "checkout", "done"] },
    constraints: {
      type: "object",
      properties: {
        adults: { type: ["integer", "null"] },
        children: { type: ["integer", "null"] },
        infants: { type: ["integer", "null"] },
        budget_jpy: { type: ["integer", "null"] },
        budget_flexible: { type: ["boolean", "null"] },
        time_available_minutes: { type: ["integer", "null"] },
        quiet: { type: ["integer", "null"], description: "1-5 priority, only when expressed" },
        culture: { type: ["integer", "null"] },
        crowd_tolerance: { type: ["integer", "null"] },
        energy: { enum: ["low", "medium", "high", null] },
        priorities: { type: ["array", "null"], items: { type: "string" } },
      },
      required: [
        "adults",
        "children",
        "infants",
        "budget_jpy",
        "budget_flexible",
        "time_available_minutes",
        "quiet",
        "culture",
        "crowd_tolerance",
        "energy",
        "priorities",
      ],
      additionalProperties: false,
    },
    candidates: {
      type: "array",
      items: { type: "string" },
      description: "Activity ids. Exactly 3 when stage is suggest or revise.",
    },
    excluded: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
    selection: { type: ["string", "null"] },
    question: { type: ["string", "null"] },
    motion: {
      enum: ["greeting", "correction", null],
      description:
        "null on almost every turn. 'greeting' only on your very first spoken reply; 'correction' only on a revise turn where you drop a candidate.",
    },
    outing_change: {
      type: "boolean",
      description:
        "TRUE when the planning SUBJECT changed (different companions, date, or purpose than the outing being discussed before). Constraints then start fresh: restate everything that still applies, omit what no longer does. FALSE while refining the same outing.",
    },
    plan_intent: {
      type: ["object", "null"],
      description:
        "Multi-day intent. action 'propose' + target_date when candidates are for a specific date; 'move' + move_* to relocate an existing calendar item; 'none'/null otherwise.",
      properties: {
        action: { type: "string", enum: ["none", "propose", "move"] },
        target_date: { type: ["string", "null"], description: "ISO date, e.g. 2026-08-09" },
        move_activity_id: { type: ["string", "null"] },
        move_title: { type: ["string", "null"] },
        move_to_date: { type: ["string", "null"] },
        move_to_time: { type: ["string", "null"], description: "HH:MM" },
      },
      required: ["action", "target_date", "move_activity_id", "move_title", "move_to_date", "move_to_time"],
      additionalProperties: false,
    },
  },
  required: [
    "reply",
    "language",
    "tone",
    "stage",
    "constraints",
    "candidates",
    "excluded",
    "selection",
    "question",
    "motion",
    "plan_intent",
  ],
  additionalProperties: false,
} as const;

/** Runtime guard. Returns an error string, or null if valid. */
export function validateAgentResponse(x: unknown, knownIds: Set<string>): string | null {
  if (typeof x !== "object" || x === null) return "response is not an object";
  const r = x as Record<string, unknown>;
  if (typeof r.reply !== "string" || r.reply.length === 0) return "missing reply";
  if (typeof r.language !== "string" || !LANGS.has(r.language)) return "bad language";
  if (typeof r.tone !== "string" || !TONES.has(r.tone)) return "bad tone";
  if (typeof r.stage !== "string" || !STAGES.has(r.stage)) return "bad stage";
  if (!Array.isArray(r.candidates)) return "candidates is not an array";
  if (!r.candidates.every((c) => typeof c === "string" && knownIds.has(c)))
    return "candidates contains unknown activity id";
  if ((r.stage === "suggest" || r.stage === "revise") && r.candidates.length !== 3)
    return `stage ${r.stage} requires exactly 3 candidates, got ${r.candidates.length}`;
  if (!Array.isArray(r.excluded)) return "excluded is not an array";
  for (const e of r.excluded as unknown[]) {
    if (typeof e !== "object" || e === null) return "excluded entry is not an object";
    const ee = e as Record<string, unknown>;
    if (typeof ee.id !== "string" || !knownIds.has(ee.id)) return "excluded has unknown id";
    if (typeof ee.reason !== "string") return "excluded missing reason";
  }
  if (r.selection != null && (typeof r.selection !== "string" || !knownIds.has(r.selection)))
    return "selection is not a known activity id";
  if (r.motion != null && r.motion !== "greeting" && r.motion !== "correction")
    return "bad motion";
  const pi = r.plan_intent as Record<string, unknown> | null | undefined;
  if (pi != null) {
    if (!["none", "propose", "move"].includes(pi.action as string)) return "bad plan_intent.action";
    for (const k of ["target_date", "move_to_date"])
      if (pi[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(pi[k] as string)) return `bad plan_intent.${k}`;
    if (pi.move_to_time != null && !/^\d{2}:\d{2}$/.test(pi.move_to_time as string))
      return "bad plan_intent.move_to_time";
  }
  const c = r.constraints as Record<string, unknown> | null;
  if (c && c.energy != null && !ENERGY.has(c.energy as string)) return "bad energy";
  return null;
}

/** Normalize nulls from structured output into clean optionals. */
export function normalizeAgentResponse(raw: Record<string, unknown>): AgentResponse {
  const c = (raw.constraints ?? {}) as Record<string, unknown>;
  const clean = <T,>(v: unknown): T | undefined => (v == null ? undefined : (v as T));
  return {
    reply: raw.reply as string,
    language: raw.language as Language,
    tone: raw.tone as Tone,
    stage: raw.stage as ModelStage,
    constraints: {
      adults: clean<number>(c.adults),
      children: clean<number>(c.children),
      infants: clean<number>(c.infants),
      budget_jpy: clean<number>(c.budget_jpy),
      budget_flexible: clean<boolean>(c.budget_flexible),
      time_available_minutes: clean<number>(c.time_available_minutes),
      quiet: clean<number>(c.quiet),
      culture: clean<number>(c.culture),
      crowd_tolerance: clean<number>(c.crowd_tolerance),
      energy: clean<"low" | "medium" | "high">(c.energy),
      priorities: clean<string[]>(c.priorities),
    },
    candidates: raw.candidates as string[],
    excluded: raw.excluded as { id: string; reason: string }[],
    selection: clean<string>(raw.selection),
    question: clean<string>(raw.question),
    motion: clean<MotionKind>(raw.motion),
    outing_change: raw.outing_change === true ? true : undefined,
    plan_intent: (() => {
      const pi = raw.plan_intent as Record<string, unknown> | null | undefined;
      if (pi == null) return undefined;
      return {
        action: pi.action as "none" | "propose" | "move",
        target_date: clean<string>(pi.target_date),
        move_activity_id: clean<string>(pi.move_activity_id),
        move_title: clean<string>(pi.move_title),
        move_to_date: clean<string>(pi.move_to_date),
        move_to_time: clean<string>(pi.move_to_time),
      };
    })(),
  };
}
