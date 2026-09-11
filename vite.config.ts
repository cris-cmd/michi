import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// Secrets are loaded into the Node process only. The browser uses the
// same-origin /api/michi endpoints defined below, and the production build
// is scanned for accidental credential exposure.

const SERVER_ONLY_ENV_KEYS = [
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ELEVEN_LABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "MICHI_MODEL",
  "MICHI_PROVIDER",
  "MICHI_EFFORT",
  "EFFORT",
  "MICHI_THINKING",
  "MICHI_DAILY_TURN_CAP",
  "MICHI_TRUST_PROXY",
  "PERXONA_API_BASE_URL",
  "PERXONA_CONNECT_EMAIL",
  "PERXONA_CONNECT_PASSWORD",
  "PERXONA_ACCESS_TOKEN",
  "PERXONA_PRESENTER_URL",
  "PERXONA_AVATAR_ID",
  "PERXONA_SCENE_ID",
  "PERXONA_VOICE_ID",
  "PORT",
];

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

const michiApi = (): Plugin => ({
  name: "michi-api",
  configureServer(server: ViteDevServer) {
    server.middlewares.use("/api/michi", (req, res, next) => {
      void (async () => {
        const path = (req.url ?? "").split("?")[0];
        const knownGet = req.method === "GET" && ["/kit", "/connect-token", "/voice", "/affect"].includes(path);
        const knownPost = req.method === "POST" && ["/turn", "/voice", "/affect"].includes(path);
        if (!knownGet && !knownPost) {
          next();
          return;
        }
        // ssrLoadModule keeps the server code in the Vite transform pipeline.
        const handlers = () => server.ssrLoadModule("/src/server/handlers.ts");

        const gate = await server.ssrLoadModule("/src/server/gate.ts");
        const family =
          path === "/turn" ? "turn" : path === "/voice" ? "voice" : path === "/affect" ? "affect" : "other";
        const verdict = gate.checkGate(gate.peerIp(req), family);
        if (!verdict.ok) {
          send(res, verdict.status, "application/json", JSON.stringify({ error: verdict.error }));
          return;
        }

        if (path === "/voice" && req.method === "GET") {
          const h = await handlers();
          send(res, 200, "application/json", JSON.stringify({ available: h.voiceAvailable() }));
          return;
        }
        if (path === "/kit" && req.method === "GET") {
          const px = await server.ssrLoadModule("/src/server/perxona.ts");
          send(res, 200, "application/json", JSON.stringify(px.kitConfig()));
          return;
        }
        if (path === "/connect-token" && req.method === "GET") {
          const px = await server.ssrLoadModule("/src/server/perxona.ts");
          const result = await px.handleConnectToken();
          send(res, result.status, "application/json", JSON.stringify(result.json));
          return;
        }
        if (path === "/affect" && req.method === "GET") {
          const af = await server.ssrLoadModule("/src/server/affect.ts");
          send(res, 200, "application/json", JSON.stringify(af.prewarmAffect()));
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const message = String(err);
          send(res, message.includes("body too large") ? 413 : 400, "application/json", JSON.stringify({ error: message }));
          return;
        }

        const ctrl = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) ctrl.abort();
        });

        const h = await handlers();

        // Stream reply phrases before the full structured response is ready.
        if (path === "/turn" && (body as { stream?: boolean } | null)?.stream) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-store");
          await h.handleTurnStream(body, ctrl.signal, (ev: unknown) => {
            if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`);
          });
          if (!res.writableEnded) res.end();
          return;
        }

        if (path === "/affect") {
          const af = await server.ssrLoadModule("/src/server/affect.ts");
          const result = await af.handleAffect(body);
          send(res, result.status, "application/json", JSON.stringify(result.json ?? {}));
          return;
        }

        const result =
          path === "/turn"
            ? await h.handleTurn(body, ctrl.signal)
            : await h.handleVoice(body, ctrl.signal);
        if (res.writableEnded) return;
        if (result.audio) {
          send(res, result.status, "audio/mpeg", new Uint8Array(result.audio as ArrayBuffer));
        } else {
          send(res, result.status, "application/json", JSON.stringify(result.json ?? {}));
        }
      })().catch((err) => {
        if (!res.writableEnded) {
          send(res, 500, "application/json", JSON.stringify({ error: String(err) }));
        }
      });
    });
  },
});

export default defineConfig(({ mode }) => {
  // This mutates only the Node process running Vite; no values are serialized.
  const env = loadEnv(mode, process.cwd(), "");
  for (const key of SERVER_ONLY_ENV_KEYS) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  return {
    plugins: [react(), tailwindcss(), michiApi()],
    // The app does not use client-side environment variables.
    envPrefix: "PUBLIC_",
    build: {
      // The generated catalogue is intentionally large but highly compressible.
      // Keep it separate so application and vendor code can be cached independently.
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.endsWith("/src/data/activities.json")) return "catalogue";
            if (id.includes("/node_modules/")) return "vendor";
          },
        },
      },
    },
    server: {
      ...(env.NGROK_HOST ? { allowedHosts: [env.NGROK_HOST] } : {}),
    },
  };
});
