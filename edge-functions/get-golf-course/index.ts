// Supabase Edge Function: get-golf-course
// Deploy this as a Supabase Edge Function named `get-golf-course`.
// It expects a JSON body containing:
//   { "courseId": 123, "userId": "<uuid>" }
//
// It uses the secret:
//   GOLF_COURSE_API_KEY
//
// It also uses the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

Deno.serve(async (req) => {
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

  const courseId = body.courseId;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";

  if (!courseId) {
    return jsonResponse({ error: "A valid courseId is required" }, 400);
  }

  if (!userId) {
    return jsonResponse({ error: "A valid userId is required" }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const usage = await getApiUsageRow(supabaseUrl, serviceRoleKey, userId, today);

  if (usage.call_count >= 50) {
    return jsonResponse({
      error: "Daily API limit reached",
      limited: true,
      results: null
    }, 200);
  }

  const remoteUrl = `${apiBaseUrl}/v1/courses/${encodeURIComponent(String(courseId))}`;
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
      results: null
    }, remoteResponse.status);
  }

  const remoteData = await remoteResponse.json();
  const teeGroups = remoteData?.tees && typeof remoteData.tees === "object"
    ? Object.values(remoteData.tees as Record<string, unknown>)
    : [];

  let holeData: Array<Record<string, unknown>> = [];
  for (const teeGroup of teeGroups) {
    const firstSet = Array.isArray(teeGroup) ? teeGroup[0] : null;
    if (firstSet && Array.isArray(firstSet.holes) && firstSet.holes.length > 0) {
      holeData = firstSet.holes as Array<Record<string, unknown>>;
      break;
    }
  }

  if (holeData.length === 0) {
    return jsonResponse({
      error: "No hole data was returned by the Golf Course API",
      results: null
    }, 422);
  }

  await incrementApiUsage(supabaseUrl, serviceRoleKey, userId, today);

  return jsonResponse({
    id: remoteData.id ?? courseId,
    club_name: remoteData.club_name ?? remoteData.clubName ?? null,
    course_name: remoteData.course_name ?? remoteData.name ?? null,
    location: remoteData.location ?? null,
    pars: holeData.map((hole) => Number(hole.par ?? 0)),
    handicaps: holeData.map((hole) => Number(hole.handicap ?? hole.stroke_index ?? 0)),
    hole_count: holeData.length,
    limited: false
  }, 200);
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
