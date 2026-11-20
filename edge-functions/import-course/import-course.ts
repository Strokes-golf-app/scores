// Supabase Edge Function: import-course
// Deploy this as a Supabase Edge Function named `import-course`.
// It expects a JSON body containing:
//   { "externalId": "40977ee8-33ee-4195-b6a2-99a4ca83c2bc" }
// (an OpenGolfAPI course id, as returned by search-course)
//
// Lazy import with staleness: a fresh, fully-imported course (row +
// features already present, not older than OPENGOLFAPI_STALE_DAYS)
// returns immediately with ZERO upstream calls. Otherwise it fetches
// /courses/{id} and /features?course={id} from OpenGolfAPI, upserts
// golf_courses, and replaces golf_course_features atomically via the
// replace_golf_course_features RPC. Never called from the client
// directly — OpenGolfAPI is only ever reached from here and
// search-course.
//
// It uses no secrets — OpenGolfAPI's read endpoints are keyless — but
// does use the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional overrides: OPENGOLFAPI_BASE_URL, OPENGOLFAPI_USER_AGENT,
// OPENGOLFAPI_DAILY_LIMIT, OPENGOLFAPI_STALE_DAYS.

// --- API usage tracking -------------------------------------------------
// Reuses the existing api_usage table / consume_course_api_quota RPC
// under the same usage_key as search-course.ts ("opengolfapi"), so the
// two share one 500/day budget, matching how OpenGolfAPI's own rate
// limit is shared across every endpoint. Kept inline (not imported) so
// this deploys as a single file — if you change this, update it here
// AND in search-course/search-course.ts to keep both in sync.
const API_USAGE_SCOPE_KEY = "opengolfapi";
// --------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.example.com",
  "https://strokes-golf.vercel.app",
  "https://strokes-golf.app",
  "https://www.strokes-golf.app",
  "http://localhost:3000",
  "http://localhost:8000",
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

// Validated BEFORE any upstream call, on principle — a sibling
// OpenGolfAPI endpoint is known to leak a raw Postgres error string for
// a malformed id (confirmed live), inconsistent with how /courses/{id}
// itself cleanly 404s for the same bad input. Defending locally means
// we never depend on OpenGolfAPI validating its own input cleanly.
export function validateExternalCourseId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return null;
  return trimmed;
}

export function computeBackoffDelayMs(attempt: number): number {
  const base = attempt <= 2 ? 500 : 1500;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export function shouldBackOffFromRateLimitHeaders(remaining: number | null, resetAt: string | null, now: Date): boolean {
  const FLOOR = 10;
  if (remaining == null || !Number.isFinite(remaining)) return false;
  if (remaining > FLOOR) return false;
  if (!resetAt) return true;
  const resetTime = new Date(resetAt).getTime();
  if (Number.isNaN(resetTime)) return true;
  return now.getTime() < resetTime;
}

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

// A course is stale once strictly MORE than staleDays old — exactly
// staleDays old is still fresh.
export function isCourseStale(fetchedAt: string | number | Date, now: Date, staleDays: number): boolean {
  const fetchedTime = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedTime)) return true;
  const ageMs = now.getTime() - fetchedTime;
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}

export type ImportAction = "use-cache" | "refetch" | "degrade-to-stale" | "fail-no-data";

