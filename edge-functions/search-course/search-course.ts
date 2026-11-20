// Supabase Edge Function: search-course
// Deploy this as a Supabase Edge Function named `search-course`.
// It expects a JSON body containing EITHER (or both):
//   { "query": "Pebble Beach" }
//   { "lat": 36.5685, "lng": -121.949, "radiusMi": 25 }
// plus an optional "state" filter. Text search alone is unreliable for
// famous multi-word course names (confirmed live: "St Andrews Old
// Course" is unfindable by name, only by location) — callers should
// offer a "search by location" fallback, not assume text search always
// works.
//
// It uses no secrets — OpenGolfAPI's read endpoints are keyless — but
// does use the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional overrides: OPENGOLFAPI_BASE_URL, OPENGOLFAPI_USER_AGENT,
// OPENGOLFAPI_DAILY_LIMIT.

// --- API usage tracking -------------------------------------------------
// Reuses the existing api_usage table / consume_course_api_quota RPC
// (shared with search-golf-course/get-golf-course) under a distinct
// usage_key, so OpenGolfAPI's 500/day shared budget is tracked
// independently of the unrelated golfcourseapi.com quota. Kept inline
// (not imported) so this deploys as a single file — if you change this,
// update it here AND in import-course/import-course.ts to keep both in
// sync.
const API_USAGE_SCOPE_KEY = "opengolfapi";
// --------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.example.com",
  "https://strokes-golf.vercel.app",
  "https://strokes-golf.app",
  "https://www.strokes-golf.app",
  "http://localhost:3000",
  "http://localhost:8000",
  // Capacitor's WKWebView (iOS) serves the app from this fixed origin.
  "capacitor://localhost"
];

function getDenoEnv() {
  return (globalThis as any).Deno?.env;
}

export function getAllowedOrigins(): string[] {
  const env = getDenoEnv();
  const configured = [
    env?.get("APP_ORIGIN"),
    env?.get("SITE_URL"),
    env?.get("WEBAPP_URL"),
    env?.get("VERCEL_URL") ? `https://${env.get("VERCEL_URL")}` : null,
    env?.get("SUPABASE_URL")
  ].filter(Boolean) as string[];

  return [...new Set([...configured, ...DEFAULT_ALLOWED_ORIGINS])];
}

export function buildCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const allowed = getAllowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };

  if (!requestOrigin || !allowed.includes(requestOrigin)) {
    return headers;
  }

  headers["Access-Control-Allow-Origin"] = requestOrigin;
  return headers;
}

export async function authenticateRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { ok: false, status: 401, userId: null };
  }

  const token = match[1].trim();
  if (!token || token.length > 2048) {
    return { ok: false, status: 401, userId: null };
  }

  try {
    const authUrl = new URL("/auth/v1/user", supabaseUrl.endsWith("/") ? supabaseUrl : `${supabaseUrl}/`);
    const response = await fetch(authUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return { ok: false, status: 401, userId: null };
    }

    const payload = await response.json();
    const userId = typeof payload?.id === "string" ? payload.id : null;
    if (!userId) {
      return { ok: false, status: 401, userId: null };
    }

    return { ok: true, status: 200, userId };
  } catch {
    return { ok: false, status: 401, userId: null };
  }
}

export interface SearchRequest {
  query: string | null;
  lat: number | null;
  lng: number | null;
  radiusMi: number;
  state: string | null;
}

// At least one of `query` or (`lat` AND `lng`) is required — this is the
// one place that's enforced, since the client's "search by location"
// fallback must be a genuinely usable alternative, not an afterthought.
export function validateSearchRequest(body: unknown): SearchRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  let query: string | null = null;
  if (b.query !== undefined && b.query !== null) {
    if (typeof b.query !== "string") return null;
    const trimmed = b.query.trim();
    if (trimmed.length < 2 || trimmed.length > 120) return null;
    query = trimmed;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  if (b.lat !== undefined || b.lng !== undefined) {
    if (typeof b.lat !== "number" || typeof b.lng !== "number") return null;
    if (!Number.isFinite(b.lat) || b.lat < -90 || b.lat > 90) return null;
    if (!Number.isFinite(b.lng) || b.lng < -180 || b.lng > 180) return null;
    lat = b.lat;
    lng = b.lng;
  }

  if (query === null && (lat === null || lng === null)) return null;

  let radiusMi = 25;
  if (b.radiusMi !== undefined && b.radiusMi !== null) {
    if (typeof b.radiusMi !== "number" || !Number.isFinite(b.radiusMi)) return null;
    radiusMi = Math.max(1, Math.min(50, b.radiusMi));
  }

  let state: string | null = null;
  if (b.state !== undefined && b.state !== null) {
    if (typeof b.state !== "string") return null;
    const trimmed = b.state.trim();
    if (!trimmed || trimmed.length > 10) return null;
    state = trimmed;
  }

  return { query, lat, lng, radiusMi, state };
}

