// User-facing language and interface settings, persisted to localStorage.

import { create } from "zustand";
import type { Locale } from "../i18n";

export type LangSetting = Locale; // exactly en | ja | zh-TW
export type UiMode = "text" | "voice";

type SettingsState = {
  language: LangSetting;
  uiMode: UiMode;
  setLanguage: (l: LangSetting) => void;
  setUiMode: (m: UiMode) => void;
};

const KEY = "michi-settings";

type Persisted = { language: LangSetting; uiMode: UiMode };

function load(): Persisted {
  // Voice-first: Michi IS the product — the avatar conversation is the
  // primary surface, the travel dashboard supports it. (Persisted choice
  // still wins; only the first-run default changed.)
  const defaults: Persisted = { language: "en", uiMode: "voice" };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      language:
        p.language === "ja" || p.language === "zh-TW"
          ? p.language
          : (p.language as string) === "zh" // migrate pre-locale value
            ? "zh-TW"
            : defaults.language,
      uiMode: p.uiMode === "text" ? "text" : "voice",
    };
  } catch {
    return defaults;
  }
}

function persist(s: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode etc. — settings just don't survive reload
  }
}

const snap = (s: SettingsState): Persisted => ({
  language: s.language,
  uiMode: s.uiMode,
});

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  setLanguage: (language) => {
    set({ language });
    persist(snap(get()));
  },
  setUiMode: (uiMode) => {
    set({ uiMode });
    persist(snap(get()));
  },
}));
