import { useState } from "react";
import { useStore } from "../flow/store";
import { computeDayBudget } from "../plan/engine";
import { activityById, priceLabel } from "../data/activities";
import { availabilityFor } from "../data/availability";
import { useSettings } from "../flow/settings";
import { t, type Locale } from "../i18n";

// Left rail: threads (new chat / recent), trip nav, Saved + Bookings
// (real surfaces), and the deterministic budget — engine-computed, never
// model-computed — user-editable with firm/flexible semantics.

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;
const PRESETS = [20000, 30000, 50000, 100000];

function BudgetEditor({ locale, onClose }: { locale: Locale; onClose: () => void }) {
  const budget = useStore((s) => s.budget);
  const budgetMode = useStore((s) => s.budgetMode);
  const setBudget = useStore((s) => s.setBudget);
  const [amount, setAmount] = useState(String(budget.totalBudgetJpy));
  const [mode, setMode] = useState<"flexible" | "firm">(budgetMode);

  const apply = (v: number, m: "flexible" | "firm") => {
    if (v >= 1000) {
      setBudget(v, m);
      onClose();
    }
  };

  return (
    <div className="fade-in mt-2 space-y-2.5 rounded-lg border border-line bg-panel p-3 text-xs shadow-md">
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
        className="w-full rounded border border-line px-2 py-1.5 font-mono outline-none focus:border-accent"
      />
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button key={p} onClick={() => setAmount(String(p))} className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent">
            ¥{p / 1000}k
          </button>
        ))}
      </div>
      <div className="flex gap-3">
        {(["flexible", "firm"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1.5">
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} />
            {t(locale, m)}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => apply(Number(amount), mode)} className="rounded bg-accent px-2.5 py-1 font-semibold text-white">
          {t(locale, "save")}
        </button>
        <button onClick={onClose} className="text-faint underline">
          {t(locale, "cancel")}
        </button>
      </div>
    </div>
  );
}

/** Saved + Bookings share one list-panel shell. */
function ListPanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-text/25" onClick={onClose}>
      <div
        className="fade-in max-h-[70vh] w-[430px] max-w-[92vw] overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">{title}</p>
          <button onClick={onClose} className="rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:text-text">
            ✕
          </button>
        </div>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

