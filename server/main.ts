// Production server for the static bundle and /api/michi routes.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { handleApiRequest } from "../src/server/httpApp";

const PORT = Number(process.env.PORT ?? 8787);
const DIST = join(process.cwd(), "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/index.html not found — run `npm run build` first (or use `npm run serve`).");
  process.exit(1);
}

const server = createServer((req, res) => {
  void (async () => {
    if (await handleApiRequest(req, res)) return;

    // Static SPA: exact file if present, else index.html (client routing).
    const path = normalize((req.url ?? "/").split("?")[0]).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, path === "/" ? "index.html" : path);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(DIST, "index.html");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    createReadStream(file).pipe(res);
  })().catch((err) => {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
});

server.listen(PORT, () => {
  console.log(`michi serving dist/ + /api/michi on http://localhost:${PORT}`);
  console.log("  request rate limits enabled");
  // Warm the affect models while nobody is talking yet.
  void import("../src/server/affect").then((m) => m.prewarmAffect()).catch(() => {});
});