// `cachedRow` is null when nothing is cached yet. `hasFeatures` must
// reflect whether golf_course_features rows actually exist for this
// course, not just whether the golf_courses row exists — a prior run
// may have saved the scorecard but then hit the quota wall before
// importing geometry (see the handler's two independent quota checks),
// and that's a "refetch" case, not "use-cache".
export function decideImportAction(
  cachedRow: { fetchedAt: string; hasFeatures: boolean } | null,
  now: Date,
  staleDays: number,
  quotaAllowed: boolean
): ImportAction {
  const fresh = !!cachedRow && cachedRow.hasFeatures && !isCourseStale(cachedRow.fetchedAt, now, staleDays);
  if (fresh) return "use-cache";
  if (quotaAllowed) return "refetch";
  return cachedRow ? "degrade-to-stale" : "fail-no-data";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Keeps only {number, par, handicap_index, yardages} per hole — the
// geometry sub-fields (tee_coords, green.front/center/back,
// *_polygon, hazards) are dropped: observed null on every hole of
// every course tested, including the best-documented one. Real
// geometry lives only in golf_course_features.
export function stripHoleGeometryPlaceholders(holesData: unknown): Record<string, unknown>[] {
  if (!Array.isArray(holesData)) return [];
  return holesData.flatMap((h) => {
    if (!h || typeof h !== "object") return [];
    const hole = h as Record<string, unknown>;
    return [{
      number: num(hole.number),
      par: num(hole.par),
      handicap_index: num(hole.handicap_index),
      yardages: hole.yardages && typeof hole.yardages === "object" ? hole.yardages : null
    }];
  });
}

// Deliberately projects only fields the app consumes, tolerant of
// near-empty (St Andrews-shaped: tees:[], holes_data:[], most scalars
// null) and internally-inconsistent (Bobby Jones-shaped: `holes` field
// disagreeing with the actual holes_data array length) responses —
// must never throw on either, since both are real, observed API output.
export function normalizeCourseRow(detail: unknown, externalId: string): Record<string, unknown> {
  const d = detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {};
  return {
    external_id: externalId,
    course_name: str(d.course_name),
    club_name: str(d.club_name),
    city: str(d.city),
    state: str(d.state),
    country_iso: str(d.country_iso),
    lat: num(d.lat),
    lng: num(d.lng),
    type: str(d.type),
    par: num(d.par),
    holes: num(d.holes),
    yardage: num(d.yardage),
    timezone: str(d.timezone),
    architect: str(d.architect),
    year_built: num(d.year_built),
    description: str(d.description),
    description_source: d.description_source && typeof d.description_source === "object" ? d.description_source : null,
    fairway_grass: str(d.fairway_grass),
    green_grass: str(d.green_grass),
    phone: str(d.phone),
    website: str(d.website),
    address: str(d.address),
    postal_code: str(d.postal_code),
    facilities: d.facilities ?? null,
    ratings: d.ratings ?? null,
    sources: d.sources ?? null,
    tees: Array.isArray(d.tees) ? d.tees : null,
    holes_data: stripHoleGeometryPlaceholders(d.holes_data),
    climate: d.climate ?? null,
    nearby: d.nearby ?? null,
    pricing: d.pricing ?? null,
    booking_link: str(d.booking_link),
    insights: d.insights ?? null
  };
}

// 'bridge' is excluded — confirmed via live example payload to be an
// OSM-classifier false positive that swept in a real public road
// bridge near a course, not cart-path infrastructure.
export const EXCLUDED_FEATURE_TYPES = ["bridge"];

// Returns null (rather than a half-built row) for anything missing a
// feature_type or geometry — geometry is NOT NULL in golf_course_features,
// so a feature without one can't be stored at all.
export function normalizeFeature(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const featureType = str(f.feature_type);
  if (!featureType) return null;
  if (!f.geometry || typeof f.geometry !== "object") return null;

  const hole = typeof f.hole_number === "number" && Number.isFinite(f.hole_number) ? f.hole_number : null;

  return {
    external_feature_id: str(f.osm_id) ?? str(f.id),
    feature_type: featureType,
    hole, // null = course-level/ungrouped (observed on every St Andrews feature); never geometrically inferred
    geometry: f.geometry,
    center: f.center ?? null,
    tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t === "string") : null,
    confidence: num(f.confidence),
    source: str(f.source),
    license: str(f.license),
    is_approximate: featureType === "pin"
  };
}

export function filterFeatures(rawFeatures: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawFeatures)) return [];
  return rawFeatures.flatMap((raw) => {
    const normalized = normalizeFeature(raw);
    if (!normalized) return [];
    if (EXCLUDED_FEATURE_TYPES.includes(normalized.feature_type as string)) return [];
    return [normalized];
  });
}