export default function Sidebar({ onPick }: { onPick?: (id: string) => void }) {
  const locale = useSettings((s) => s.language);
  const budget = useStore((s) => s.budget);
  const budgetMode = useStore((s) => s.budgetMode);
  const context = useStore((s) => s.context);
  const plan = useStore((s) => s.plan);
  const partyState = useStore((s) => s.party);
  const savedIds = useStore((s) => s.savedIds);
  const toggleSaved = useStore((s) => s.toggleSaved);
  const chats = useStore((s) => s.chats);
  const newChat = useStore((s) => s.newChat);
  const switchChat = useStore((s) => s.switchChat);
  const selectedDate = useStore((s) => s.selectedDate);
  const setSelectedDate = useStore((s) => s.setSelectedDate);
  const busy = useStore((s) => s.busy);
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<"saved" | "bookings" | null>(null);

  const today = computeDayBudget(plan, context.currentDate);
  const pct = Math.min(100, Math.round(((budget.committedJpy + budget.proposedJpy) / budget.totalBudgetJpy) * 100));
  const barColor = budget.state === "over" ? "bg-danger" : budget.state === "near" ? "bg-warn" : "bg-accent";

  const party = [
    `${partyState.adults} ${locale === "en" ? (partyState.adults === 1 ? "adult" : "adults") : locale === "ja" ? "大人" : "大人"}`,
    partyState.children ? `${partyState.children} ${locale === "en" ? "children" : locale === "ja" ? "子ども" : "兒童"}` : null,
    partyState.infants ? `${partyState.infants} ${locale === "en" ? "infant" : locale === "ja" ? "乳児" : "嬰兒"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const reserved = plan.days.flatMap((d) => d.items.filter((i) => i.status === "reserved").map((i) => ({ ...i, date: d.date })));

  const navBtn = (active: boolean) =>
    `w-full rounded-md px-2 py-1.5 text-left ${active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface"}`;

  return (
    <aside className="flex h-full flex-col gap-5 overflow-y-auto border-r border-line bg-panel px-4 py-5">
      <div>
        <button
          onClick={() => !busy && newChat()}
          disabled={busy}
          className="w-full rounded-lg border border-line px-2 py-1.5 text-left text-sm font-medium text-accent transition-colors hover:border-accent disabled:opacity-50"
        >
          {t(locale, "newChat")}
        </button>
        {chats.length > 0 && (
          <div className="mt-2 space-y-0.5">
            <p className="px-2 text-[10px] font-semibold tracking-wider text-faint uppercase">{t(locale, "recent")}</p>
            {chats.slice(0, 10).map((c) => (
              <button
                key={c.id}
                onClick={() => !busy && switchChat(c.id)}
                className="w-full truncate rounded-md px-2 py-1 text-left text-xs text-muted hover:bg-surface"
                title={c.title}
              >
                {c.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <nav className="space-y-0.5 border-t border-line pt-4 text-sm">
        <p className="mb-2 px-2 text-[11px] font-semibold tracking-wider text-faint uppercase">{t(locale, "trip")}</p>
        <button onClick={() => setSelectedDate(context.currentDate)} className={navBtn(selectedDate === context.currentDate && !panel)}>
          {t(locale, "today")}
        </button>
        <button onClick={() => setSelectedDate("2026-08-09")} className={navBtn(selectedDate === "2026-08-09" && !panel)}>
          {t(locale, "tomorrow")}
        </button>
        <button onClick={() => setPanel("saved")} className={navBtn(panel === "saved")}>
          {t(locale, "saved")} <span className="ml-1 text-faint">{savedIds.length}</span>
        </button>
        <button onClick={() => setPanel("bookings")} className={navBtn(panel === "bookings")}>
          {t(locale, "bookings")} <span className="ml-1 text-faint">{reserved.length}</span>
        </button>
      </nav>

      <div className="border-t border-line pt-4">
        <div className="flex items-baseline justify-between px-2">
          <p className="text-[11px] font-semibold tracking-wider text-faint uppercase">{t(locale, "budget")}</p>
          <button onClick={() => setEditing(!editing)} className="text-[11px] text-accent underline decoration-accent/40 hover:decoration-accent">
            {yen(budget.totalBudgetJpy)} · {t(locale, budgetMode)} ✎
          </button>
        </div>
        {editing && <BudgetEditor locale={locale} onClose={() => setEditing(false)} />}

        <div className="mt-3 space-y-3 px-2 text-sm">
          <div>
            <p className="mb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">{t(locale, "today")}</p>
            <div className="flex justify-between text-xs">
              <span className="text-muted">{yen(today.committedJpy)} {t(locale, "committed")}</span>
              <span className="text-accent">{yen(today.proposedJpy)} {t(locale, "proposed")}</span>
            </div>
          </div>
          <div>
            <p className="mb-1 text-[10px] font-semibold tracking-wider text-faint uppercase">{t(locale, "trip")}</p>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted">{t(locale, "committedCap")}</span>
                <span className="font-medium">{yen(budget.committedJpy)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">{t(locale, "proposedCap")}</span>
                <span className="font-medium text-accent">{yen(budget.proposedJpy)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between pt-0.5 text-xs">
                <span className="text-faint">
                  {yen(budget.committedJpy + budget.proposedJpy)} / {yen(budget.totalBudgetJpy)}
                </span>
                <span className={budget.state === "over" ? "font-medium text-danger" : "text-faint"}>
                  {budget.state === "over" ? `${yen(-budget.remainingJpy)} ${t(locale, "over")}` : `${yen(budget.remainingJpy)} ${t(locale, "left")}`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <p className="px-2 text-[11px] font-semibold tracking-wider text-faint uppercase">{t(locale, "context")}</p>
        <div className="mt-2 space-y-1 px-2 text-xs text-muted">
          <p>{party}</p>
          <p>
            {context.weather?.condition === "rain" ? "🌧" : context.weather?.condition}
            {context.weather?.temperatureC ? ` · ${context.weather.temperatureC}°C` : ""}
          </p>
        </div>
      </div>

      <p className="mt-auto px-2 text-[10px] leading-relaxed text-faint">{t(locale, "demoNote")}</p>

      {/* ── Saved panel ─────────────────────────────────────────────── */}
      {panel === "saved" && (
        <ListPanel title={`${t(locale, "saved")} (${savedIds.length})`} onClose={() => setPanel(null)}>
          {savedIds.length === 0 && <p className="text-sm text-faint">{t(locale, "noSaved")}</p>}
          {savedIds.map((id) => {
            const a = activityById.get(id);
            if (!a) return null;
            const avail = availabilityFor(a, selectedDate);
            return (
              <div key={id} className="rounded-lg border border-line p-3">
                <p className="text-sm font-medium">{a.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {a.area} · {priceLabel(a)} · {a.durationMinutes}min ·{" "}
                  {avail.status === "available"
                    ? avail.slots.map((sl) => sl.startAt).join("/")
                    : avail.status}
                </p>
                <div className="mt-2 flex gap-2">
                  {onPick && (
                    <button
                      onClick={() => {
                        setPanel(null);
                        onPick(id);
                      }}
                      className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
                    >
                      {t(locale, "planThis")}
                    </button>
                  )}
                  <button onClick={() => toggleSaved(id)} className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-danger">
                    {t(locale, "remove")}
                  </button>
                </div>
              </div>
            );
          })}
        </ListPanel>
      )}

      {/* ── Bookings panel ──────────────────────────────────────────── */}
      {panel === "bookings" && (
        <ListPanel title={`${t(locale, "bookings")} (${reserved.length})`} onClose={() => setPanel(null)}>
          {reserved.length === 0 && <p className="text-sm text-faint">{t(locale, "noBookings")}</p>}
          {reserved.map((r) => (
            <div key={r.id} className="rounded-lg border border-ok bg-ok-soft p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{r.title}</p>
                <span className="rounded-full bg-ok px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {t(locale, "reserved")}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {r.date} · {r.startAt}–{r.endAt} · {yen(r.priceJpy)}
              </p>
            </div>
          ))}
        </ListPanel>
      )}
    </aside>
  );
}
