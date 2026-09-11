// Developer HUD enabled with ?debug=1. Shows
// the last turn's latency breakdown (src/conversation/metrics.ts) and the
// live conversation state.

import { useEffect, useState } from "react";
import type { TurnLatencyReport } from "../conversation/metrics";
import { latencyReports } from "../conversation/metrics";
import type { ConversationTurnState } from "../conversation/listener";
import { conversationState } from "../conversation/listener";

const ROWS: [string, string][] = [
  ["sttFinal", "STT final"],
  ["affect", "AFFECT (txt+audio)"],
  ["ackDecision", "ACK decision"],
  ["ackAudible", "ACK audible"],
  ["llmTtft", "LLM TTFT"],
  ["llmTotal", "LLM total"],
  ["ttsFirstAudio", "TTS first audio"],
  ["speechEndToFirstReplyAudio", "→ reply audible"],
  ["perceivedResponseDelay", "perceived delay"],
];

export default function DebugHud() {
  const [report, setReport] = useState<TurnLatencyReport | null>(
    () => latencyReports().at(-1) ?? null,
  );
  const [convState, setConvState] = useState<ConversationTurnState>(conversationState());

  useEffect(() => {
    const onLatency = (e: Event) => setReport((e as CustomEvent).detail as TurnLatencyReport);
    const onState = (e: Event) => setConvState((e as CustomEvent).detail as ConversationTurnState);
    window.addEventListener("michi:turn-latency", onLatency);
    window.addEventListener("michi:conversation-state", onState);
    return () => {
      window.removeEventListener("michi:turn-latency", onLatency);
      window.removeEventListener("michi:conversation-state", onState);
    };
  }, []);

  return (
    <div className="fixed right-3 bottom-3 z-50 w-52 rounded-lg border border-line bg-panel/90 p-3 font-mono text-[11px] leading-relaxed text-muted shadow-lg backdrop-blur">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-text">latency</span>
        <span className="text-accent">{convState}</span>
      </div>
      {report ? (
        <>
          <div className="mb-1 text-faint">
            turn {report.turnId}
            {report.interrupted ? " · interrupted" : ""}
          </div>
          {ROWS.map(([key, label]) => {
            const v = report.derived[key];
            return v === undefined ? null : (
              <div key={key} className="flex justify-between">
                <span>{label}</span>
                <span className="text-text">{v} ms</span>
              </div>
            );
          })}
          {Object.entries(report.notes ?? {}).map(([key, value]) => (
            <div key={`n-${key}`} className="mt-0.5 flex justify-between gap-2">
              <span>{key}</span>
              <span className="max-w-32 truncate text-right text-text" title={value}>
                {value}
              </span>
            </div>
          ))}
        </>
      ) : (
        <div className="text-faint">no turns yet</div>
      )}
    </div>
  );
}
