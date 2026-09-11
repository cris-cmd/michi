import type { Emotion } from "../avatar/adapter";
import { useStore } from "../flow/store";
import { useKitStatus } from "./useKitStatus";

// The avatar card at the top of the conversation surface. The Perxona
// presenter mounts into #presenter-slot (kit.ts, outside React); until it's
// Ready — or when the kit is absent — a neutral orb stands in.

export default function Stage({
  emotion,
  listening,
  tall = false,
  full = false,
}: {
  emotion: Emotion;
  listening: boolean;
  tall?: boolean;
  /** Voice mode: Michi fills the whole workspace; panels float over her. */
  full?: boolean;
}) {
  const busy = useStore((s) => s.busy);
  const kitStatus = useKitStatus();
  const kitLive = kitStatus === "Ready";

  const status = busy ? "thinking…" : listening ? "listening…" : "";

  return (
    <div
      className={
        full
          ? "absolute inset-0 overflow-hidden bg-panel"
          : `relative shrink-0 overflow-hidden rounded-xl border border-line bg-panel shadow-sm transition-all duration-300 ${tall ? "h-[46vh] min-h-80" : "h-60"}`
      }
    >
      <div id="presenter-slot" className={kitLive ? "presenter-live" : "presenter-idle"} />

      {!kitLive && (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <div className="avatar-orb" data-emotion={emotion} />
          <p className="text-xs text-faint">
            {kitStatus && kitStatus !== "Unavailable"
              ? `avatar: ${kitStatus.toLowerCase()}…`
              : "voice-only mode"}
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-3 pb-2">
        <span className="rounded-full bg-panel/85 px-2 py-0.5 text-[11px] font-medium text-muted backdrop-blur">
          Michi
        </span>
        {status && (
          <span className="rounded-full bg-panel/85 px-2 py-0.5 text-[11px] text-faint backdrop-blur">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
