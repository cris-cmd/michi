// Text → something a TTS voice can actually SAY. The prompt tells Sonnet to
// write for the ear, but this is the deterministic safety net at the speech
// choke points (server /voice handler + browser speechSynthesis fallback):
// symbols like ¥ make ElevenLabs stumble ("yen sign fifteen thousand…"),
// ISO dates and 24-hour clock read as robot.
//
// The TRANSCRIPT keeps the original text — ¥15,000 looks right on screen;
// this only shapes what reaches the voice. Conservative by design: every
// rule is an unambiguous win; anything context-dependent (slashes, bare
// hyphens) is left alone. Pure + offline-tested (harness/deterministic.ts).

import type { Lang } from "./types";

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const YEN_WORD: Record<Lang, string> = { en: " yen", ja: "円", zh: "日圓" };

function twelveHour(h: number, m: number): string {
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function speakable(text: string, lang: Lang): string {
  let s = text;

  // Defensive markdown strip (the prompt already forbids it).
  s = s.replace(/[*_`#]+/g, "");

  // ¥15,000 / ¥ 15000 / 15000 JPY → "15,000 yen" (円 / 日圓 / 엔).
  const yen = YEN_WORD[lang] ?? YEN_WORD.en;
  s = s.replace(/[¥￥]\s?([\d,.]+)/g, (_, n: string) => `${n}${yen}`);
  s = s.replace(/([\d,.]+)\s?(?:JPY|jpy)\b/g, (_, n: string) => `${n}${yen}`);
  s = s.replace(/[¥￥]/g, lang === "en" ? "yen" : yen.trim());

  // ISO dates → spoken dates ("2026-08-11" → "August 11" / 「8月11日」).
  s = s.replace(/\b20\d\d-(\d\d)-(\d\d)\b/g, (m0, mm: string, dd: string) => {
    const m = Number(mm);
    const d = Number(dd);
    if (m < 1 || m > 12 || d < 1 || d > 31) return m0;
    if (lang === "ja" || lang === "zh") return `${m}月${d}日`;
    return `${MONTHS_EN[m - 1]} ${d}`;
  });

  // Time RANGES first ("18:00-19:30" / "18:00〜19:30") so the hyphen/tilde
  // becomes a spoken connective, then single 24-hour times.
  const timeRe = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
  const range = new RegExp(`${timeRe.source}\\s?[-–~〜]\\s?${timeRe.source}`, "g");
  const joiner = lang === "ja" ? "から" : lang === "zh" ? "到" : " to ";
  s = s.replace(range, (whole: string) => whole.replace(/\s?[-–~〜]\s?/, joiner));
  s = s.replace(new RegExp(timeRe.source, "g"), (_m0, hh: string, mm: string) => {
    const h = Number(hh);
    const m = Number(mm);
    if (lang === "ja") return m === 0 ? `${h}時` : `${h}時${m}分`;
    if (lang === "zh") return m === 0 ? `${h}點` : `${h}點${m}分`;
    return twelveHour(h, m);
  });

  if (lang === "en") s = s.replace(/\s&\s/g, " and ");

  return s.replace(/ {2,}/g, " ").trim();
}
