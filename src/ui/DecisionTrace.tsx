import { useStore, activityName } from "../flow/store";
import { useSettings } from "../flow/settings";
import { t } from "../i18n";

// The in-conversation Decision Trace: rendered from the deterministic
// TurnRecord the store computes on every revise/move turn (src/plan/diff.ts).
// The model never writes this — it cannot drift from what actually changed.
// The full evidence lives in the Decision Inspector (Inspector.tsx).

export const CONSTRAINT_LABELS: Record<string, string> = {
  quiet: "Quiet",
  culture: "Culture",
  crowd_tolerance: "Crowd tolerance",
  budget_jpy: "Budget",
  budget_flexible: "Budget flexibility",
  time_available_minutes: "Time available",
  energy: "Energy",
  adults: "Adults",
  children: "Children",
  infants: "Infants",
  priorities: "Priorities",
};

export function fmtConstraint(key: string, v: unknown): string {
  if (key === "budget_jpy" && typeof v === "number") return `¥${v.toLocaleString("en-US")}`;
  if (key === "budget_flexible") return v ? "flexible" : "firm";
  if (key === "time_available_minutes" && typeof v === "number") return `${v} min`;
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number" && ["quiet", "culture", "crowd_tolerance"].includes(key)) return `${v}/5`;
  return String(v);
}

export default function DecisionTrace({ compact = false }: { compact?: boolean }) {
  const lastTurn = useStore((s) => s.lastTurn);
  const showTrace = useStore((s) => s.showTrace);
  const excluded = useStore((s) => s.excluded);
  const locale = useSettings((s) => s.language);
  if (!showTrace || !lastTurn) return null;
  const diff = lastTurn.diff;

  const priorityRows = [
    ...diff.constraintsChanged.map((c) => ({
      key: c.key,
      text: `${fmtConstraint(c.key, c.from)} → ${fmtConstraint(c.key, c.to)}`,
    })),
    ...diff.constraintsAdded.map((c) => ({ key: c.key, text: `now ${fmtConstraint(c.key, c.value)}` })),
  ].filter((r) => CONSTRAINT_LABELS[r.key]);

  const reasonFor = (id: string) => excluded.find((e) => e.id === id)?.reason;

  const hasPlanChange =
    diff.planItemsAdded.length + diff.planItemsRemoved.length + diff.planItemsChanged.length > 0;

  if (
    priorityRows.length === 0 &&
    diff.candidatesRemoved.length === 0 &&
    !hasPlanChange &&
    !lastTurn.moveOutcome
  )
    return null;

  return (
    <div
      className={`card-enter my-1 rounded-xl border border-accent/25 bg-accent-soft/50 text-sm ${
        compact ? "space-y-2 p-3" : "space-y-3 p-4"
      }`}
    >
      {priorityRows.length > 0 && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-accent uppercase">
            {t(locale, "prioritiesUpdated")}
          </p>
          <div className="mt-1.5 space-y-0.5">
            {priorityRows.map((r) => (
              <p key={r.key} className="flex justify-between gap-4">
                <span className="text-muted">{CONSTRAINT_LABELS[r.key]}</span>
                <span className="font-medium">{r.text}</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {lastTurn.moveOutcome && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-accent uppercase">{t(locale, "moveLabel")}</p>
          <p className={`mt-1 text-xs ${lastTurn.moveOutcome.ok ? "text-muted" : "text-danger"}`}>
            {lastTurn.moveOutcome.ok ? "✓" : "✕"} {lastTurn.moveOutcome.detail}
          </p>
        </div>
      )}

      {(diff.candidatesRemoved.length > 0 || diff.candidatesAdded.length > 0 || hasPlanChange) && (
        <div>
          <p className="text-[10px] font-bold tracking-widest text-accent uppercase">{t(locale, "planChanged")}</p>
          <div className="mt-1.5 space-y-1.5">
            {diff.candidatesRemoved.map((id) => (
              <div key={id}>
                <p className="font-medium text-danger">− {activityName(id)}</p>
                {reasonFor(id) && <p className="text-xs text-muted">{reasonFor(id)}</p>}
              </div>
            ))}
            {diff.candidatesAdded.map((id) => (
              <div key={id}>
                <p className="font-medium text-ok">+ {activityName(id)}</p>
              </div>
            ))}
            {!compact && diff.planItemsRemoved.map((t) => (
              <p key={t} className="text-xs text-muted">
                calendar − {t}
              </p>
            ))}
            {!compact && diff.planItemsAdded.map((t) => (
              <p key={t} className="text-xs text-muted">
                calendar + {t}
              </p>
            ))}
            {!compact && diff.planItemsChanged.map((t) => (
              <p key={t} className="text-xs text-muted">
                calendar · {t}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
