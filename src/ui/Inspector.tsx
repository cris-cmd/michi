import { useState } from "react";
import { useStore, activityName } from "../flow/store";
import { activityById, partyCostJpy } from "../data/activities";
import { findSlot, hardViolations } from "../plan/engine";
import { CONSTRAINT_LABELS, fmtConstraint } from "./DecisionTrace";

// The Decision Inspector — observable structured evidence, never hidden
// model reasoning. Everything here is reconstructed from state the app owns:
// the structured priority diff, activity attributes, deterministic engine
// checks, local retrieval traces, and the calendar/budget diffs. That's the
// architecture on display: AI handles judgment; code handles truth.

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-5 py-4">
      <p className="text-[10px] font-bold tracking-widest text-faint uppercase">{title}</p>
      <div className="mt-2 space-y-2 text-[13px]">{children}</div>
    </div>
  );
}

export default function Inspector({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [tab, setTab] = useState<"decision" | "engine" | "retrieval">("decision");
  const t = s.lastTurn;
  const diff = t?.diff;

  const attrReason = (removedId: string, addedId?: string): string[] => {
    const out: string[] = [];
    const rem = activityById.get(removedId);
    const add = addedId ? activityById.get(addedId) : undefined;
    const quietChanged = diff?.constraintsChanged.some((c) => c.key === "quiet") || diff?.constraintsAdded.some((c) => c.key === "quiet");
    if (quietChanged && rem) {
      out.push(`Quiet priority increased. ${rem.name.split("—")[0].trim()} quiet score: ${rem.atmosphere.quiet}/5.`);
      if (add) out.push(`${add.name.split("—")[0].trim()} quiet score: ${add.atmosphere.quiet}/5.`);
    }
    const excludedReason = s.excluded.find((e) => e.id === removedId)?.reason;
    if (excludedReason) out.push(`Stated: ${excludedReason}`);
    return out;
  };

  const engineRow = (id: string) => {
    const a = activityById.get(id);
    if (!a) return null;
    const violations = hardViolations(a, s.context, s.constraints, s.plan, s.selectedDate, s.protectedWindows);
    const slot = findSlot(a, s.context, s.plan, [], s.selectedDate, s.protectedWindows);
    const planned = s.plan.days.flatMap((d) => d.items).find((i) => i.activityId === id);
    const cost = partyCostJpy(a, s.party);
    return { a, violations, slot, planned, cost };
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-text/20" onClick={onClose}>
      <div
        className="fade-in flex h-full w-[420px] flex-col overflow-y-auto border-l border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <p className="text-sm font-semibold">Decision Inspector</p>
            <p className="text-[11px] text-faint">
              Observable evidence — structured state, engine checks, retrieval. No hidden model reasoning.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-text">
            ✕
          </button>
        </div>

        <div className="flex gap-1 border-b border-line px-5 py-2">
          {(["decision", "engine", "retrieval"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                tab === k ? "bg-accent text-white" : "text-muted hover:bg-surface"
              }`}
            >
              {k}
            </button>
          ))}
        </div>

        {tab === "decision" && (
          <>
            <Section title="Priorities">
              {Object.entries(s.constraints)
                .filter(([k, v]) => v != null && CONSTRAINT_LABELS[k])
                .map(([k, v]) => {
                  const changed = diff?.constraintsChanged.find((c) => c.key === k);
                  const added = diff?.constraintsAdded.find((c) => c.key === k);
                  return (
                    <p key={k} className="flex justify-between gap-3">
                      <span className="text-muted">{CONSTRAINT_LABELS[k]}</span>
                      <span className="font-medium">
                        {changed ? (
                          <>
                            <span className="text-faint line-through">{fmtConstraint(k, changed.from)}</span>{" "}
                            → {fmtConstraint(k, changed.to)} <span className="text-accent">↑</span>
                          </>
                        ) : added ? (
                          <>
                            {fmtConstraint(k, v)} <span className="text-accent">new</span>
                          </>
                        ) : (
                          <>
                            {fmtConstraint(k, v)} <span className="text-faint">=</span>
                          </>
                        )}
                      </span>
                    </p>
                  );
                })}
              {Object.values(s.constraints).every((v) => v == null) && (
                <p className="text-faint">No priorities expressed yet.</p>
              )}
            </Section>

            <Section title="Candidate movement">
              {!diff && <p className="text-faint">No turns yet.</p>}
              {diff?.candidatesAdded.map((id) => (
                <div key={id}>
                  <p className="font-medium text-ok">↑ {activityName(id)}</p>
                  <p className="text-[11px] text-muted">Added at #{s.candidates.indexOf(id) + 1}</p>
                  {attrReason(diff.candidatesRemoved[0] ?? "", id)
                    .slice(1, 2)
                    .map((r, i) => (
                      <p key={i} className="text-[11px] text-muted">{r}</p>
                    ))}
                </div>
              ))}
              {diff?.candidatesRetained.map((id) => (
                <p key={id} className="text-muted">
                  = {activityName(id)} <span className="text-[11px] text-faint">#{s.candidates.indexOf(id) + 1}</span>
                </p>
              ))}
              {diff?.candidatesRemoved.map((id) => (
                <div key={id}>
                  <p className="font-medium text-danger">↓ {activityName(id)}</p>
                  <p className="text-[11px] text-muted">Removed from shortlist</p>
                  {attrReason(id).map((r, i) => (
                    <p key={i} className="text-[11px] text-muted">{r}</p>
                  ))}
                </div>
              ))}
            </Section>

            <Section title="Plan diff">
              {t && (
                <>
                  {t.diff.planItemsRemoved.map((x) => (
                    <p key={x} className="text-danger">REMOVED · {x}</p>
                  ))}
                  {t.diff.planItemsAdded.map((x) => (
                    <p key={x} className="text-ok">ADDED · {x}</p>
                  ))}
                  {t.diff.planItemsChanged.map((x) => (
                    <p key={x} className="text-muted">MOVED · {x}</p>
                  ))}
                  {t.moveOutcome && (
                    <p className={t.moveOutcome.ok ? "text-muted" : "text-danger"}>
                      MOVE · {t.moveOutcome.ok ? "✓" : "✕"} {t.moveOutcome.detail}
                    </p>
                  )}
                  <p className="text-muted">
                    UNCHANGED ·{" "}
                    {s.plan.days
                      .flatMap((d) => d.items)
                      .filter((i) => i.status === "fixed")
                      .map((i) => `${i.startAt} ${i.title}`)
                      .join(" · ") || "—"}
                  </p>
                </>
              )}
            </Section>

            <Section title="Budget diff">
              {t ? (
                <>
                  <p className="flex justify-between">
                    <span className="text-muted">Proposed</span>
                    <span className="font-medium">
                      {yen(t.budgetBefore.proposedJpy)} → {yen(t.budgetAfter.proposedJpy)}
                    </span>
                  </p>
                  <p className="flex justify-between">
                    <span className="text-muted">Committed</span>
                    <span className="font-medium">
                      {yen(t.budgetBefore.committedJpy)} → {yen(t.budgetAfter.committedJpy)}
                    </span>
                  </p>
                  <p className="flex justify-between">
                    <span className="text-muted">Remaining</span>
                    <span className="font-medium">
                      {yen(t.budgetBefore.remainingJpy)} → {yen(t.budgetAfter.remainingJpy)}
                    </span>
                  </p>
                  {s.booking && <p className="text-ok">STATE · Proposed → Reserved ({s.booking.code})</p>}
                </>
              ) : (
                <p className="text-faint">No turns yet.</p>
              )}
            </Section>
          </>
        )}

        {tab === "engine" && (
          <Section title={`Engine checks — ${s.selectedDate}`}>
            {s.candidates.length === 0 && <p className="text-faint">No candidates yet.</p>}
            {s.candidates.map((id) => {
              const row = engineRow(id);
              if (!row) return null;
              return (
                <div key={id} className="rounded-lg border border-line p-2.5">
                  <p className="font-medium">{row.a.name}</p>
                  <div className="mt-1 space-y-0.5 text-[12px]">
                    {row.violations.length === 0 ? (
                      <>
                        <p className="text-ok">✓ available {row.slot ? `${s.selectedDate} ${row.slot.startAt}` : ""}</p>
                        {row.slot && <p className="text-ok">✓ fits the calendar ({row.slot.startAt}–{row.slot.endAt})</p>}
                        <p className="text-ok">✓ ~{row.a.travelMinutes} min travel buffer included</p>
                        {(s.party.infants ?? 0) > 0 && (
                          <p className="text-ok">✓ infant permitted</p>
                        )}
                        {s.context.weather?.rain && <p className="text-ok">✓ rain compatible ({row.a.weather.rain})</p>}
                        <p className="text-muted">
                          Total party cost <span className="font-medium">{yen(row.cost)}</span>
                        </p>
                        {row.planned && (
                          <p className="text-muted">
                            Schedule window {row.planned.startAt}–{row.planned.endAt} ({row.planned.status})
                          </p>
                        )}
                      </>
                    ) : (
                      row.violations.map((v) => (
                        <p key={v} className="text-danger">✕ {v}</p>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
            {s.excluded.map((e) => {
              const row = engineRow(e.id);
              return (
                <div key={e.id} className="rounded-lg border border-line bg-surface/60 p-2.5">
                  <p className="font-medium text-muted">✕ {activityName(e.id)}</p>
                  {(row?.violations.length ? row.violations : [e.reason]).map((v) => (
                    <p key={v} className="text-[12px] text-danger">{v}</p>
                  ))}
                </div>
              );
            })}
          </Section>
        )}

        {tab === "retrieval" && (
          <Section title="Local retrieval">
            {s.lastRetrieval ? (
              <>
                <div className="space-y-0.5">
                  <p className="flex justify-between"><span className="text-muted">Catalogue</span><span className="font-medium">{s.lastRetrieval.stats.catalogue} activities</span></p>
                  <p className="flex justify-between"><span className="text-muted">Hard-valid for {s.lastRetrieval.stats.date}</span><span className="font-medium">{s.lastRetrieval.stats.hardValid}</span></p>
                  <p className="flex justify-between"><span className="text-muted">Sent to model</span><span className="font-medium">{s.lastRetrieval.stats.sent}</span></p>
                  <p className="flex justify-between"><span className="text-muted">Model shortlist</span><span className="font-medium">{s.candidates.length}</span></p>
                </div>
                <div className="mt-2 border-t border-line pt-2">
                  {s.lastRetrieval.traces.slice(0, 10).map((tr) => (
                    <p key={tr.activityId} className="flex justify-between gap-2 text-[12px]">
                      <span className={`truncate ${tr.eligible ? "text-text" : "text-faint line-through"}`}>
                        #{tr.rank} {tr.name}
                      </span>
                      <span className="shrink-0 font-mono text-muted">{tr.scores.total.toFixed(1)}</span>
                    </p>
                  ))}
                  <p className="mt-1.5 text-[11px] text-faint">
                    Deterministic scoring — keywords, priorities, budget, travel, availability. Ineligible rows carry engine failures (e.g.{" "}
                    {s.lastRetrieval.traces.find((x) => !x.eligible)?.hardFailures[0] ?? "sold out"}).
                  </p>
                </div>
              </>
            ) : (
              <p className="text-faint">No retrieval yet — ask Michi something.</p>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}