// Maps DB column names (snake_case) to the client-facing JSON shape
// (camelCase) — used both for a freshly-imported course and a cached row.
export function courseRowToClientJson(row: Record<string, unknown>, stale: boolean): Record<string, unknown> {
  return {
    externalId: row.external_id ?? null,
    courseName: row.course_name ?? null,
    clubName: row.club_name ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    countryIso: row.country_iso ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    type: row.type ?? null,
    par: row.par ?? null,
    holes: row.holes ?? null,
    yardage: row.yardage ?? null,
    timezone: row.timezone ?? null,
    architect: row.architect ?? null,
    yearBuilt: row.year_built ?? null,
    description: row.description ?? null,
    descriptionSource: row.description_source ?? null,
    fairwayGrass: row.fairway_grass ?? null,
    greenGrass: row.green_grass ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    address: row.address ?? null,
    postalCode: row.postal_code ?? null,
    facilities: row.facilities ?? null,
    ratings: row.ratings ?? null,
    sources: row.sources ?? null,
    tees: row.tees ?? null,
    holesData: row.holes_data ?? null,
    climate: row.climate ?? null,
    nearby: row.nearby ?? null,
    pricing: row.pricing ?? null,
    bookingLink: row.booking_link ?? null,
    insights: row.insights ?? null,
    fetchedAt: row.fetched_at ?? null,
    stale
  };
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
      const staleDays = Number(getDenoEnv()?.get("OPENGOLFAPI_STALE_DAYS") ?? "30");
      const dailyLimit = Number(getDenoEnv()?.get("OPENGOLFAPI_DAILY_LIMIT") ?? "450");

      if (!supabaseUrl || !serviceRoleKey || !anonKey) {
        return jsonResponse({ error: "Course import is temporarily unavailable", course: null }, 500, headers);
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

      const externalId = validateExternalCourseId(body.externalId);
      if (!externalId) {
        return jsonResponse({ error: "A valid externalId is required" }, 400, headers);
      }

      const existing = await fetchExistingCourse(supabaseUrl, serviceRoleKey, externalId);
      const now = new Date();
      const cachedRowForDecision = existing
        ? { fetchedAt: existing.row.fetched_at as string, hasFeatures: existing.hasFeatures }
        : null;

      // Clean fresh hit: zero upstream calls, zero quota consumed.
      if (cachedRowForDecision && cachedRowForDecision.hasFeatures && !isCourseStale(cachedRowForDecision.fetchedAt, now, staleDays)) {
        return jsonResponse({
          course: courseRowToClientJson(existing!.row, false),
          featuresImported: true,
          limited: false
        }, 200, headers);
      }

      let quotaAllowed = false;
      try {
        quotaAllowed = await consumeCourseApiQuota(supabaseUrl, serviceRoleKey, API_USAGE_SCOPE_KEY, dailyLimit);
      } catch {
        quotaAllowed = false;
      }

      const action = decideImportAction(cachedRowForDecision, now, staleDays, quotaAllowed);

      if (action === "degrade-to-stale") {
        return jsonResponse({
          course: courseRowToClientJson(existing!.row, true),
          featuresImported: null,
          limited: true,
          message: "Showing a cached copy — live course data is temporarily unavailable."
        }, 200, headers);
      }

      if (action === "fail-no-data") {
        return jsonResponse({
          course: null,
          limited: true,
          message: "Course import is temporarily unavailable — try again shortly."
        }, 200, headers);
      }

      // action === "refetch"
      let detailResponse: Response;
      try {
        detailResponse = await fetchWithRetry(
          fetch,
          `${apiBaseUrl}/api/v1/courses/${encodeURIComponent(externalId)}`,
          { method: "GET", headers: { "User-Agent": userAgent, Accept: "application/json" } },
          3,
          8000
        );
      } catch {
        if (existing) {
          return jsonResponse({ course: courseRowToClientJson(existing.row, true), featuresImported: null, limited: false, upstreamError: true }, 200, headers);
        }
        return jsonResponse({ error: "Course import is temporarily unavailable", course: null }, 502, headers);
      }

      if (detailResponse.status === 404) {
        return jsonResponse({ error: "Course not found in OpenGolfAPI", course: null }, 422, headers);
      }

      if (!detailResponse.ok) {
        if (existing) {
          return jsonResponse({ course: courseRowToClientJson(existing.row, true), featuresImported: null, limited: false, upstreamError: true }, 200, headers);
        }
        return jsonResponse({ error: "Course import is temporarily unavailable", course: null }, 502, headers);
      }

      const detail = await detailResponse.json();
      const courseRow = normalizeCourseRow(detail, externalId);
      const savedRow = await upsertGolfCourse(supabaseUrl, serviceRoleKey, courseRow);

      // Second, independent quota check — a real, separate upstream call.
      let featuresQuotaAllowed = false;
      try {
        featuresQuotaAllowed = await consumeCourseApiQuota(supabaseUrl, serviceRoleKey, API_USAGE_SCOPE_KEY, dailyLimit);
      } catch {
        featuresQuotaAllowed = false;
      }

      if (!featuresQuotaAllowed) {
        return jsonResponse({
          course: courseRowToClientJson(savedRow, false),
          featuresImported: false,
          limited: true,
          message: "Course details saved — map geometry is temporarily unavailable, try again shortly."
        }, 200, headers);
      }

      let featuresResponse: Response;
      try {
        featuresResponse = await fetchWithRetry(
          fetch,
          `${apiBaseUrl}/api/v1/features?course=${encodeURIComponent(externalId)}`,
          { method: "GET", headers: { "User-Agent": userAgent, Accept: "application/json" } },
          3,
          8000
        );
      } catch {
        return jsonResponse({ course: courseRowToClientJson(savedRow, false), featuresImported: false, limited: false, upstreamError: true }, 200, headers);
      }

      if (!featuresResponse.ok) {
        return jsonResponse({ course: courseRowToClientJson(savedRow, false), featuresImported: false, limited: false, upstreamError: true }, 200, headers);
      }

      const featuresData = await featuresResponse.json();
      const rawFeatures = Array.isArray(featuresData?.features) ? featuresData.features : [];
      const normalizedFeatures = filterFeatures(rawFeatures);
      const featureCounts: Record<string, number> = {};
      normalizedFeatures.forEach((f) => {
        const t = f.feature_type as string;
        featureCounts[t] = (featureCounts[t] || 0) + 1;
      });

      await replaceGolfCourseFeatures(supabaseUrl, serviceRoleKey, savedRow.id as string, normalizedFeatures);

      return jsonResponse({
        course: courseRowToClientJson(savedRow, false),
        featuresImported: true,
        featureCounts,
        limited: false
      }, 200, headers);
    } catch {
      return jsonResponse({ error: "Unexpected server error", course: null }, 500, headers);
    }
  });
}