// Backoff curve: attempt 2 fires ~500ms after attempt 1, attempt 3 fires
// ~1500ms after attempt 2, each ±20% jitter. `attempt` is the number of
// the attempt ABOUT to be made (2 or 3) — there's no delay before attempt 1.
export function computeBackoffDelayMs(attempt: number): number {
  const base = attempt <= 2 ? 500 : 1500;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

// OpenGolfAPI's 500/day limit is shared across every endpoint — this is
// a second, independent layer of politeness beyond our own daily-cap
// bookkeeping: if the API's own live x-ratelimit-remaining header says
// we're nearly out, back off even if our own counter hasn't caught up
// yet (ours only tracks calls WE'VE made this way; a key shared with
// other consumers, or a miscounted day boundary, could drift). "Back
// off" here means the caller should mark the response `limited: true`
// rather than making another near-term call — never a hard refusal of
// data already fetched.
export function shouldBackOffFromRateLimitHeaders(remaining: number | null, resetAt: string | null, now: Date): boolean {
  const FLOOR = 10;
  if (remaining == null || !Number.isFinite(remaining)) return false;
  if (remaining > FLOOR) return false;
  if (!resetAt) return true;
  const resetTime = new Date(resetAt).getTime();
  if (Number.isNaN(resetTime)) return true;
  return now.getTime() < resetTime;
}

// Retries only network errors/timeouts and 5xx — never 429 (a retry
// there just burns another unit of the scarce daily quota for no
// benefit, since the reset is daily, not momentary) or other 4xx
// (deterministic, retrying won't change the outcome). `fetchImpl` is
// injected so tests can stub multiple distinct responses across
// attempts without touching globalThis.fetch.
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxAttempts: number,
  perAttemptTimeoutMs: number
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, computeBackoffDelayMs(attempt)));
    }
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(perAttemptTimeoutMs) });
      if (response.ok) return response;
      if (response.status === 429 || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastError = new Error(`Upstream ${response.status}`);
      if (attempt === maxAttempts) return response;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) throw lastError;
    }
  }
  throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
}

function parseIntHeader(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Projects only the fields the app consumes. Field names match
// OpenGolfAPI's REAL live response shape (verified by direct testing),
// not the (inaccurate) schema documented in its own openapi.json.
export function normalizeSearchResults(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.results) ? r.results
    : Array.isArray(r.courses) ? r.courses
    : Array.isArray(raw) ? raw
    : [];

  return list.flatMap((c: unknown) => {
    if (!c || typeof c !== "object") return [];
    const course = c as Record<string, unknown>;
    const externalId = typeof course.id === "string" ? course.id : null;
    if (!externalId) return [];
    return [{
      externalId,
      courseName: typeof course.course_name === "string" ? course.course_name : null,
      clubName: typeof course.club_name === "string" ? course.club_name : null,
      city: typeof course.city === "string" ? course.city : null,
      state: typeof course.state === "string" ? course.state : null,
      countryIso: typeof course.country_iso === "string" ? course.country_iso : null,
      lat: typeof course.lat === "number" ? course.lat : null,
      lng: typeof course.lng === "number" ? course.lng : null,
      type: typeof course.type === "string" ? course.type : null,
      par: typeof course.par === "number" ? course.par : null,
      holes: typeof course.holes === "number" ? course.holes : null,
      distanceMi: typeof course.distance_mi === "number" ? course.distance_mi : null
    }];
  });
}

