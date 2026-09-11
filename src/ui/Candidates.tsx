import { useStore } from "../flow/store";
import { activityById, mapsUrl, partyCostJpy, priceLabel } from "../data/activities";
import { useSettings } from "../flow/settings";
import { t } from "../i18n";

// The three recommendation cards + "Not right now": the interface admitting
// what it ruled out, with reasons tied to THIS traveler's situation.

function Chip({ children, tone = "default" }: { children: React.ReactNode; tone?: "default" | "accent" | "warn" }) {
  const styles =
    tone === "accent"
      ? "bg-accent-soft text-accent"
      : tone === "warn"
        ? "bg-warn-soft text-warn"
        : "bg-surface text-muted";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${styles}`}>
      {children}
    </span>
  );
}

export default function Candidates({
  onPick,
  horizontal = false,
}: {
  onPick: (id: string) => void;
  /** Voice mode: 3-up compact row instead of the vertical stack. */
  horizontal?: boolean;
}) {
  const candidates = useStore((s) => s.candidates);
  const excluded = useStore((s) => s.excluded);
  const selection = useStore((s) => s.selection);
  const stage = useStore((s) => s.stage);
  const party = useStore((s) => s.party);
  const savedIds = useStore((s) => s.savedIds);
  const toggleSaved = useStore((s) => s.toggleSaved);
  const locale = useSettings((s) => s.language);

  // Saving is a bookmark ONLY — never touches calendar, spend, or reserved
  // state (store.toggleSaved just edits the id list).
  const saveBtn = (id: string) => (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        toggleSaved(id);
      }}
      onKeyDown={(e) => e.key === "Enter" && toggleSaved(id)}
      className={`pointer-events-auto rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
        savedIds.includes(id)
          ? "border-accent bg-accent-soft text-accent"
          : "border-line text-muted hover:border-accent hover:text-accent"
      }`}
    >
      {savedIds.includes(id) ? t(locale, "savedAct") : t(locale, "saveAct")}
    </span>
  );

  if (candidates.length === 0) return null;
  // Superseded sets are history: visible but never actionable (and muted).
  const pickable = stage === "suggest" || stage === "revise";

  if (horizontal) {
    return (
      <div className={`space-y-2.5 ${pickable ? "" : "pointer-events-none opacity-60"}`}>
        <div className="grid grid-cols-3 gap-2.5">
          {candidates.map((id, i) => {
            const a = activityById.get(id);
            if (!a) return null;
            const isSelected = selection === id;
            return (
              <button
                key={`${id}-${candidates.join(",")}`}
                onClick={() => pickable && onPick(id)}
                disabled={!pickable}
                className={`card-enter flex flex-col rounded-xl border bg-panel p-3 text-left shadow-sm transition-all ${
                  isSelected ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong"
                } ${pickable ? "cursor-pointer hover:shadow-md" : "cursor-default"}`}
                style={{ animationDelay: `${i * 150}ms` }}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <h3 className="line-clamp-2 text-[13px] leading-snug font-semibold">{a.name}</h3>
                  {i === 0 && <Chip tone="accent">{t(locale, "bestFit")}</Chip>}
                </div>
                <p className="mt-0.5 text-[11px] text-faint">{a.area}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-2">
                  <Chip>{priceLabel(a)}</Chip>
                  <Chip>{a.durationMinutes}m</Chip>
                  {a.family.infantFriendly && <Chip>{t(locale, "babyOk")}</Chip>}
                  <Chip>~{a.travelMinutes}{locale === "en" ? "m" : ""} {locale === "en" ? "away" : t(locale, "minAway")}</Chip>
                  {saveBtn(id)}
                </div>
              </button>
            );
          })}
        </div>

        {excluded.length > 0 && (
          <div className="rounded-xl border border-line bg-surface/60 px-3 py-2">
            <span className="mr-2 align-middle text-[10px] font-bold tracking-widest text-faint uppercase">
              {t(locale, "notRightNow")}
            </span>
            {excluded.map((e) => {
              const a = activityById.get(e.id);
              return (
                <span key={e.id} className="mr-3 inline text-[12px] leading-tight text-muted" title={e.reason}>
                  <span className="font-medium line-through decoration-faint">{a?.name ?? e.id}</span>
                  {" — "}
                  {e.reason.length > 70 ? `${e.reason.slice(0, 70)}…` : e.reason}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${pickable ? "" : "pointer-events-none opacity-60"}`}>
      <div className="space-y-2.5">
        {candidates.map((id, i) => {
          const a = activityById.get(id);
          if (!a) return null;
          const isSelected = selection === id;
          return (
            <button
              key={`${id}-${candidates.join(",")}`}
              onClick={() => pickable && onPick(id)}
              disabled={!pickable}
              className={`card-enter block w-full rounded-xl border bg-panel p-4 text-left shadow-sm transition-all ${
                isSelected ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong"
              } ${pickable ? "cursor-pointer hover:shadow-md" : "cursor-default"}`}
              style={{ animationDelay: `${i * 200}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[15px] leading-snug font-semibold">{a.name}</h3>
                {i === 0 && <Chip tone="accent">{t(locale, "bestFit")}</Chip>}
              </div>
              <p className="mt-0.5 text-xs text-faint">
                {a.operator} · {a.area}
              </p>
              <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-muted">
                {a.description}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Chip>{priceLabel(a)}</Chip>
                <Chip>{a.durationMinutes} min</Chip>
                <Chip>{a.indoorOutdoor === "indoor" ? "Indoor" : a.indoorOutdoor === "outdoor" ? "Outdoor" : "In/outdoor"}</Chip>
                {a.family.infantFriendly && <Chip>{t(locale, "babyOk")}</Chip>}
                <Chip>~{a.travelMinutes} min away</Chip>
                {(party.infants || party.children) && partyCostJpy(a, party) !== a.price.adultJpy && (
                  <Chip tone="accent">¥{partyCostJpy(a, party).toLocaleString("en-US")} for your party</Chip>
                )}
                {a.friction[0] && <Chip tone="warn">{a.friction[0]}</Chip>}
              </div>
              <p className="mt-2 flex items-center gap-2 text-[11px] text-faint">
                {saveBtn(id)}
                <a
                  href={mapsUrl(a)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-line hover:text-muted"
                  onClick={(e) => e.stopPropagation()}
                >
                  map
                </a>
              </p>
            </button>
          );
        })}
      </div>

      {excluded.length > 0 && (
        <div className="rounded-xl border border-line bg-surface/60 p-3.5">
          <h4 className="text-[10px] font-bold tracking-widest text-faint uppercase">
            {t(locale, "notRightNow")}
          </h4>
          <ul className="mt-2 space-y-2">
            {excluded.map((e) => {
              const a = activityById.get(e.id);
              return (
                <li key={e.id} className="fade-in text-[13px] leading-snug">
                  <span className="font-medium text-muted line-through decoration-faint">
                    {a?.name ?? e.id}
                  </span>
                  <span className="ml-1.5 text-muted">— {e.reason}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
