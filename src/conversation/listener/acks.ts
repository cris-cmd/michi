// Prerecorded acknowledgement library — replaces the flat FillerCache.
// Category-shelved lines, pre-synthesized through ElevenLabs so playing one
// costs zero network round trips. Every line is PHATIC ONLY: it may signal
// listening/processing/emotion but must never assert a fact the planning model
// hasn't verified ("that restaurant is open" is forbidden by construction).
//
// Prewarm strategy: synthesizing every category × language up front would be
// ~70 TTS calls, so we prewarm the ACTIVE language (plus en as fallback) at
// presenter-Ready, and other languages lazily on first switch.

import type { Lang, Tone, VoiceEngine } from "../../voice/types";
import type { AckCategory } from "./types";

type AckLines = Record<AckCategory, string[]>;

export const ACK_LINES: Record<Lang, AckLines> = {
  en: {
    neutral: ["Okay.", "Got it.", "Alright.", "Mm-hm."],
    processing: ["Hmm, let me think.", "Okay, let me check.", "One sec — let me look."],
    positive: ["Oh, great!", "Love that.", "Wonderful."],
    celebration: ["Oh, congratulations!", "That's amazing!", "Oh, how exciting!"],
    concerned: ["Ah, okay.", "Oh — I see.", "Yeah, that's frustrating.", "Hmm, got it."],
    compassion: ["I'm really sorry to hear that.", "Oh no — I'm so sorry.", "That sounds really hard."],
    correction: ["Ah, got it.", "Oh, okay.", "Right, my mistake."],
    revision: ["Sure.", "Okay, let me adjust that.", "Alright, let me rework it."],
    confirmation: ["Great.", "Perfect.", "Alright!"],
    curious: ["Good question.", "Hmm, let me see.", "Let me check that."],
    continuity: ["Of course.", "Right.", "Yeah, of course.", "Mm."],
  },
  ja: {
    neutral: ["はい。", "なるほど。", "うんうん。"],
    processing: ["ええと、ちょっと考えますね。", "少々お待ちを。", "確認しますね。"],
    positive: ["いいですね！", "素敵です。", "嬉しいです。"],
    celebration: ["おめでとうございます！", "すごいですね！", "わあ、楽しみですね！"],
    concerned: ["あ、なるほど。", "そうでしたか。", "それは困りますね。", "ふむ、わかりました。"],
    compassion: ["それはお辛いですね。", "大変でしたね…", "それは悲しいですね。"],
    correction: ["あ、失礼しました。", "なるほど、そういうことですね。", "了解です。"],
    revision: ["わかりました。", "では調整しますね。", "変えてみますね。"],
    confirmation: ["かしこまりました。", "いいですね。", "承知しました。"],
    curious: ["いい質問ですね。", "ええと、見てみますね。", "確認してみます。"],
    continuity: ["はい。", "もちろんです。", "うんうん。"],
  },
  zh: {
    neutral: ["好的。", "明白。", "嗯嗯。"],
    processing: ["嗯，我想一下。", "我看看喔。", "稍等，我查一下。"],
    positive: ["太好了！", "很棒喔。", "真不錯。"],
    celebration: ["恭喜你！", "太棒了！", "好期待喔！"],
    concerned: ["啊，了解。", "原來如此。", "這真的很讓人頭痛。", "嗯，明白了。"],
    compassion: ["真的很遺憾。", "辛苦你了。", "聽起來真的不容易。"],
    correction: ["啊，不好意思。", "喔，了解了。", "明白，我搞錯了。"],
    revision: ["好的。", "那我調整一下。", "我重新排一下。"],
    confirmation: ["好的！", "太好了。", "沒問題。"],
    curious: ["好問題。", "嗯，我看看。", "我查一下喔。"],
    continuity: ["嗯。", "當然。", "我明白。"],
  },
};

// Tone hint for synthesis so the clip's delivery matches its shelf.
const CATEGORY_TONE: Record<AckCategory, Tone> = {
  neutral: "neutral",
  processing: "thinking",
  positive: "delighted",
  celebration: "delighted",
  concerned: "apologetic",
  compassion: "apologetic",
  correction: "apologetic",
  revision: "neutral",
  confirmation: "warm",
  curious: "thinking",
  // Warm, not apologetic: the condolence already happened — this is the
  // "still here with you" beat, not a second first-time reaction.
  continuity: "warm",
};

export type AckClip = { text: string; buf: ArrayBuffer };

export class AcknowledgementLibrary {
  private clips = new Map<string, AckClip[]>(); // key: `${lang}:${category}`
  private lastIndex = new Map<string, number>();
  /** Last few SPOKEN texts across ALL shelves — "Got it." from the neutral
   *  shelf must also block "Got it." arriving via the correction shelf
   *  ("Got it. Got it. Alright." is the fastest way to sound like a bot). */
  private recentTexts: string[] = [];
  private warming = new Set<Lang>();

  /** Pre-synthesize one language's shelves. Serial per language (gentle on
   *  rate limits), languages in parallel. Failures leave gaps, never throw. */
  async prewarm(voice: VoiceEngine, langs: Lang[]): Promise<void> {
    await Promise.allSettled(langs.map((l) => this.warmLang(voice, l)));
  }

  private async warmLang(voice: VoiceEngine, lang: Lang): Promise<void> {
    if (this.warming.has(lang)) return;
    this.warming.add(lang);
    const shelves = ACK_LINES[lang] ?? ACK_LINES.en;
    for (const [category, lines] of Object.entries(shelves) as [AckCategory, string[]][]) {
      const key = `${lang}:${category}`;
      if (this.clips.has(key)) continue;
      const clips: AckClip[] = [];
      for (const text of lines) {
        try {
          clips.push({ text, buf: await voice.synth(text, lang, CATEGORY_TONE[category]) });
        } catch {
          break; // engine unhappy — keep what we have, don't hammer it
        }
      }
      if (clips.length) this.clips.set(key, clips);
    }
  }

  /** Called on language switch — warm the new language in the background. */
  ensureLanguage(voice: VoiceEngine, lang: Lang): void {
    if (!this.warming.has(lang)) void this.warmLang(voice, lang);
  }

  /** Random pick from a shelf, never the same clip twice in a row. Falls
   *  back to English, then to null (caller just stays silent). Returns a
   *  COPY of the buffer — decodeAudioData detaches what it's given. */
  pick(lang: Lang, category: AckCategory): AckClip | null {
    const clips = this.clips.get(`${lang}:${category}`) ?? this.clips.get(`en:${category}`);
    if (!clips || clips.length === 0) return null;
    const key = `${lang}:${category}`;
    const last = this.lastIndex.get(key) ?? -1;
    // Prefer clips whose text wasn't spoken in the last few acks (any
    // shelf); fall back to the whole shelf rather than going silent on an
    // emotionally salient beat.
    const fresh = clips
      .map((c, idx) => ({ c, idx }))
      .filter(({ c, idx }) => !this.recentTexts.includes(c.text) && !(clips.length > 1 && idx === last));
    const pool = fresh.length > 0 ? fresh : clips.map((c, idx) => ({ c, idx }));
    const picked = pool[Math.floor(Math.random() * pool.length)];
    this.lastIndex.set(key, picked.idx);
    this.recentTexts = [picked.c.text, ...this.recentTexts].slice(0, 3);
    return { text: picked.c.text, buf: picked.c.buf.slice(0) };
  }
}
