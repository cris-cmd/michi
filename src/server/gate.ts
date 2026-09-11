// In-memory per-IP limits plus a daily cap for model turns. These limits are
// process-local and should be replaced by shared storage in a scaled deploy.

const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const PER_MINUTE: Record<string, number> = { turn: 10, voice: 60, affect: 40, other: 60 };
const DAILY_TURN_CAP = () => {
  const value = Number(ENV.MICHI_DAILY_TURN_CAP ?? 500);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 500;
};
const TRUST_PROXY = () => /^(1|true)$/i.test(ENV.MICHI_TRUST_PROXY ?? "");

type Bucket = { windowStart: number; count: number };
const buckets = new Map<string, Bucket>();
let dailyTurns = { day: "", count: 0 };

export type GateResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Rate-cap check for an API call. `route` picks the rate family; `ip` should
 * be the socket peer unless a trusted proxy is explicitly configured.
 */
export function checkGate(ip: string, route: "turn" | "voice" | "affect" | "other"): GateResult {
  const now = Date.now();
  const key = `${ip}:${route}`;
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > 60_000) {
    buckets.set(key, { windowStart: now, count: 1 });
  } else if (++bucket.count > PER_MINUTE[route]) {
    return { ok: false, status: 429, error: "slow down a little — too many requests" };
  }
  if (buckets.size > 5000) buckets.clear(); // crude memory bound; caps self-rebuild

  return { ok: true };
}

/** Consume daily model budget only after a turn request passes validation. */
export function consumeTurnBudget(): GateResult {
  const day = new Date().toDateString();
  if (dailyTurns.day !== day) dailyTurns = { day, count: 0 };
  if (++dailyTurns.count > DAILY_TURN_CAP()) {
    return { ok: false, status: 429, error: "Michi has hit today's conversation budget — try again tomorrow" };
  }
  return { ok: true };
}

/** Peer address helper shared by the server entries. */
export function peerIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = TRUST_PROXY() ? req.headers["x-forwarded-for"] : undefined;
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}
