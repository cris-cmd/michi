import type { AgentResponse, ModelStage } from "./schema";
import type { ChatTurn } from "./client";

// Scripted agent for ?mockagent=1 (browser) / MOCK_AGENT=1 (harness) — the
// full canonical Michi demo with no API key and no network. Stage-aware: it
// reads its own previous stage out of the history instead of guessing from
// turn counts.
//
// The script: rainy Tokyo afternoon, two adults + sleeping-adjacent infant,
// four hours before a fixed 18:00 dinner.
//  t1 suggest  → a001 tea / a002 wagashi / a012 washi (excl. cycling, digital art)
//  t2 revise   → baby asleep, quiet > budget: drop a002, a008 ukiyo-e enters first
//  t3 confirm  → "book the new first choice" = a008
//  t4 checkout → then payment note → done

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lastStage(history: ChatTurn[]): ModelStage | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      try {
        return (JSON.parse(history[i].content) as AgentResponse).stage;
      } catch {
        continue; // plain-text spoken ack turn — keep looking for JSON state
      }
    }
  }
  return null;
}

export async function mockAgentTurn(history: ChatTurn[]): Promise<AgentResponse> {
  await delay(700);
  const userTurns = history.filter((t) => t.role === "user");
  const last = (userTurns[userTurns.length - 1]?.content ?? "").toLowerCase();
  const prev = lastStage(history);

  if (last.includes("payment succeeded")) {
    return base({
      reply:
        "You're booked — the studio will have everything ready at three. Enjoy the printing, and dinner after. Come tell me how the wave turned out.",
      tone: "delighted",
      stage: "done",
      candidates: ["a008", "a001", "a012"],
      selection: "a008",
    });
  }

  if (prev === "confirm" && /(yes|book|reserve|confirm|go ahead)/.test(last)) {
    return base({
      reply:
        "Wonderful. I just need a name, an email, and a card — the form is on your screen. This is a demo checkout, nothing real is charged.",
      tone: "warm",
      stage: "checkout",
      candidates: ["a008", "a001", "a012"],
      selection: "a008",
    });
  }

  if ((prev === "suggest" || prev === "revise") && /(book|first choice|that one|the first|take it)/.test(last)) {
    return base({
      reply:
        "The ukiyo-e woodblock studio at three o'clock — around fourteen thousand yen for the two of you, little one in free. Shall I book it?",
      tone: "warm",
      stage: "confirm",
      candidates: ["a008", "a001", "a012"],
      selection: "a008",
      constraints: { quiet: 5, budget_flexible: true },
    });
  }

  if (/\bmove\b|reschedule|shift/.test(last)) {
    // Conversational move — intent only; the deterministic engine validates.
    const toDate = /monday/.test(last) ? "2026-08-10" : /sunday/.test(last) ? "2026-08-09" : "2026-08-09";
    const title = /garden|stroll/.test(last)
      ? "Garden"
      : /print|ukiyo/.test(last)
        ? "Ukiyo-e"
        : /tea/.test(last)
          ? "Tea Ceremony"
          : "Washi";
    return base({
      reply: `Done — I'll shift the ${title.toLowerCase()} plan over. The calendar checks the slot first, so if it can't fit I'll tell you.`,
      tone: "warm",
      stage: "suggest", // stays at suggest: candidates persist, booking can follow
      plan_intent: { action: "move", move_title: title, move_to_date: toDate },
    });
  }

  if (/(tomorrow|sunday)/.test(last) && /(plan|morning|lunch|do\b)/.test(last)) {
    return base({
      reply:
        "Sunday morning, before lunch — nice and open. Three ideas: the Kiyosumi garden stroll at ten if the sky behaves, the depachika food-hall safari at eleven, or the wagashi workshop just after. I'm skipping the sumo morning practice — it needs day-ahead booking and strict silence isn't relaxing with a baby along.",
      tone: "warm",
      stage: "suggest",
      candidates: ["a005", "a009", "a002"],
      excluded: [
        { id: "a004", reason: "even dry, riverside cycling is twelve-plus — the baby rules it out any day" },
      ],
      plan_intent: { action: "propose", target_date: "2026-08-09" },
    });
  }

  if (/(asleep|quiet|nap|sleeping)/.test(last)) {
    return base({
      reply:
        "Then let's protect the nap. I'm dropping the wagashi workshop — it's a cheerful, noisy room, wrong for a sleeping baby. In its place, a four-table ukiyo-e printing studio in Yanesen: hushed, deeply local, and it fits at three before your dinner.",
      tone: "thinking",
      stage: "revise",
      motion: "correction",
      candidates: ["a008", "a001", "a012"],
      excluded: [
        { id: "a002", reason: "great fun awake — but it's a loud shared-table room and your baby just fell asleep" },
        { id: "a006", reason: "taiko drumming is the loudest hour in Tokyo; not while the little one naps" },
      ],
      constraints: { quiet: 5, budget_flexible: true },
    });
  }

  if (userTurns.length >= 1 && /(rain|hour|dinner|local|cultural|¥|yen|baby|old)/.test(last)) {
    return base({
      reply:
        "Rainy afternoon, baby along, four hours — lovely brief. Three indoor ideas, all fine with an infant: a private tea ceremony in a Yanaka townhouse, a lively wagashi sweets workshop in Asakusa, or pulling your own washi paper at a three-hundred-year-old shop in Nihonbashi. I ruled out riverside cycling — rides cancel in rain and it's twelve-plus anyway — and the digital art museum, which is wall-to-wall crowds with a stroller check.",
      tone: "warm",
      stage: "suggest",
      candidates: ["a001", "a002", "a012"],
      excluded: [
        { id: "a004", reason: "cancelled outright in today's rain — and riders must be twelve or older, so the baby rules it out twice" },
        { id: "a010", reason: "you asked for nothing crowded: timed entry sells out and it's the most mobbed room in Tokyo" },
      ],
    });
  }

  return base({
    reply:
      "Happy to help you fill the afternoon. How much time do you have, and what are you in the mood for — hands-on, food, something calm?",
    tone: "warm",
    stage: "gather",
    question: "time available and mood",
  });
}

function base(p: Partial<AgentResponse> & { reply: string }): AgentResponse {
  return {
    language: "en",
    tone: "neutral",
    stage: "gather",
    constraints: {
      adults: 2,
      infants: 1,
      budget_jpy: 15000,
      time_available_minutes: 240,
      quiet: 3,
      crowd_tolerance: 2,
      priorities: ["local", "cultural"],
    },
    candidates: [],
    excluded: [],
    ...p,
    // per-turn constraint overrides merge INTO the baseline, not over it
    ...(p.constraints ? { constraints: { ...baseConstraints, ...p.constraints } } : {}),
  };
}

const baseConstraints: AgentResponse["constraints"] = {
  adults: 2,
  infants: 1,
  budget_jpy: 15000,
  time_available_minutes: 240,
  quiet: 3,
  crowd_tolerance: 2,
  priorities: ["local", "cultural"],
};
