import { useCallback, useEffect, useRef, useState } from "react";
import { warmAdapter, type AvatarAdapter, type Emotion } from "./avatar/adapter";
import { probeAffect } from "./conversation/listener/affectClient";
import { conversationState } from "./conversation/listener";
import { utteranceCapture } from "./voice/capture";
import { agentTurn } from "./agent/client";
import { GREETINGS, paymentSucceededMessage } from "./agent/prompt";
import { useStore } from "./flow/store";
import { useSettings } from "./flow/settings";
import { executeUserTurn } from "./flow/turn";
import { beginTurn } from "./flow/turnGate";
import Stage from "./ui/Stage";
import Transcript from "./ui/Transcript";
import Candidates from "./ui/Candidates";
import Booking from "./ui/Booking";
import Sidebar from "./ui/Sidebar";
import Itinerary from "./ui/Itinerary";
import DecisionTrace from "./ui/DecisionTrace";
import Settings from "./ui/Settings";
import Inspector from "./ui/Inspector";
import DebugHud from "./ui/DebugHud";
import { useKitStatus } from "./ui/useKitStatus";
import { t, SPEECH_LANG, INTL_LOCALE } from "./i18n";

const DEBUG_HUD =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debug");

// DEMO TOOLS (?dev=1) — a reset control for running the two demo halves back
// to back. Query-gated so a public event link never exposes it.
const DEV_TOOLS =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("dev");

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

