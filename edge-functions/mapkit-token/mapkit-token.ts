// Supabase Edge Function: mapkit-token
// Deploy this as a Supabase Edge Function named `mapkit-token`.
// POST with an empty/optional JSON body. Requires a logged-in user
// (same Bearer-token check as every other data-bearing function in this
// repo) — without that, this would be an unauthenticated public
// token-minting endpoint for your MapKit Team ID.
//
// It uses the secrets:
//   MAPKIT_TEAM_ID
//   MAPKIT_KEY_ID
//   MAPKIT_PRIVATE_KEY   (PEM text; store with literal \n escapes —
//                         Supabase secrets are single-line — this file
//                         unescapes them before use)
//
// It also uses the standard Supabase Edge Function env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY as a fallback)
//
// Signs an ES256 JWT for MapKit JS entirely with the Web Crypto API —
// no external import, matching this repo's "single self-contained
// file" edge-function convention. Web Crypto's ECDSA signature output
// is already the raw r‖s concatenation ES256 JWTs require, so no
// DER-to-raw reformatting is needed.
//
// Expiry: 30 minutes. The client refreshes via MapKit JS's documented
// authorizationCallback renewal mechanism, not long-term caching.
//
// `origin` claim: OMITTED BY DEFAULT. It's documented as a
// browser-embedding restriction, and Capacitor's WKWebView origin
// (capacitor://localhost) isn't a normal https origin — it's unverified
// whether MapKit JS validates it sensibly against that scheme. THIS
// NEEDS PHYSICAL-DEVICE VERIFICATION, which an AI agent cannot do.
// Documented fallback if the no-origin default fails on-device: pass an
// originClaim listing both "https://strokes-golf.app" and
// "capacitor://localhost" to signMapKitJwt — contingent on confirming
// MapKit JS's origin claim even supports multiple values, which is
// itself unverified.

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

export function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pemToDer(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function importMapKitSigningKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

export function buildMapKitClaims(teamId: string, now: number, ttlSeconds: number, originClaim?: string): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: teamId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSeconds
  };
  if (originClaim) claims.origin = originClaim;
  return claims;
}

export async function signMapKitJwt(
  teamId: string,
  keyId: string,
  privateKeyPem: string,
  now: number,
  originClaim?: string
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid: keyId };
  const claims = buildMapKitClaims(teamId, now, 1800, originClaim);

  const encodedHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  const key = await importMapKitSigningKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(signature)}`;
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
      const teamId = getDenoEnv()?.get("MAPKIT_TEAM_ID");
      const keyId = getDenoEnv()?.get("MAPKIT_KEY_ID");
      const privateKeyRaw = getDenoEnv()?.get("MAPKIT_PRIVATE_KEY");

      if (!supabaseUrl || !anonKey) {
        return jsonResponse({ error: "MapKit token is temporarily unavailable" }, 500, headers);
      }

      const auth = await authenticateRequest(req, supabaseUrl, anonKey);
      if (!auth.ok) {
        return jsonResponse({ error: "Unauthorized" }, auth.status, headers);
      }

      if (!teamId || !keyId || !privateKeyRaw) {
        return jsonResponse({ error: "MapKit is not configured" }, 500, headers);
      }

      const privateKeyPem = privateKeyRaw.replace(/\\n/g, "\n");
      const now = Date.now();
      const token = await signMapKitJwt(teamId, keyId, privateKeyPem, now);
      const expiresAt = new Date(now + 1800 * 1000).toISOString();

      return jsonResponse({ token, expiresAt }, 200, headers);
    } catch {
      return jsonResponse({ error: "Unexpected server error" }, 500, headers);
    }
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
