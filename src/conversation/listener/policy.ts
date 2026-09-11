// Deterministic listener policy — regex rules, no ML, no network. Classifies
// the utterance the moment the endpoint fires so the avatar can react in the
// same tick, before the planning model's first token. Swappable later for
// a small local classifier behind the same ListenerPolicy interface.
//
// Safety rule: the decision only ever selects PHATIC acknowledgements
// ("Got it", "Hmm, let me see") — never anything that asserts a fact the
// planning model has not verified. That property lives in the ack library lines,
// and this policy can only pick categories, not words.

import type { AckCategory, AckMode, ListenerDecision, ListenerEmotion, ListenerIntent, ListenerPolicy } from "./types";

type Rule = { intent: ListenerIntent; re: RegExp; confidence: number };

// Order matters: first match wins. Corrections outrank plain negatives
// ("no, I meant Saturday" is a correction, not a rejection); explicit
// requests to change something outrank the constraint they carry.
const RULES: Rule[] = [
  // correction — "that's not what I meant". A bare "actually" is NOT a
  // correction by itself ("actually I only have ¥5,000" is a constraint);
  // it only counts when paired with a negation/restatement.
  {
    intent: "correction",
    re: /^(no|nah|nope|wait|hold on|not that|that's not)\b|\b(i meant|i said|not what i)\b|^actually,? (no|i meant|i said|that's not|wait)\b|^(いや|違|ちが|そうじゃ|じゃなく|待って|あ、違)|^(不是|不對|等等|我是說|我說的是)/i,
    confidence: 0.85,
  },
  // revision — change/swap/move something already proposed
  {
    intent: "revision",
    re: /\b(instead|swap|change|switch|move|rather|different one|another one|other option|something else|make it)\b|(変えて|別の|他の|移して|移動|やっぱり)|([換改移]一?[個下]|別的|改成)/i,
    confidence: 0.8,
  },
  // confirmation — clear yes / book it
  {
    intent: "confirmation",
    re: /^(yes|yeah|yep|sure|ok(ay)?|confirm|go ahead|do it|perfect,? (book|do)|book (it|that|this)|that works|sounds good|let's (do|go with))\b|^(はい|うん|ええ|お願いします|それで(いい)?|そうしよう|予約して)|^(好的?|可以|沒問題|就這個|訂吧|好啊)/i,
    confidence: 0.85,
  },
  // positive reaction — delight, praise
  {
    intent: "positive",
    re: /\b(perfect|great|awesome|amazing|love (it|that)|wonderful|fantastic|excellent|nice|brilliant)\b|(完璧|最高|素敵|いいね|素晴らしい|楽しみ)|(太好了|完美|太棒|不錯|很好)/i,
    confidence: 0.8,
  },
  // negative — dislike/refusal without a correction shape
  {
    intent: "negative",
    re: /\b(don'?t (like|want)|not (a fan|really|interested)|hate|dislike|too (loud|expensive|far|crowded|much)|no thanks)\b|(嫌い|やめて|いらない|うるさ|高すぎ)|(不要|不喜歡|太吵|太貴|太遠)/i,
    confidence: 0.75,
  },
  // constraint — money/time/party limits
  {
    intent: "constraint",
    re: /(¥|\byen\b|\d[\d,]*\s*(yen|円|元|dollars?)|\bbudget\b|only have|no more than|at most|under \d|less than|by \d{1,2}(:\d{2})?\s*(am|pm)?|before \d|\d+\s*(minutes?|hours?|時間|分)|予算|しかない|までに)/i,
    confidence: 0.75,
  },
  // question — asking Michi something
  {
    intent: "question",
    re: /\?$|？$|^(what|where|when|which|who|how|why|can|could|would|should|do you|does|is there|are there)\b|(ですか|ますか|かな|どこ|なに|何|どう)[?？]?$|(嗎|呢|什麼|哪裡|怎麼)[?？]?$/i,
    confidence: 0.8,
  },
  // uncertain — hedging, thinking aloud
  {
    intent: "uncertain",
    re: /^(um+|uh+|hmm+|err+|maybe|i'?m not sure|not sure|i don'?t know|let me think)\b|(えっと|うーん|どうしよう|迷って)|(不知道|不確定|嗯+)/i,
    confidence: 0.7,
  },
];

const INTENT_EMOTION: Record<ListenerIntent, ListenerEmotion> = {
  statement: "neutral",
  question: "curious",
  confirmation: "warm",
  correction: "concerned",
  revision: "neutral",
  constraint: "warm",
  positive: "happy",
  negative: "concerned",
  uncertain: "curious",
};

const INTENT_ACK: Record<ListenerIntent, AckCategory | null> = {
  statement: "neutral",
  question: "curious",
  confirmation: "confirmation",
  correction: "correction",
  revision: "revision",
  constraint: "processing",
  positive: "positive",
  negative: "concerned",
  uncertain: null, // user is still thinking — jumping in with "Got it." reads wrong
};

// Excitement upgrade: strong positive with exclamation.
const EXCITED = /!|！/;

export class DeterministicListenerPolicy implements ListenerPolicy {
  /** Consecutive turns that played an ack — after 2, low-salience acks go
   *  silent for a turn so Michi doesn't chirp at every sentence. */
  private consecutiveAcks = 0;

  decide(text: string, _lang: string): ListenerDecision {
    const t = text.trim();
    let intent: ListenerIntent = "statement";
    let confidence = 0.5;
    for (const rule of RULES) {
      if (rule.re.test(t)) {
        intent = rule.intent;
        confidence = rule.confidence;
        break;
      }
    }

    let emotion = INTENT_EMOTION[intent];
    if (intent === "positive" && EXCITED.test(t)) emotion = "excited";

    let ackCategory = INTENT_ACK[intent];
    // Breathe: neutral acks get grating fastest — one is plenty before a
    // silent turn; processing ("let me check") earns a little more room.
    // Emotionally salient categories (positive, concerned, confirmation)
    // always ack — silence THERE reads as not listening.
    if (ackCategory === "neutral" && this.consecutiveAcks >= 1) ackCategory = null;
    if (ackCategory === "processing" && this.consecutiveAcks >= 2) ackCategory = null;
    // Very short plain statements ("Tokyo.") don't need a verbal ack either.
    if (ackCategory === "neutral" && t.length < 8) ackCategory = null;

    // Minor corrections don't need speech before the fixed answer — a small
    // settling gesture says "I heard you" and the reply starts sooner.
    const mode: AckMode =
      intent === "correction" ? "nonverbal" : ackCategory ? "spoken" : "none";

    return {
      intent,
      emotion,
      ackCategory,
      mode,
      // Directed gestures stay tied to beats: the settling gesture on the
      // revise/correction turn, the look-up beat on "let me check" — fired
      // immediately, not when the planning model replies. Affect fusion may add
      // compassion/celebration beats on top of this.)
      motion:
        intent === "correction" || intent === "revision"
          ? "correction"
          : ackCategory === "processing"
            ? "processing"
            : null,
      confidence,
    };
  }

  noteAckPlayed(played: boolean): void {
    this.consecutiveAcks = played ? this.consecutiveAcks + 1 : 0;
  }
}

export const listenerPolicy: ListenerPolicy = new DeterministicListenerPolicy();
