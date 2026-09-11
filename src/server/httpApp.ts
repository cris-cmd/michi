// The /api/michi/* router as a plain (req, res) handler — used by the
// production server (server/main.ts). The Vite
// dev middleware keeps its own ~equivalent wiring (it needs ssrLoadModule);
// everything meaningful lives in the handler modules either way.
//
// Affect is a dynamic import: if the in-process ONNX models cannot load,
// /affect reports unavailable — the browser's probe then falls back to
// rule acks (designed degradation, not an error).

import type { IncomingMessage, ServerResponse } from "node:http";
import { checkGate, peerIp } from "./gate";
import * as handlers from "./handlers";
import * as perxona from "./perxona";

type MaybeParsed = IncomingMessage & { body?: unknown };

function readJsonBody(req: MaybeParsed): Promise<unknown> {
  // Some hosts pre-parse JSON bodies; plain node streams.
  if (req.body !== undefined && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > 1_000_000) {
        settled = true;
        reject(new Error("body too large"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array): void {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json", JSON.stringify(value ?? {}));

type AffectModule = {
  prewarmAffect: () => unknown;
  handleAffect: (body: unknown) => Promise<{ status: number; json: unknown }>;
};
let affectModule: Promise<AffectModule | null> | null = null;
function affect(): Promise<AffectModule | null> {
  affectModule ??= import("./affect")
    .then((m) => m as AffectModule)
    .catch(() => null);
  return affectModule;
}

/**
 * Handle one API request. Returns false when the path is not ours (the
 * caller serves static files / 404s).
 */
export async function handleApiRequest(req: MaybeParsed, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith("/api/michi/")) return false;
  const path = url.slice("/api/michi".length).split("?")[0];
  const knownGet = req.method === "GET" && ["/kit", "/connect-token", "/voice", "/affect"].includes(path);
  const knownPost = req.method === "POST" && ["/turn", "/voice", "/affect"].includes(path);
  if (!knownGet && !knownPost) {
    json(res, 404, { error: "not found" });
    return true;
  }
  const ip = peerIp(req as { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } });

  try {
    const family =
      path === "/turn" ? "turn" : path === "/voice" ? "voice" : path === "/affect" ? "affect" : "other";
    const gate = checkGate(ip, family);
    if (!gate.ok) {
      json(res, gate.status, { error: gate.error });
      return true;
    }

    if (path === "/kit" && req.method === "GET") {
      json(res, 200, perxona.kitConfig());
      return true;
    }
    if (path === "/connect-token" && req.method === "GET") {
      const result = await perxona.handleConnectToken();
      json(res, result.status, result.json);
      return true;
    }
    if (path === "/voice" && req.method === "GET") {
      json(res, 200, { available: handlers.voiceAvailable() });
      return true;
    }
    if (path === "/affect" && req.method === "GET") {
      const m = await affect();
      json(res, 200, m ? m.prewarmAffect() : { available: false });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const message = String(err);
      json(res, message.includes("body too large") ? 413 : 400, { error: message });
      return true;
    }

    // Browser abort (stale turn) aborts upstream work.
    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });

    if (path === "/affect") {
      const m = await affect();
      if (!m) {
        json(res, 503, { error: "affect models not deployed in this runtime" });
        return true;
      }
      const result = await m.handleAffect(body);
      json(res, result.status, result.json);
      return true;
    }

    if (path === "/turn" && (body as { stream?: boolean } | null)?.stream) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store");
      await handlers.handleTurnStream(body, ctrl.signal, (ev) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
      });
      if (!res.writableEnded) res.end();
      return true;
    }

    const result =
      path === "/turn"
        ? await handlers.handleTurn(body, ctrl.signal)
        : await handlers.handleVoice(body, ctrl.signal);
    if (res.writableEnded) return true;
    if (result.audio) send(res, result.status, "audio/mpeg", new Uint8Array(result.audio));
    else json(res, result.status, result.json);
    return true;
  } catch (err) {
    if (!res.writableEnded) json(res, 500, { error: String(err) });
    return true;
  }
}
