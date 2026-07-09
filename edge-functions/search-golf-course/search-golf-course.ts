// Supabase Edge Function: search-golf-course
// Deploy this as a Supabase Edge Function named `search-golf-course`.
// It expects a JSON body containing:
//   { "searchQuery": "Pebble Beach", "userId": "<uuid>" }
//
// It uses the secret:
//   GOLF_COURSE_API_KEY
//
// It also uses the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req) => {
  // Handle the CORS preflight request.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Wrap the whole handler so any thrown error still returns CORS headers.
  // Without this, an uncaught throw (e.g. from the api_usage helpers) produces
  // a bare 500 with no CORS headers, which shows up in the browser as a
  // misleading "CORS error" even though the real problem is elsewhere.
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
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (!searchQuery) {
      return jsonResponse({ error: "A non-empty searchQuery is required" }, 400);
    }

    if (!userId) {
      return jsonResponse({ error: "A valid userId is required" }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    const usage = await getApiUsageRow(supabaseUrl, serviceRoleKey, userId, today);

    if (usage.call_count >= 50) {
      return jsonResponse({
        results: [],
        limited: true,
        message: "Daily API limit reached"
      }, 200);
    }

    const remoteUrl = `${apiBaseUrl}/v1/search?search_query=${encodeURIComponent(searchQuery)}`;
    const remoteResponse = await fetch(remoteUrl, {
      method: "GET",
      headers: {
        Authorization: `Key ${apiKey}`,
        Accept: "application/json"
      }
    });

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

    await incrementApiUsage(supabaseUrl, serviceRoleKey, userId, today);

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

async function getApiUsageRow(supabaseUrl: string, serviceRoleKey: string, userId: string, date: string) {
  const url = `${supabaseUrl}/rest/v1/api_usage?select=call_count&user_id=eq.${encodeURIComponent(userId)}&date=eq.${encodeURIComponent(date)}`;

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
        user_id: userId,
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

async function incrementApiUsage(supabaseUrl: string, serviceRoleKey: string, userId: string, date: string) {
  const url = `${supabaseUrl}/rest/v1/api_usage?user_id=eq.${encodeURIComponent(userId)}&date=eq.${encodeURIComponent(date)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ call_count: "call_count + 1" })
  });

  if (!response.ok) {
    throw new Error(`Failed to increment api_usage: ${response.status}`);
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
