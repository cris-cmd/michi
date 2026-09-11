import { useMemo, useState } from "react";
import { useStore } from "../flow/store";
import { computeDayBudget, toMin } from "../plan/engine";
import { activityById } from "../data/activities";
import { addDays, availabilityFor, horizonDates, weekday } from "../data/availability";
import type { PlanItem } from "../plan/types";
import { useSettings } from "../flow/settings";
import { t, INTL_LOCALE, type Locale } from "../i18n";

// The planning surface: a 30-day date strip + the selected day's timeline.
// Solid = fixed/reserved (immovable by the model — the engine guarantees it),
// dashed = proposed by Michi. Every move — click-to-move here or a spoken
// request — runs through the same deterministic engine (store.requestMove).

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function statusStyle(locale: Locale): Record<string, { card: string; badge: string; label: string }> {
  return {
    fixed: { card: "border-line-strong bg-surface", badge: "bg-line text-muted", label: `🔒 ${t(locale, "fixedTag")}` },
    reserved: { card: "border-ok bg-ok-soft", badge: "bg-ok text-white", label: t(locale, "reserved") },
    proposed: {
      card: "border-dashed border-accent/50 bg-accent-soft/40",
      badge: "bg-accent-soft text-accent",
      label: t(locale, "proposedTag"),
    },
  };
}

