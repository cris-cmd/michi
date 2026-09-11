// Browser client for the same-origin model endpoint. Provider credentials and
// SDKs remain on the server; the optional mock agent runs in the browser.

import type { AgentResponse } from "./schema";
import { buildTurnHistory, historyBytes } from "./contextBuilder";
import { mockAgentTurn } from "./mockAgent";
import { useSettings } from "../flow/settings";
import { useStore } from "../flow/store";

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** The affect listener's confident read of the turn, forwarded so the
 *  continuation can FEEL right (audio tone is invisible in the transcript).
 *  Server-side it becomes a system note — see agent/core.ts. */
export type ListenerContext = {
  socialResponse: "none" | "warmth" | "compassion" | "celebration" | "concern";
  taskTone: "neutral" | "warm" | "gently_positive" | "upbeat" | "calm";
  voiceSubdued: boolean;
};

/** Sent only when the STT hearing is suspect: the model must confirm
 *  critical values (money/dates/party) instead of committing them —
 *  enforced server-side by the runtime guard in agent/core.ts. */
export type TranscriptHint = {
  confidence: number;
  uncertain: true;
};

// Mock agent: ?mockagent=1 in the browser.
const useMockAgent =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("mockagent");

export type TurnStreamCallbacks = {
  /** Fired as soon as the model has committed language/tone (schema orders
   *  them before reply) — lets TTS pick the right voice language up front. */
  onMeta?: (meta: { language?: AgentResponse["language"]; tone?: AgentResponse["tone"] }) => void;
  /** Speakable reply text, incrementally. App state only comes
   *  from the resolved, validated AgentResponse. */
  onReplyDelta?: (text: string) => void;
};

function turnBody(
  history: ChatTurn[],
  stream: boolean,
  listener?: ListenerContext,
  transcript?: TranscriptHint,
  state?: string,
): string {
  // language = the gear-panel reply-language pin (default English);
  // promptContext = the live trip situation + immovable calendar items.
  // History goes through the ContextBuilder: old JSON state blobs reduce to
  // their spoken replies and the window is capped — 30 turns of chat must
  // not grow the prompt forever (authoritative state rides in promptContext
  // + the latest JSON turn).
  const window = buildTurnHistory(history);
  if (typeof console !== "undefined") {
    console.debug(`[context] history ${history.length}→${window.length} turns, ~${historyBytes(window)} chars`);
  }
  return JSON.stringify({
    history: window,
    language: useSettings.getState().language,
    promptContext: useStore.getState().promptContext(),
    ...(listener ? { listener } : {}),
    ...(transcript ? { transcript } : {}),
    ...(state ? { state } : {}),
    ...(stream ? { stream: true } : {}),
  });
}

/**
 * One call per turn — the endpoint runs the model, the runtime guard and the
 * one-shot retry server-side and returns a validated AgentResponse. The
 * The signal lets a superseded turn cancel the fetch,
 * which aborts the upstream Anthropic request as well.
 *
 * With opts.stream callbacks, the endpoint streams NDJSON: reply text is
 * delivered incrementally (spoken while the model still generates state) and
 * the returned promise still resolves to the complete validated response.
 */
export async function agentTurn(
  history: ChatTurn[],
  opts: {
    signal?: AbortSignal;
    stream?: TurnStreamCallbacks;
    listener?: ListenerContext;
    transcript?: TranscriptHint;
    /** Deterministic current-truth summary (outing constraints, party,
     *  known events) — becomes a system note server-side. */
    state?: string;
  } = {},
): Promise<AgentResponse> {
  if (useMockAgent) {
    const response = await mockAgentTurn(history);
    // Simulate the stream shape so the voice pipeline behaves identically.
    opts.stream?.onMeta?.({ language: response.language, tone: response.tone });
    opts.stream?.onReplyDelta?.(response.reply);
    return response;
  }

  if (opts.stream) {
    const res = await fetch("/api/michi/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: turnBody(history, true, opts.listener, opts.transcript, opts.state),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `turn endpoint failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: AgentResponse | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as {
          type: string;
          language?: AgentResponse["language"];
          tone?: AgentResponse["tone"];
          text?: string;
          response?: AgentResponse;
          error?: string;
        };
        if (ev.type === "meta") opts.stream.onMeta?.({ language: ev.language, tone: ev.tone });
        else if (ev.type === "reply" && ev.text) opts.stream.onReplyDelta?.(ev.text);
        else if (ev.type === "final" && ev.response) final = ev.response;
        else if (ev.type === "error") throw new Error(ev.error ?? "turn stream failed");
      }
    }
    if (!final) throw new Error("turn stream ended without a final response");
    return final;
  }

  const res = await fetch("/api/michi/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: turnBody(history, false, opts.listener, opts.transcript, opts.state),
    signal: opts.signal,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : `turn endpoint failed (${res.status})`,
    );
  }
  return body as unknown as AgentResponse;
}
