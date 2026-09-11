// Server-only Perxona authentication and presenter configuration.
//
//   GET /api/michi/kit           → { presenterUrl, target } | { available:false }
//   GET /api/michi/connect-token → { connect_token }        | { error }
//
// Tokens are cached in memory and refreshed once after an authentication
// failure. PERXONA_ACCESS_TOKEN can seed the cache for short-lived testing.

import type { PresentationTarget } from "@perxona/presenter-types";

const ENV =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const API_BASE = () => ENV.PERXONA_API_BASE_URL;
const DEFAULT_PRESENTER_URL = "https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js";

export type KitConfig = {
  available: boolean;
  presenterUrl?: string;
  target?: PresentationTarget;
  reason?: string;
};

/** Static presenter config from env — no upstream call, safe to poll. */
export function kitConfig(): KitConfig {
  const avatarId = ENV.PERXONA_AVATAR_ID;
  const sceneId = ENV.PERXONA_SCENE_ID;
  const hasAuth = Boolean(
    (ENV.PERXONA_CONNECT_EMAIL && ENV.PERXONA_CONNECT_PASSWORD) || ENV.PERXONA_ACCESS_TOKEN,
  );
  if (!API_BASE() || !avatarId || !sceneId || !hasAuth) {
    return {
      available: false,
      reason:
        "Perxona is not configured — set PERXONA_API_BASE_URL, PERXONA_AVATAR_ID, " +
        "PERXONA_SCENE_ID and credentials (PERXONA_CONNECT_EMAIL/PASSWORD or " +
        "PERXONA_ACCESS_TOKEN) in .env. The app falls back to the browser-speech avatar.",
    };
  }
  return {
    available: true,
    presenterUrl: ENV.PERXONA_PRESENTER_URL || DEFAULT_PRESENTER_URL,
    target: {
      avatarId,
      sceneId,
      // Keep a voiceId set even though the primary voice is ElevenLabs:
      // tier-2 present() degradation fails with VOICE_NOT_CONFIGURED without it.
      ...(ENV.PERXONA_VOICE_ID ? { voiceId: ENV.PERXONA_VOICE_ID } : {}),
    },
  };
}

/** Cached shared bearer; may be pre-seeded from PERXONA_ACCESS_TOKEN. */
let cachedToken: string | null = ENV.PERXONA_ACCESS_TOKEN || null;
let loginPromise: Promise<string> | null = null;

async function login(): Promise<string> {
  const email = ENV.PERXONA_CONNECT_EMAIL;
  const password = ENV.PERXONA_CONNECT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Perxona token rejected and no PERXONA_CONNECT_EMAIL/PASSWORD to re-login with " +
        "(PERXONA_ACCESS_TOKEN values expire after issuance).",
    );
  }
  const res = await fetch(`${API_BASE()}/api/v1/connect/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Perxona login failed (${res.status})`);
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error("Perxona login returned no access_token");
  return access_token;
}

async function getToken(forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken;
  if (forceRefresh) cachedToken = null;
  // De-dupe concurrent callers into one upstream login (rate limit: 5/s).
  loginPromise ??= login()
    .then((t) => (cachedToken = t))
    .finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

/** Cheap authenticated probe — validates the cached token before it ships to the browser. */
async function tokenValid(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE()}/api/v1/connect/voices`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new Error(`Perxona upstream probe failed (${res.status})`);
  return true;
}

/**
 * Mint/reuse the shared Connect bearer for presenter.initialize() /
 * refreshConnectToken(). A cached token rejected upstream triggers one
 * re-login before it ever reaches the browser.
 */
export async function handleConnectToken(): Promise<{ status: number; json: unknown }> {
  if (!kitConfig().available) {
    return { status: 503, json: { error: kitConfig().reason } };
  }
  try {
    let token = await getToken();
    if (!(await tokenValid(token))) {
      token = await getToken(true);
      if (!(await tokenValid(token))) throw new Error("fresh Perxona token rejected upstream");
    }
    return { status: 200, json: { connect_token: token } };
  } catch (err) {
    return { status: 502, json: { error: err instanceof Error ? err.message : String(err) } };
  }
}
