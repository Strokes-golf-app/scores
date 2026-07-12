// Supabase Edge Function: search-golf-course
// Deploy this as a Supabase Edge Function named `search-golf-course`.
// It expects a JSON body containing:
//   { "searchQuery": "Pebble Beach" }
//
// It uses the secret:
//   GOLF_COURSE_API_KEY
//
// It also uses the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

// --- API usage tracking -------------------------------------------------
// This app-wide counter is kept purely for observability (so we can see
// how many calls we're making against the Golf Course API day to day).
// It is NOT used to pre-emptively block requests — we don't try to
// predict when we'll run out. Instead, the Golf Course API itself is the
// source of truth: if we've hit our limit, it tells us with a 429, and
// we handle that gracefully below (empty results, no error surfaced to
// the user beyond falling back to manual course entry).
// Kept inline (rather than imported from a shared module) so this
// function can be deployed as a single file with no bundling of relative
// imports. If you ever need to change this, update it here AND in
// get-golf-course/index.ts to keep both functions in sync.
const API_USAGE_SCOPE_KEY = "app-wide";
// --------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GOLF_COURSE_API_KEY");
    const apiBaseUrl = Deno.env.get("GOLF_COURSE_API_BASE_URL") ?? "https://golf-api.com";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!apiKey) {
      return jsonResponse({ error: "Missing GOLF_COURSE_API_KEY secret" }, 500);
    }

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: "Missing Supabase Edge Function environment variables" }, 500);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const searchQuery = typeof body.searchQuery === "string" ? body.searchQuery.trim() : "";

    if (!searchQuery) {
      return jsonResponse({ error: "A non-empty searchQuery is required" }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    const usage = await getApiUsageRow(supabaseUrl, serviceRoleKey, today);

    const remoteUrl = `${apiBaseUrl}/v1/search?search_query=${encodeURIComponent(searchQuery)}`;
    const remoteResponse = await fetch(remoteUrl, {
      method: "GET",
      headers: {
        Authorization: `Key ${apiKey}`,
        Accept: "application/json"
      }
    });

    // Record that we made a call, regardless of outcome — this is for
    // tracking/analytics only and never gates whether the call happens.
    await incrementApiUsage(supabaseUrl, serviceRoleKey, today, usage.call_count);

    if (remoteResponse.status === 429) {
      console.warn("Golf Course API rate-limited this search request (429)");
      return jsonResponse({
        results: [],
        limited: true,
        message: "Course search is temporarily unavailable — try again shortly, or enter the course manually."
      }, 200);
    }

    if (!remoteResponse.ok) {
      const errorText = await remoteResponse.text();
      return jsonResponse({
        error: "Golf Course API request failed",
        details: errorText,
        results: []
      }, remoteResponse.status);
    }

    const remoteData = await remoteResponse.json();
    const rawResults = Array.isArray(remoteData?.courses)
      ? remoteData.courses
      : Array.isArray(remoteData?.results)
        ? remoteData.results
        : [];

    const normalizedResults = rawResults.map((course: Record<string, unknown>) => ({
      id: course.id ?? course.course_id ?? course.uuid ?? null,
      club_name: course.club_name ?? course.clubName ?? null,
      course_name: course.course_name ?? course.name ?? null,
      location: course.location ?? null,
      location_text: formatLocation(course.location)
    }));

    return jsonResponse({
      results: normalizedResults,
      limited: false
    }, 200);
  } catch (err) {
    return jsonResponse({
      error: "Unexpected server error",
      details: err instanceof Error ? err.message : String(err),
      results: []
    }, 500);
  }
});

async function getApiUsageRow(supabaseUrl: string, serviceRoleKey: string, date: string) {
  const url = `${supabaseUrl}/rest/v1/api_usage?select=call_count&usage_key=eq.${encodeURIComponent(API_USAGE_SCOPE_KEY)}&date=eq.${encodeURIComponent(date)}`;

  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to read api_usage row: ${response.status}`);
  }

  const data = await response.json();
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;

  if (!row) {
    const insertResponse = await fetch(`${supabaseUrl}/rest/v1/api_usage`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        usage_key: API_USAGE_SCOPE_KEY,
        call_count: 0,
        date
      })
    });

    if (!insertResponse.ok) {
      throw new Error(`Failed to create api_usage row: ${insertResponse.status}`);
    }

    return { call_count: 0 };
  }

  return { call_count: Number(row.call_count ?? 0) };
}

// Best-effort usage tracking: logs a warning instead of throwing if this
// fails, since a tracking hiccup should never prevent a real course
// search/lookup from returning results to the user.
async function incrementApiUsage(supabaseUrl: string, serviceRoleKey: string, date: string, currentCount: number) {
  try {
    const url = `${supabaseUrl}/rest/v1/api_usage?usage_key=eq.${encodeURIComponent(API_USAGE_SCOPE_KEY)}&date=eq.${encodeURIComponent(date)}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ call_count: currentCount + 1 })
    });

    if (!response.ok) {
      console.warn(`Failed to increment api_usage: ${response.status}`);
    }
  } catch (err) {
    console.warn("Failed to increment api_usage", err instanceof Error ? err.message : err);
  }
}

function formatLocation(location: unknown) {
  if (!location || typeof location !== "object") {
    return "";
  }

  const loc = location as Record<string, unknown>;
  const parts = [loc.city, loc.state, loc.country].filter(Boolean);
  return parts.join(", ");
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
