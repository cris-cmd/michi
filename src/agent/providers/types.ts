// The provider seam. Everything above it — prompt building, the ack
// continuation note, streamExtract, parseAndValidate, the one-shot retry —
// is provider-neutral and works on plain strings. A provider's only job is:
// take a system prompt + alternating messages + a JSON schema, return the
// model's raw JSON text, and (optionally) emit deltas while it generates.
//
// That is the whole contract. Adding a provider means implementing ONE
// function; nothing downstream changes.

export type ProviderMessage = { role: "user" | "assistant"; content: string };

export type ProviderRequest = {
  model: string;
  system: string;
  messages: ProviderMessage[];
  /** Schema name (OpenAI requires one; Anthropic ignores it). */
  schemaName: string;
  schema: Record<string, unknown>;
  /** Reasoning depth. Providers map this onto their own knob. */
  effort: "low" | "medium" | "high";
  /** MICHI_THINKING=disabled — the measured TTFT win. */
  thinkingDisabled: boolean;
};

export type ProviderOptions = {
  /** A superseded turn aborts here to avoid spending tokens on stale work. */
  signal?: AbortSignal;
  /** Set on the first attempt only; receives raw JSON text as it generates. */
  onRawDelta?: (delta: string) => void;
};

/** Returns the model's raw response text — expected to be one JSON object. */
export type Provider = (req: ProviderRequest, opts: ProviderOptions) => Promise<string>;
