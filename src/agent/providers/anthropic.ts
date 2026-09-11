// Anthropic provider. The system prompt is memoized in core.ts so prompt
// caching can be reused across turns.

import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./types";

const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = ENV.ANTHROPIC_API_KEY ?? ENV.CLAUDE_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY or CLAUDE_API_KEY is not set (server-side only).");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export const anthropicProvider: Provider = async (req, opts) => {
  const isHaiku = req.model.includes("haiku");
  const params = {
    model: req.model,
    max_tokens: 16000, // adaptive thinking counts toward max_tokens on Opus/Sonnet 5
    ...(!isHaiku && req.thinkingDisabled ? { thinking: { type: "disabled" as const } } : {}),
    output_config: {
      ...(isHaiku ? {} : { effort: req.effort }),
      format: { type: "json_schema" as const, schema: req.schema },
    },
    system: [
      {
        type: "text" as const,
        text: req.system,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: req.messages,
  };

  if (opts.onRawDelta) {
    const stream = getClient().messages.stream(params, { signal: opts.signal });
    stream.on("text", opts.onRawDelta);
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("No text block in response");
    return text.text;
  }

  const response = await getClient().messages.create(params, { signal: opts.signal });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No text block in response");
  return text.text;
};
