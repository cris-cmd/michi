// The voice pillar. One shape: text in, audio buffer out. The adapter feeds
// the buffer to presenter.presentWithAudio() (lip-sync + Motion Director) or
// falls back tier by tier — nothing outside construction ever branches on
// which engine it holds.

import type { Language, Tone } from "../agent/schema";

export type Lang = Language;
export type { Tone };

export interface VoiceEngine {
  /** previousText: the phrase synthesized just before this one — passed to
   *  the provider for prosodic continuity across per-phrase calls. */
  synth(text: string, lang: Lang, tone?: Tone, previousText?: string): Promise<ArrayBuffer>;
  /** false = engine is rate-limited/broken; skip it without paying the round trip. */
  readonly healthy?: boolean;
}
