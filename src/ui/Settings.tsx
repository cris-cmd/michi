import { useEffect, useRef, useState } from "react";
import { useSettings } from "../flow/settings";
import { LOCALES } from "../i18n";

// Reply language settings. The primary Text/Voice switch lives in the header.

const LANGS = LOCALES; // exactly EN | 日本語 | 繁體中文

export default function Settings() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const language = useSettings((s) => s.language);
  const setLanguage = useSettings((s) => s.setLanguage);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={panelRef} className="relative text-sm">
      <button
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-line bg-panel px-2 py-1 text-muted transition-colors hover:border-line-strong hover:text-text"
      >
        ⚙
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-panel p-4 shadow-lg">
          <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">Reply language</p>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {LANGS.map((l) => (
              <button
                key={l.value}
                onClick={() => setLanguage(l.value)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${
                  language === l.value
                    ? "border-accent bg-accent text-white"
                    : "border-line text-muted hover:border-line-strong hover:text-text"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-faint">
            Optional voice and avatar integrations are configured server-side.
          </p>
        </div>
      )}
    </div>
  );
}
