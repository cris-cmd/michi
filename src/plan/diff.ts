// The Decision Trace source: a deterministic diff between the previous
// structured state and the new one. The model does not describe
// what changed — application code computes it, so the trace can't drift
// from the truth.

import type { AgentResponse } from "../agent/schema";
import type { DecisionDiff, PlanItem } from "./types";

type Constraints = AgentResponse["constraints"];

const label = (i: PlanItem) => `${i.startAt} ${i.title}`;

export function computeDiff(
  prev: { constraints: Constraints; candidates: string[]; proposed: PlanItem[] },
  next: { constraints: Constraints; candidates: string[]; proposed: PlanItem[] },
): DecisionDiff {
  const constraintsAdded: DecisionDiff["constraintsAdded"] = [];
  const constraintsRemoved: DecisionDiff["constraintsRemoved"] = [];
  const constraintsChanged: DecisionDiff["constraintsChanged"] = [];

  const keys = new Set([...Object.keys(prev.constraints), ...Object.keys(next.constraints)]);
  for (const key of keys) {
    const a = (prev.constraints as Record<string, unknown>)[key];
    const b = (next.constraints as Record<string, unknown>)[key];
    const aSet = a !== undefined && a !== null;
    const bSet = b !== undefined && b !== null;
    if (!aSet && bSet) constraintsAdded.push({ key, value: b });
    else if (aSet && !bSet) constraintsRemoved.push({ key, value: a });
    else if (aSet && bSet && JSON.stringify(a) !== JSON.stringify(b))
      constraintsChanged.push({ key, from: a, to: b });
  }

  const prevSet = new Set(prev.candidates);
  const nextSet = new Set(next.candidates);
  const candidatesAdded = next.candidates.filter((c) => !prevSet.has(c));
  const candidatesRemoved = prev.candidates.filter((c) => !nextSet.has(c));
  const candidatesRetained = next.candidates.filter((c) => prevSet.has(c));

  const prevTitles = new Map(prev.proposed.map((i) => [i.activityId ?? i.id, i]));
  const nextTitles = new Map(next.proposed.map((i) => [i.activityId ?? i.id, i]));
  const planItemsAdded: string[] = [];
  const planItemsRemoved: string[] = [];
  const planItemsChanged: string[] = [];
  for (const [k, item] of nextTitles) {
    const was = prevTitles.get(k);
    if (!was) planItemsAdded.push(label(item));
    else if (was.startAt !== item.startAt) planItemsChanged.push(`${item.title}: ${was.startAt} → ${item.startAt}`);
  }
  for (const [k, item] of prevTitles) if (!nextTitles.has(k)) planItemsRemoved.push(label(item));

  return {
    constraintsAdded,
    constraintsRemoved,
    constraintsChanged,
    candidatesAdded,
    candidatesRemoved,
    candidatesRetained,
    planItemsAdded,
    planItemsRemoved,
    planItemsChanged,
  };
}
