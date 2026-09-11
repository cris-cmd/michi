import { createServer, request } from "node:http";

process.env.MICHI_DAILY_TURN_CAP = "1";
process.env.MICHI_TRUST_PROXY = "false";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;
delete process.env.OPENAI_API_KEY;

const { peerIp } = await import("../src/server/gate");
const { handleTurn, handleVoice } = await import("../src/server/handlers");
const { handleApiRequest } = await import("../src/server/httpApp");

let failures = 0;
function check(pass: boolean, label: string): void {
  console.log(`${pass ? "✓" : "✗"} ${label}`);
  if (!pass) failures++;
}

check(
  peerIp({ headers: { "x-forwarded-for": "203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } }) ===
    "127.0.0.1",
  "forwarded client IP is ignored unless a trusted proxy is configured",
);

const invalidTurn = await handleTurn({});
check(invalidTurn.status === 400, "invalid turn is rejected before consuming daily model budget");

const koreanVoice = await handleVoice({ text: "hello", lang: "ko" });
check(
  koreanVoice.status === 400 && JSON.stringify(koreanVoice.json).includes("en|ja|zh"),
  "voice validation reports exactly the supported languages",
);

const validBody = { history: [{ role: "user", content: "Find dinner." }] };
const firstTurn = await handleTurn(validBody);
check(firstTurn.status === 503, "first valid turn reaches provider configuration");
const cappedTurn = await handleTurn(validBody);
check(cappedTurn.status === 429, "daily model budget applies to validated turns");

const server = createServer((req, res) => {
  void handleApiRequest(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

async function statusFor(path: string, method: string, body?: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers: body ? { "Content-Type": "application/json", "Content-Length": body.byteLength } : undefined,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

check((await statusFor("/api/michi/turn", "GET")) === 404, "unsupported method returns 404");
check(
  (await statusFor("/api/michi/voice", "POST", Buffer.alloc(1_000_001, 0x20))) === 413,
  "request bodies over one megabyte return 413",
);

await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

if (failures) process.exit(1);
