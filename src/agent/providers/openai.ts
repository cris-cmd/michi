// OpenAI provider. Same contract as the Anthropic one: raw JSON text out,
// deltas while generating.
//
// Three differences worth knowing, all handled here so nothing downstream
// changes:
//
//  1. STRICT SCHEMA. OpenAI's strict mode requires EVERY property to appear
//     in `required` (optionality is expressed as a nullable type instead).
//     Our shared schema leaves `outing_change` optional, which Anthropic
//     accepts. `strictify()` adapts a copy at this boundary — the shared
//     schema stays untouched so the Anthropic path (and its byte-identical
//     cached prompt) is unaffected. `stripNulls()` then removes the nulls
//     the model emits for those widened fields, so parseAndValidate sees
//     exactly the shape it has always seen.
//
//  2. PROMPT CACHING IS AUTOMATIC. There is no `cache_control` to set —
//     OpenAI caches on prefix match. Our system prompt is already memoized
//     byte-identical per conversation and sent first, which is precisely
//     the shape automatic caching rewards.
//
//  3. REASONING EFFORT. Only the gpt-5 family takes `reasoning_effort`;
//     sending it to a non-reasoning model is an error, so it is gated.
//     MICHI_THINKING=disabled maps to "minimal" — the closest analogue to
//     Anthropic's thinking-off, and the same TTFT lever.

import OpenAI from "openai";
import type { Provider } from "./types";

const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = ENV.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set (server-side only).");
    client = new OpenAI({ apiKey });
  }
  return client;
}

type JsonSchema = Record<string, unknown>;

/** Keys we widened to satisfy strict mode, so their nulls can be dropped. */
function strictify(schema: JsonSchema, widened: string[], path = ""): JsonSchema {
  const out: JsonSchema = { ...schema };

  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const props = out.properties as Record<string, JsonSchema>;
    const required = Array.isArray(out.required) ? (out.required as string[]) : [];
    const nextProps: Record<string, JsonSchema> = {};

    for (const [key, value] of Object.entries(props)) {
      const child = strictify(value, widened, path ? `${path}.${key}` : key);
      if (!required.includes(key)) {
        // Optional under Anthropic → required-but-nullable under OpenAI.
        widened.push(path ? `${path}.${key}` : key);
        const t = child.type;
        nextProps[key] = {
          ...child,
          type: Array.isArray(t) ? [...new Set([...t, "null"])] : [t as string, "null"],
        };
      } else {
        nextProps[key] = child;
      }
    }

    out.properties = nextProps;
    out.required = Object.keys(nextProps);
    out.additionalProperties = false;
  }

  if (out.type === "array" && out.items && typeof out.items === "object") {
    out.items = strictify(out.items as JsonSchema, widened, `${path}[]`);
  }

  return out;
}

/** Drop the nulls that only exist because strict mode forced the field. */
function stripNulls(raw: string, widened: string[]): string {
  if (widened.length === 0) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // let parseAndValidate report it — don't mask the real error
  }
  const topLevel = new Set(widened.filter((k) => !k.includes(".") && !k.includes("[")));
  const obj = parsed as Record<string, unknown>;
  for (const key of topLevel) {
    if (obj[key] === null) delete obj[key];
  }
  return JSON.stringify(obj);
}

const REASONING_MODELS = /^(gpt-5|o[1-9])/;

export const openaiProvider: Provider = async (req, opts) => {
  const widened: string[] = [];
  const schema = strictify(req.schema, widened);

  const params = {
    model: req.model,
    messages: [
      { role: "system" as const, content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    max_completion_tokens: 16000,
    ...(REASONING_MODELS.test(req.model)
      ? { reasoning_effort: (req.thinkingDisabled ? "minimal" : req.effort) as "minimal" | "low" | "medium" | "high" }
      : {}),
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: req.schemaName, strict: true, schema },
    },
  };

  if (opts.onRawDelta) {
    const stream = await getClient().chat.completions.create(
      { ...params, stream: true },
      { signal: opts.signal },
    );
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        opts.onRawDelta(delta);
      }
      if (chunk.choices[0]?.finish_reason === "content_filter") {
        throw new Error("The model declined this request.");
      }
    }
    if (!text) throw new Error("No text in response");
    return stripNulls(text, widened);
  }

  const response = await getClient().chat.completions.create(params, { signal: opts.signal });
  const choice = response.choices[0];
  if (choice?.finish_reason === "content_filter") {
    throw new Error("The model declined this request.");
  }
  const text = choice?.message?.content;
  if (!text) throw new Error("No text in response");
  return stripNulls(text, widened);
};
