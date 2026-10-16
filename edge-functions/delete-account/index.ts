// Supabase Edge Function: delete-account
// Verifies the caller, removes their application data through a server-only
// RPC, then deletes their Supabase Auth user with the server-side service key.

type EnvReader = {
  get(name: string): string | undefined;
};

type DenoRuntime = {
  env?: EnvReader;
  serve?: (handler: (req: Request) => Promise<Response>) => void;
};

type Fetcher = typeof fetch;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://strokes-golf.vercel.app",
  "https://strokes-golf.app",
  "https://www.strokes-golf.app",
  "http://localhost:3000",
  "http://localhost:8000",
  "capacitor://localhost"
];

function getRuntimeEnv(): EnvReader | undefined {
  return (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno?.env;
}

function getAllowedOrigins(env: EnvReader): string[] {
  const configured = [
    env.get("APP_ORIGIN"),
    env.get("SITE_URL"),
    env.get("WEBAPP_URL"),
    env.get("VERCEL_URL") ? `https://${env.get("VERCEL_URL")}` : null
  ].filter((origin): origin is string => Boolean(origin));
  return [...new Set([...configured, ...DEFAULT_ALLOWED_ORIGINS])];
}

function buildCorsHeaders(origin: string | null, env: EnvReader): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  if (origin && getAllowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(
  body: Record<string, string>,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

export async function handleDeleteAccountRequest(
  req: Request,
  env: EnvReader | undefined = getRuntimeEnv(),
  fetcher: Fetcher = fetch
): Promise<Response> {
  const headers = buildCorsHeaders(req.headers.get("origin"), env ?? { get: () => undefined });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, headers);
  }
  if (!env) {
    return jsonResponse({ error: "Account deletion is temporarily unavailable" }, 500, headers);
  }

  const supabaseUrl = env.get("SUPABASE_URL");
  const anonKey = env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Account deletion is temporarily unavailable" }, 500, headers);
  }

  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!bearer || bearer[1].length > 4096) {
    return jsonResponse({ error: "Please sign in again and retry account deletion" }, 401, headers);
  }

  let userResponse: Response;
  try {
    userResponse = await fetcher(new URL("/auth/v1/user", supabaseUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer[1]}`, apikey: anonKey },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return jsonResponse({ error: "Could not verify your account. Please retry." }, 503, headers);
  }

  if (!userResponse.ok) {
    return jsonResponse({ error: "Please sign in again and retry account deletion" }, 401, headers);
  }

  let user: { id?: unknown; is_anonymous?: unknown };
  try {
    user = await userResponse.json();
  } catch {
    return jsonResponse({ error: "Could not verify your account. Please retry." }, 502, headers);
  }
  if (typeof user.id !== "string" || user.is_anonymous === true) {
    return jsonResponse({ error: "A signed-in account is required for account deletion" }, 403, headers);
  }

  let cleanupResponse: Response;
  try {
    cleanupResponse = await fetcher(new URL("/rest/v1/rpc/delete_account_data", supabaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_user_id: user.id }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    return jsonResponse({ error: "Could not remove account data. Please retry." }, 503, headers);
  }
  if (!cleanupResponse.ok) {
    return jsonResponse({ error: "Could not remove account data. Please retry." }, 502, headers);
  }

  let deleteResponse: Response;
  try {
    deleteResponse = await fetcher(
      new URL(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, supabaseUrl),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey
        },
        signal: AbortSignal.timeout(15000)
      }
    );
  } catch {
    return jsonResponse({ error: "Account data was removed, but account deletion did not finish. Please retry." }, 503, headers);
  }
  if (!deleteResponse.ok) {
    return jsonResponse({ error: "Account data was removed, but account deletion did not finish. Please retry." }, 502, headers);
  }

  return jsonResponse({ message: "Account deleted" }, 200, headers);
}

const denoRuntime = (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno;
if (denoRuntime && typeof denoRuntime.serve === "function") {
  denoRuntime.serve((req) => handleDeleteAccountRequest(req));
}