async function fetchExistingCourse(supabaseUrl: string, serviceRoleKey: string, externalId: string) {
  const url = `${supabaseUrl}/rest/v1/golf_courses?external_id=eq.${encodeURIComponent(externalId)}&select=*&limit=1`;
  const response = await fetch(url, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Accept: "application/json" }
  });
  if (!response.ok) return null;
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];

  const featuresUrl = `${supabaseUrl}/rest/v1/golf_course_features?course_id=eq.${encodeURIComponent(row.id)}&select=id&limit=1`;
  const featuresResponse = await fetch(featuresUrl, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, Accept: "application/json" }
  });
  let hasFeatures = false;
  if (featuresResponse.ok) {
    const featureRows = await featuresResponse.json();
    hasFeatures = Array.isArray(featureRows) && featureRows.length > 0;
  }

  return { row, hasFeatures };
}

async function upsertGolfCourse(supabaseUrl: string, serviceRoleKey: string, courseRow: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/rest/v1/golf_courses?on_conflict=external_id`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify({ ...courseRow, fetched_at: new Date().toISOString() })
  });
  if (!response.ok) {
    throw new Error(`Upsert golf_courses failed: ${response.status}`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function replaceGolfCourseFeatures(supabaseUrl: string, serviceRoleKey: string, courseId: string, features: Record<string, unknown>[]) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/replace_golf_course_features`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ p_course_id: courseId, p_features: features })
  });
  if (!response.ok) {
    throw new Error(`replace_golf_course_features failed: ${response.status}`);
  }
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