const denoRuntime = (globalThis as any).Deno;
if (denoRuntime && typeof denoRuntime.serve === "function") {
  denoRuntime.serve(async (req: Request) => {
    const headers = buildCorsHeaders(req.headers.get("origin"));

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers });
    }

    try {
      const supabaseUrl = getDenoEnv()?.get("SUPABASE_URL");
      const anonKey = getDenoEnv()?.get("SUPABASE_ANON_KEY") ?? getDenoEnv()?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const serviceRoleKey = getDenoEnv()?.get("SUPABASE_SERVICE_ROLE_KEY");
      const apiBaseUrl = (getDenoEnv()?.get("OPENGOLFAPI_BASE_URL") || "https://api.opengolfapi.org").replace(/\/+$/, "");
      const userAgent = getDenoEnv()?.get("OPENGOLFAPI_USER_AGENT") || "StrokesGolf/1.0 (+https://strokes-golf.app)";

      if (!supabaseUrl || !serviceRoleKey || !anonKey) {
        return jsonResponse({ error: "Course search is temporarily unavailable", results: [] }, 500, headers);
      }

      const auth = await authenticateRequest(req, supabaseUrl, anonKey);
      if (!auth.ok) {
        return jsonResponse({ error: "Unauthorized" }, auth.status, headers);
      }

      let body: Record<string, unknown> = {};
      try {
        body = await req.json();
      } catch {
        body = {};
      }

      const parsed = validateSearchRequest(body);
      if (!parsed) {
        return jsonResponse({ error: "A search query, or a location (lat + lng), is required" }, 400, headers);
      }

      const dailyLimit = Number(getDenoEnv()?.get("OPENGOLFAPI_DAILY_LIMIT") ?? "450");
      const quotaAllowed = await consumeCourseApiQuota(supabaseUrl, serviceRoleKey, API_USAGE_SCOPE_KEY, dailyLimit);
      if (!quotaAllowed) {
        return jsonResponse({
          results: [],
          limited: true,
          message: "Course search is temporarily unavailable — try again shortly."
        }, 200, headers);
      }

      const params = new URLSearchParams();
      if (parsed.query) params.set("q", parsed.query);
      if (parsed.lat != null && parsed.lng != null) {
        params.set("lat", String(parsed.lat));
        params.set("lng", String(parsed.lng));
        params.set("radius_mi", String(parsed.radiusMi));
      }
      if (parsed.state) params.set("state", parsed.state);

      const remoteUrl = `${apiBaseUrl}/api/v1/courses/search?${params.toString()}`;

      let remoteResponse: Response;
      try {
        remoteResponse = await fetchWithRetry(fetch, remoteUrl, {
          method: "GET",
          headers: { "User-Agent": userAgent, Accept: "application/json" }
        }, 3, 8000);
      } catch {
        return jsonResponse({ error: "Course search is temporarily unavailable", results: [] }, 502, headers);
      }

      if (remoteResponse.status === 429) {
        return jsonResponse({
          results: [],
          limited: true,
          message: "Course search is temporarily unavailable — try again shortly."
        }, 200, headers);
      }

      if (!remoteResponse.ok) {
        return jsonResponse({ error: "Course search is temporarily unavailable", results: [] }, 502, headers);
      }

      const nearRateLimit = shouldBackOffFromRateLimitHeaders(
        parseIntHeader(remoteResponse.headers.get("x-ratelimit-remaining")),
        remoteResponse.headers.get("x-ratelimit-reset"),
        new Date()
      );

      const remoteData = await remoteResponse.json();
      const results = normalizeSearchResults(remoteData);

      return jsonResponse({ results, limited: nearRateLimit }, 200, headers);
    } catch {
      return jsonResponse({ error: "Unexpected server error", results: [] }, 500, headers);
    }
  });
}

async function consumeCourseApiQuota(supabaseUrl: string, serviceRoleKey: string, usageKey: string, dailyLimit: number) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_course_api_quota`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      p_usage_key: usageKey,
      p_daily_limit: dailyLimit
    })
  });

  if (!response.ok) {
    throw new Error(`Quota check failed: ${response.status}`);
  }

  const data = await response.json();
  return data === true;
}

function jsonResponse(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