function MovePanel({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const requestMove = useStore((s) => s.requestMove);
  const context = useStore((s) => s.context);
  const locale = useSettings((s) => s.language);
  const [error, setError] = useState<string | null>(null);
  const a = item.activityId ? activityById.get(item.activityId) : undefined;

  // Next 7 candidate days with a valid slot preview for activities.
  const options = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(context.currentDate, i)).map((date) => {
      const av = a ? availabilityFor(a, date) : null;
      return { date, slots: av?.status === "available" ? av.slots.map((s) => s.startAt) : [] };
    });
  }, [a, context.currentDate]);

  const tryMove = (date: string, time?: string) => {
    const res = requestMove(item.id, date, time);
    if (res.ok) onClose();
    else setError(res.reason);
  };

  return (
    <div className="fade-in mt-2 rounded-lg border border-line bg-panel p-3 text-xs shadow-md">
      <p className="mb-2 font-semibold">
        {t(locale, "moveLabel")}: {item.title}
        {item.status === "reserved" && (
          <span className="ml-1 font-normal text-warn">
            ({locale === "en" ? "rebooking" : locale === "ja" ? "再予約" : "重新預約"})
          </span>
        )}
      </p>
      <div className="space-y-1.5">
        {options.map(({ date, slots }) => (
          <div key={date} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-faint">
              {WD[weekday(date)]} {Number(date.slice(8))}
            </span>
            {a ? (
              slots.length ? (
                <div className="flex flex-wrap gap-1">
                  {slots.map((t) => (
                    <button
                      key={t}
                      onClick={() => tryMove(date, t)}
                      className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-faint">{locale === "en" ? "closed / sold out" : locale === "ja" ? "休業・満席" : "休息／售完"}</span>
              )
            ) : (
              <button
                onClick={() => tryMove(date)}
                className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent"
              >
                {locale === "en" ? "same time" : locale === "ja" ? "同じ時間" : "相同時間"}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-danger">✕ {error}</p>}
      <button onClick={onClose} className="mt-2 text-faint underline">
        {t(locale, "cancel")}
      </button>
    </div>
  );
}

function AddEventPanel({ date, onClose }: { date: string; onClose: () => void }) {
  const addEvent = useStore((s) => s.addEvent);
  const locale = useSettings((s) => s.language);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("20:00");
  return (
    <form
      className="fade-in mt-2 space-y-2 rounded-lg border border-line bg-panel p-3 text-xs shadow-md"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) {
          addEvent(date, title.trim(), start, end);
          onClose();
        }
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={locale === "en" ? "Dinner / Train / Meeting…" : locale === "ja" ? "夕食・電車・打合せ…" : "晚餐／火車／會議…"}
        className="w-full rounded border border-line px-2 py-1.5 outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="rounded border border-line px-1.5 py-1" />
        <span className="text-faint">–</span>
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded border border-line px-1.5 py-1" />
        <span className="ml-auto text-faint">{t(locale, "fixedTag")} 🔒</span>
      </div>
      <div className="flex gap-2">
        <button className="rounded bg-accent px-2.5 py-1 font-semibold text-white">{t(locale, "save")}</button>
        <button type="button" onClick={onClose} className="text-faint underline">
          {t(locale, "cancel")}
        </button>
      </div>
    </form>
  );
}

export default function Itinerary() {
  const plan = useStore((s) => s.plan);
  const context = useStore((s) => s.context);
  const selectedDate = useStore((s) => s.selectedDate);
  const setSelectedDate = useStore((s) => s.setSelectedDate);
  const protectedWindows = useStore((s) => s.protectedWindows);
  const locale = useSettings((s) => s.language);
  const STATUS_STYLE = statusStyle(locale);
  const [stripStart, setStripStart] = useState(0);
  const [moving, setMoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const dates = horizonDates();
  const strip = dates.slice(stripStart, stripStart + 7);
  const day = plan.days.find((d) => d.date === selectedDate);
  const items = [...(day?.items ?? [])].sort((a, b) => toMin(a.startAt) - toMin(b.startAt));
  const dayBudget = computeDayBudget(plan, selectedDate);
  const isToday = selectedDate === context.currentDate;
  const hasItems = (date: string) => (plan.days.find((d) => d.date === date)?.items.length ?? 0) > 0;

  return (
    <aside className="flex h-full flex-col overflow-y-auto border-l border-line bg-panel px-4 py-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t(locale, "itinerary")}</h2>
        {!isToday && (
          <button
            onClick={() => {
              setSelectedDate(context.currentDate);
              setStripStart(0);
            }}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent"
          >
            {t(locale, "today")}
          </button>
        )}
      </div>

      {/* ── Date strip across the 30-day horizon ─────────────────────── */}
      <div className="mb-4 flex items-center gap-1">
        <button
          onClick={() => setStripStart(Math.max(0, stripStart - 7))}
          disabled={stripStart === 0}
          className="rounded px-1 text-muted disabled:opacity-30"
        >
          ‹
        </button>
        <div className="grid flex-1 grid-cols-7 gap-1">
          {strip.map((date) => {
            const selected = date === selectedDate;
            return (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`rounded-lg border px-0.5 py-1 text-center transition-colors ${
                  selected
                    ? "border-accent bg-accent text-white"
                    : "border-line text-muted hover:border-line-strong"
                }`}
              >
                <p className="text-[9px] uppercase">{WD[weekday(date)]}</p>
                <p className="text-xs font-semibold">{Number(date.slice(8))}</p>
                <p className={`mx-auto mt-0.5 h-1 w-1 rounded-full ${hasItems(date) ? (selected ? "bg-white" : "bg-accent") : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setStripStart(Math.min(dates.length - 7, stripStart + 7))}
          disabled={stripStart >= dates.length - 7}
          className="rounded px-1 text-muted disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <p className="mb-2 text-xs text-faint">
        {new Date(`${selectedDate}T00:00`).toLocaleDateString(INTL_LOCALE[locale], { weekday: "short", month: "long", day: "numeric" })}
        {dayBudget.committedJpy + dayBudget.proposedJpy > 0 && (
          <span className="ml-2">
            {yen(dayBudget.committedJpy)} {t(locale, "committed")}
            {dayBudget.proposedJpy > 0 && ` · ${yen(dayBudget.proposedJpy)} ${t(locale, "proposed")}`}
          </span>
        )}
      </p>

      <div className="flex-1 space-y-3">
        {isToday && (
          <p className="text-[11px] font-medium text-faint">
            <span className="pulse-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />
            {t(locale, "now")} {context.nowTime}
          </p>
        )}

        {protectedWindows.map((w, i) => (
          <div key={i} className="flex gap-3 opacity-70">
            <div className="w-11 shrink-0 pt-1 text-right text-xs font-medium text-muted">{w.startTime}</div>
            <div className="min-w-0 flex-1 rounded-lg border border-dotted border-warn/50 bg-warn-soft/40 px-3 py-1.5">
              <p className="text-xs font-medium text-warn">
                {w.reason} <span className="font-normal">({w.startTime}–{w.endTime}{w.recurrence === "daily" ? ", daily" : ""})</span>
              </p>
            </div>
          </div>
        ))}

        {items.length === 0 && (
          <p className="mt-6 text-center text-sm text-faint">{t(locale, "nothingPlanned")}</p>
        )}

        {items.map((item) => {
          const style = STATUS_STYLE[item.status];
          const a = item.activityId ? activityById.get(item.activityId) : undefined;
          return (
            <div key={`${item.id}-${item.startAt}`} className="slide-in flex gap-3">
              <div className="w-11 shrink-0 pt-2 text-right text-xs font-medium text-muted">
                {item.startAt}
              </div>
              <div className={`min-w-0 flex-1 rounded-lg border p-3 ${style.card}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm leading-snug font-medium">{item.title}</p>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${style.badge}`}>
                    {style.label}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  <span>
                    {item.startAt}–{item.endAt}
                  </span>
                  {item.priceJpy > 0 && <span>{yen(item.priceJpy)}</span>}
                  {item.travelMinutesBefore ? <span>~{item.travelMinutesBefore} {t(locale, "travelMin")}</span> : null}
                  {a && <span>{a.area}</span>}
                </div>
                {item.status !== "fixed" && (
                  <button
                    onClick={() => setMoving(moving === item.id ? null : item.id)}
                    className="mt-1.5 text-[11px] text-accent underline decoration-accent/40 hover:decoration-accent"
                  >
                    {t(locale, "moveLabel")}
                  </button>
                )}
                {moving === item.id && <MovePanel item={item} onClose={() => setMoving(null)} />}
              </div>
            </div>
          );
        })}

        <div className="pl-14">
          {adding ? (
            <AddEventPanel date={selectedDate} onClose={() => setAdding(false)} />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="rounded-md border border-dashed border-line px-2.5 py-1 text-[11px] text-faint hover:border-accent hover:text-accent"
            >
              {t(locale, "addEvent")}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