export default function App() {
  // The adapter warms on mount; Begin stays disabled until the presenter is
  // truly Ready because resumeAudioPlayback() must run inside the click.
  const adapterRef = useRef<AvatarAdapter | null>(null);
  // Delegate that mirrors say() into React state — the UI's Speaking pill —
  // without touching the adapter implementations.
  const delegateRef = useRef<AvatarAdapter | null>(null);

  const [prepared, setPrepared] = useState(false);
  const [started, setStarted] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [editingDates, setEditingDates] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [bookingDismissed, setBookingDismissed] = useState(false);
  const [justPaid, setJustPaid] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

  // DEMO TOOL: wipe trip + conversation, then reload so the avatar session,
  // mic and every piece of component state come back fresh too. The store
  // clears persisted storage first, so the reload can't rehydrate the old
  // trip. Deliberately a hard reset — between the two demo halves there is a
  // talking beat to cover it, and a half-reset on stage is worse than a wait.
  const resetDemo = useCallback(() => {
    useStore.getState().resetDemo();
    window.location.reload();
  }, []);

  useEffect(() => {
    if (!DEV_TOOLS) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Backspace") {
        e.preventDefault();
        resetDemo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetDemo]);
  // ONE voice interaction model: hands-free with barge-in; the mic button is
  // a mute toggle. Ref-mirrored because the turn pipeline calls openMic from
  // outside React's render cycle.
  const [micMuted, setMicMutedState] = useState(false);
  const micMutedRef = useRef(false);
  const setMicMuted = (v: boolean) => {
    micMutedRef.current = v;
    setMicMutedState(v);
  };
  const busyRef = useRef(false);

  const stage = useStore((s) => s.stage);
  const busy = useStore((s) => s.busy);
  const tone = useStore((s) => s.tone);
  const error = useStore((s) => s.error);
  const budget = useStore((s) => s.budget);
  const context = useStore((s) => s.context);
  const tripStart = useStore((s) => s.tripStart);
  const tripEnd = useStore((s) => s.tripEnd);
  const setTripDates = useStore((s) => s.setTripDates);
  const transcript = useStore((s) => s.transcript);
  const booking = useStore((s) => s.booking);
  const uiMode = useSettings((s) => s.uiMode);
  const setUiMode = useSettings((s) => s.setUiMode);
  const locale = useSettings((s) => s.language);
  const kitStatus = useKitStatus();

  useEffect(() => {
    // Affect models load server-side while the guest reads the Begin overlay
    // (probe also marks the endpoint unavailable for offline/mock runs).
    void probeAffect();
    // warmAdapter is a module singleton — StrictMode's double effect is safe.
    void warmAdapter().then((adapter) => {
      adapterRef.current = adapter;
      delegateRef.current = {
        caps: adapter.caps,
        kind: adapter.kind,
        mount: (el) => adapter.mount(el),
        say: async (text, sTone, lang, motion) => {
          setSpeaking(true);
          try {
            await adapter.say(text, sTone, lang, motion);
          } finally {
            setSpeaking(false);
          }
        },
        setEmotion: (e) => adapter.setEmotion(e),
        onUserInput: (cb) => adapter.onUserInput(cb),
        setListening: (on, lang) => adapter.setListening(on, lang),
        unlockAudio: adapter.unlockAudio ? () => adapter.unlockAudio!() : undefined,
        playAcknowledgement: adapter.playAcknowledgement
          ? (d, lang) => adapter.playAcknowledgement!(d, lang)
          : undefined,
        beginUtterance: adapter.beginUtterance
          ? (lang, sTone) => adapter.beginUtterance!(lang, sTone)
          : undefined,
        destroy: () => adapter.destroy(),
      };
      setPrepared(true);
    });
  }, []);

  const emotion: Emotion = busy
    ? "thinking"
    : tone === "apologetic"
      ? "concerned"
      : stage === "suggest" || stage === "revise"
        ? "presenting"
        : listening
          ? "listening"
          : "idle";

  useEffect(() => {
    if (started) adapterRef.current?.setEmotion(emotion);
  }, [emotion, started]);

  // Voice mode: the booking flow pops out as a modal; re-arm it whenever a
  // new confirm stage begins.
  useEffect(() => {
    if (stage === "confirm") setBookingDismissed(false);
  }, [stage]);

  // Mic reopening (executeUserTurn calls this around the turn lifecycle).
  // NO-OP outside voice mode or while the user has muted the mic — mute is
  // the one venue-noise control now that turn-based mode is gone.
  const openMic = (lang?: string) => {
    if (useSettings.getState().uiMode !== "voice" || micMutedRef.current) return;
    openMicExplicit(lang);
  };
  const openMicExplicit = (lang?: string) => {
    const adapter = adapterRef.current;
    if (adapter?.caps.speechIn) {
      adapter.setListening(true, lang);
      setListening(true);
    }
  };
  const closeMic = () => {
    adapterRef.current?.setListening(false);
    setListening(false);
  };

  const voiceState: "ready" | "listening" | "thinking" | "speaking" = busy
    ? "thinking"
    : speaking
      ? "speaking"
      : listening
        ? "listening"
        : "ready";

  // The mic button = mute toggle, always available once started. Unmuting
  // opens the mic immediately (settings-pinned locale — never the model's
  // declared language); muting hard-closes it until tapped again.
  const toggleMic = () => {
    if (!started) return;
    if (micMuted) {
      setMicMuted(false);
      openMicExplicit(SPEECH_LANG[useSettings.getState().language]);
    } else {
      setMicMuted(true);
      closeMic();
    }
  };

  // Space triggers Tap to Speak when focus isn't inside a form control.
  useEffect(() => {
    if (uiMode !== "voice" || !started) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.code !== "Space" || e.repeat) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      toggleMic();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode, started, listening, speaking, busy]);

  // Leaving voice mode closes the mic; returning reopens it unless muted.
  // state is untouched — modes are presentation only.
  useEffect(() => {
    if (uiMode !== "voice") closeMic();
    else if (started && !micMutedRef.current) openMicExplicit(SPEECH_LANG[useSettings.getState().language]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode]);

  const handleUserInput = async (text: string, meta?: { sttConfidence?: number }) => {
    const adapter = delegateRef.current;
    if (!adapter || !text.trim()) return;
    if (busyRef.current) {
      // busy = a turn is thinking/acknowledging. With a barge-in adapter in
      // continuous mode, new speech SUPERSEDES it (beginTurn aborts the old
      // model call; ticket gating keeps stale commits out) — the thinking
      // gap must not be a deaf spot. Otherwise: drop, as before.
      const phase = conversationState();
      const interruptible =
        adapter.caps.bargeIn &&
        (phase === "ACKNOWLEDGING" || phase === "THINKING" || phase === "PRESENTING");
      if (!interruptible) return;
    }
    busyRef.current = true;
    try {
      await executeUserTurn(
        text,
        {
          adapter,
          openMic,
          closeMic,
          releaseBusy: () => {
            busyRef.current = false;
          },
          onSpeakingChange: setSpeaking,
        },
        meta,
      );
    } finally {
      busyRef.current = false;
    }
  };

  const begin = () => {
    const adapter = adapterRef.current;
    const delegate = delegateRef.current;
    if (!adapter || !delegate) return;
    // Autoplay unlock MUST be invoked synchronously inside this click.
    void adapter.unlockAudio?.();
    // Vocal-tone capture (audio affect). Best-effort: if it can't start,
    // perception is text-only — never blocks the demo.
    if (adapter.caps.speechIn) void utteranceCapture.start();
    setStarted(true);
    void (async () => {
      await delegate.mount(document.body);
      delegate.onUserInput((text, meta) => void handleUserInput(text, meta));
      const locale = useSettings.getState().language;
      const speechLang = SPEECH_LANG[locale];
      // Resumed session (persisted transcript): don't re-greet, just listen.
      if (useStore.getState().transcript.length === 0) {
        const greeting = GREETINGS[locale];
        useStore.getState().addAvatarLine(greeting);
        await delegate.say(greeting, "warm", speechLang); // no greeting motion — natural presence only
      }
      openMic(speechLang); // hands-free from the first moment (mute is one tap away)
    })();
  };

  const onPick = (id: string) => {
    if (useStore.getState().busy) return;
    void handleUserInput(`I'd like the one with id ${id}, please.`);
  };

  const onReserve = () => void handleUserInput("Yes — please reserve it.");

  const onPaid = async (code: string) => {
    const adapter = delegateRef.current;
    const ticket = beginTurn(); // supersedes any in-flight speech turn
    const s = useStore.getState();
    setJustPaid(true);
    s.setBooking({ code, activityId: s.selection ?? "" });
    s.pushHistory({ role: "user", content: paymentSucceededMessage(code) });
    try {
      const response = await agentTurn(useStore.getState().history, { signal: ticket.signal });
      if (!ticket.isCurrent()) return; // stale: no store update, no audio
      useStore.getState().applyAgentResponse(response);
      await adapter?.say(response.reply, response.tone, SPEECH_LANG[useSettings.getState().language]);
    } catch {
      if (!ticket.isCurrent()) return;
      const line = "You're booked. Enjoy it — and come tell me how it went.";
      useStore.getState().addAvatarLine(line);
      await adapter?.say(line, "delighted", SPEECH_LANG[useSettings.getState().language]);
    }
  };

  const spent = budget.committedJpy + budget.proposedJpy;
  const budgetTone =
    budget.state === "over" ? "text-danger" : budget.state === "near" ? "text-warn" : "text-text";
  const lastAvatarLine = [...transcript].reverse().find((t) => t.who === "avatar")?.text;

  const VOICE_STATE_LABEL: Record<typeof voiceState, string> = {
    ready: `● ${t(locale, "ready")}`,
    listening: `● ${t(locale, "listening")}`,
    thinking: `◌ ${t(locale, "thinking")}`,
    speaking: `◉ ${t(locale, "speaking")}`,
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold tracking-tight">
            michi<span className="text-accent">.</span>
          </span>
          {/* Primary mode switch — switching preserves the whole session. */}
          <div className="flex rounded-lg border border-line p-0.5 text-xs font-medium">
            <button
              onClick={() => setUiMode("text")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                uiMode === "text" ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              ⌨ Text
            </button>
            <button
              onClick={() => setUiMode("voice")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                uiMode === "voice" ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              🎙 Voice
            </button>
          </div>
        </div>

        <div className="relative flex items-center gap-2 text-xs text-muted">
          <button
            onClick={() => setEditingDates(!editingDates)}
            className="rounded-full border border-line bg-surface px-2.5 py-1 font-medium hover:border-line-strong"
          >
            {context.location} ·{" "}
            {new Date(`${tripStart}T00:00`).toLocaleDateString(INTL_LOCALE[locale], { month: "short", day: "numeric" })}
            {" – "}
            {new Date(`${tripEnd}T00:00`).toLocaleDateString(INTL_LOCALE[locale], { month: "short", day: "numeric" })}
          </button>
          {editingDates && (
            <div className="absolute top-9 left-0 z-40 flex items-center gap-2 rounded-lg border border-line bg-panel p-3 shadow-lg">
              <input
                type="date"
                value={tripStart}
                min={context.currentDate}
                onChange={(e) => setTripDates(e.target.value, tripEnd)}
                className="rounded border border-line px-1.5 py-1"
              />
              <span>–</span>
              <input
                type="date"
                value={tripEnd}
                min={tripStart}
                onChange={(e) => setTripDates(tripStart, e.target.value)}
                className="rounded border border-line px-1.5 py-1"
              />
              <button onClick={() => setEditingDates(false)} className="text-faint underline">
                done
              </button>
            </div>
          )}
          {context.weather?.rain && (
            <span className="rounded-full border border-line bg-surface px-2.5 py-1">
              🌧 {context.weather.temperatureC}°C
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setInspectorOpen(true)}
            className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
          >
            ⓘ Decision
          </button>
          <span className={`text-sm font-semibold ${budgetTone}`}>
            {yen(spent)} <span className="font-normal text-faint">/ {yen(budget.totalBudgetJpy)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={`h-2 w-2 rounded-full ${
                kitStatus === "Ready" ? "pulse-dot bg-ok" : "bg-line-strong"
              }`}
            />
            {kitStatus === "Ready" ? "Live" : "Standby"}
          </span>
          {uiMode === "voice" && (
            <button
              onClick={() => setPlanOpen(!planOpen)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                planOpen ? "bg-accent text-white" : "text-muted hover:text-text"
              }`}
            >
              📋 {t(locale, "plan")}
            </button>
          )}
          <Settings />
        </div>
      </header>

      {/* ── Workspace ───────────────────────────────────────────────── */}
      {uiMode === "voice" ? (
        /* Voice mode: Michi IS the screen. The avatar fills the workspace;
           everything else floats over her in translucent panels. */
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <Stage emotion={emotion} listening={listening} full />

          {error && (
            <div className="absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-lg border border-danger/40 bg-danger-soft/95 px-3 py-2 text-xs text-danger shadow-lg backdrop-blur">
              {error}
            </div>
          )}

          {/* Floating right rail: the travel proof (trace + candidates). */}
          <div className="pointer-events-none absolute bottom-36 right-4 top-4 z-10 flex w-80 max-w-[85vw] flex-col justify-start gap-3 overflow-y-auto">
            <div className="pointer-events-auto space-y-3">
              <DecisionTrace compact />
              {!(stage === "confirm" || stage === "checkout" || booking) && (
                <Candidates onPick={onPick} />
              )}
            </div>
          </div>

          {/* Floating transcript (toggle lives in the bottom bar). */}
          {showTranscript && (
            <div className="absolute bottom-36 left-4 z-10 max-h-[46vh] w-96 max-w-[85vw] overflow-y-auto rounded-xl border border-line bg-panel/90 p-3 shadow-lg backdrop-blur">
              <Transcript />
            </div>
          )}

          {/* Plan drawer: the itinerary slides over the right edge. */}
          {planOpen && (
            <div className="absolute bottom-0 right-0 top-0 z-30 w-[336px] max-w-[92vw] overflow-y-auto border-l border-line bg-panel shadow-2xl">
              <Itinerary />
            </div>
          )}

          {/* Bottom bar: state, mic, transcript toggle — floating over her. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex flex-col items-center gap-2">
            {speaking && lastAvatarLine && (
              <p className="fade-in pointer-events-auto max-w-xl rounded-xl bg-panel/85 px-4 py-2 text-center text-sm leading-snug text-text shadow backdrop-blur">
                {lastAvatarLine}
              </p>
            )}
            <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-line bg-panel/85 px-4 py-2.5 shadow-lg backdrop-blur">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  voiceState === "listening"
                    ? "pulse-dot bg-accent text-white"
                    : voiceState === "speaking"
                      ? "bg-ok-soft text-ok"
                      : voiceState === "thinking"
                        ? "bg-warn-soft text-warn"
                        : "bg-surface text-muted"
                }`}
              >
                {VOICE_STATE_LABEL[voiceState]}
              </span>
              <button
                onClick={toggleMic}
                disabled={!started}
                className={`rounded-xl px-6 py-2.5 text-sm font-semibold shadow-sm transition-all ${
                  micMuted
                    ? "border border-line bg-surface text-muted hover:text-text disabled:opacity-40"
                    : "bg-accent text-white hover:opacity-90 disabled:opacity-40"
                }`}
              >
                {micMuted ? `🎙 ${t(locale, "tapToSpeak")}` : `🔇 ${t(locale, "micMute")}`}
              </button>
              <button
                onClick={() => setShowTranscript(!showTranscript)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  showTranscript ? "bg-accent/15 text-accent" : "text-muted hover:text-text"
                }`}
              >
                {showTranscript ? t(locale, "hideTranscript") : t(locale, "showTranscript")}
              </button>
              <span className="hidden text-[11px] text-faint sm:block">{t(locale, "pressSpace")}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[216px_minmax(0,1fr)_336px]">
          <Sidebar onPick={onPick} />

          <main className="flex min-h-0 flex-col gap-3 px-6 py-4">
            <Stage emotion={emotion} listening={listening} />

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
                {error}
              </div>
            )}

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pb-2">
              <Transcript />
              <DecisionTrace />
              <Candidates onPick={onPick} />
              <Booking onReserve={onReserve} onPaid={(code) => void onPaid(code)} />
            </div>

            <form
              className="flex shrink-0 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const t = textDraft;
                setTextDraft("");
                void handleUserInput(t);
              }}
            >
              <input
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                placeholder={busy ? t(locale, "michiThinking") : t(locale, "askMichi")}
                disabled={!started}
                className="flex-1 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm shadow-sm outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
              />
              <button
                disabled={!started}
                className="rounded-xl bg-accent px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                ↑
              </button>
            </form>
          </main>

          <Itinerary />
        </div>
      )}

      {uiMode === "voice" &&
        (stage === "confirm" || stage === "checkout" || (booking && justPaid)) &&
        !bookingDismissed && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-text/30">
            <div className="fade-in w-[420px] max-w-[92vw] space-y-2">
              <Booking onReserve={onReserve} onPaid={(code) => void onPaid(code)} />
              {booking && (
                <button
                  onClick={() => setBookingDismissed(true)}
                  className="w-full rounded-lg border border-line bg-panel py-2 text-sm font-medium text-muted hover:text-text"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        )}

      {inspectorOpen && <Inspector onClose={() => setInspectorOpen(false)} />}

      {DEBUG_HUD && <DebugHud />}

      {DEV_TOOLS && (
        <button
          onClick={resetDemo}
          title="Reset to a first-visit session (⌘/Ctrl + Shift + Backspace)"
          className="fixed bottom-3 left-3 z-50 rounded-md border border-line bg-panel/90 px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-faint uppercase backdrop-blur transition-colors hover:border-accent hover:text-accent"
        >
          reset demo
        </button>
      )}

      {/* ── Landing overlay ─────────────────────────────────────────── */}
      {!started && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-surface">
          <span className="text-4xl font-bold tracking-tight">
            michi<span className="text-accent">.</span>
          </span>
          <p className="text-sm text-muted">{t(locale, "tagline")}</p>
          <p className="text-xl font-medium">{t(locale, "subtitle")}</p>
          <button
            onClick={begin}
            disabled={!prepared}
            className="rounded-xl bg-accent px-10 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
          >
            {prepared ? (transcript.length > 0 ? t(locale, "resume") : t(locale, "begin")) : t(locale, "preparing")}
          </button>
          {!prepared && kitStatus && kitStatus !== "Unavailable" && (
            <p className="text-xs text-faint">avatar: {kitStatus.toLowerCase()}…</p>
          )}
        </div>
      )}
    </div>
  );
}
