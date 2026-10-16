import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import {
  buildCorsHeaders,
  authenticateRequest,
  base64url,
  pemToDer,
  importMapKitSigningKey,
  buildMapKitClaims,
  signMapKitJwt,
} from '../edge-functions/mapkit-token/mapkit-token.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawFixture = readFileSync(path.join(__dirname, 'fixtures/mapkit-test-key.pem'), 'utf-8');
// The fixture file leads with a "TEST-ONLY" comment banner (not valid PEM) --
// extract just the actual key block.
const TEST_KEY_PEM = rawFixture.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/)[0];

describe('mapkit-token security', () => {
  it('allows only configured origins, including the Capacitor iOS origin', () => {
    expect(buildCorsHeaders('https://strokes-golf.app')['Access-Control-Allow-Origin']).toBe('https://strokes-golf.app');
    expect(buildCorsHeaders('capacitor://localhost')['Access-Control-Allow-Origin']).toBe('capacitor://localhost');
    expect(buildCorsHeaders('https://evil.example.com')['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects missing or invalid bearer tokens', async () => {
    const result = await authenticateRequest(
      new Request('https://example.com', { method: 'POST' }),
      'https://project.supabase.co', 'anon-key'
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('accepts a verified Supabase user from the Authorization header', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'user-123' }) }));
    const auth = await authenticateRequest(
      new Request('https://example.com', { method: 'POST', headers: { Authorization: 'Bearer good-token' } }),
      'https://project.supabase.co', 'anon-key'
    );
    expect(auth.ok).toBe(true);
    expect(auth.userId).toBe('user-123');
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes with no padding or URL-unsafe characters', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 62, 63]);
    const encoded = base64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(Buffer.from(encoded, 'base64url'))).toEqual(Array.from(bytes));
  });
});

describe('pemToDer / importMapKitSigningKey', () => {
  it('parses the test PEM into a usable PKCS8 ECDSA P-256 private key', async () => {
    const key = await importMapKitSigningKey(TEST_KEY_PEM);
    expect(key.type).toBe('private');
    expect(key.algorithm.name).toBe('ECDSA');
    expect(key.algorithm.namedCurve).toBe('P-256');
  });
});

describe('buildMapKitClaims', () => {
  it('computes iat/exp from the given epoch ms and ttl, omitting origin by default', () => {
    const now = 1760000000000;
    const claims = buildMapKitClaims('TEAM123', now, 1800);
    expect(claims.iss).toBe('TEAM123');
    expect(claims.iat).toBe(Math.floor(now / 1000));
    expect(claims.exp).toBe(Math.floor(now / 1000) + 1800);
    expect(claims.origin).toBeUndefined();
  });

  it('includes the origin claim only when explicitly passed', () => {
    const claims = buildMapKitClaims('TEAM123', Date.now(), 1800, 'https://strokes-golf.app');
    expect(claims.origin).toBe('https://strokes-golf.app');
  });
});

describe('signMapKitJwt — real ES256 sign+verify round-trip', () => {
  it('produces a JWT with the right shape, a 30-minute expiry, and a genuinely valid ES256 signature', async () => {
    const teamId = 'TEST1234AB';
    const keyId = 'TESTKEYID1';
    const now = Date.now();
    const token = await signMapKitJwt(teamId, keyId, TEST_KEY_PEM, now);

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [headerB64, claimsB64, sigB64] = parts;

    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
    const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf-8'));
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: keyId });
    expect(claims.iss).toBe(teamId);
    expect(claims.exp - claims.iat).toBe(1800);
    expect(claims.origin).toBeUndefined();

    // Independently verify the signature: derive the PUBLIC key from the
    // same test private key via Node's crypto, import it separately into
    // Web Crypto for verification, and confirm it validates. This is a
    // genuine round-trip check, not just re-running the same signing code.
    const nodePublicKey = createPublicKey(createPrivateKey(TEST_KEY_PEM));
    const publicKeyDer = nodePublicKey.export({ type: 'spki', format: 'der' });
    const verifyKey = await crypto.subtle.importKey(
      'spki', publicKeyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );

    const signingInput = `${headerB64}.${claimsB64}`;
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      Buffer.from(sigB64, 'base64url'),
      new TextEncoder().encode(signingInput)
    );
    expect(valid).toBe(true);
  });

  it('includes the origin claim in the signed token only when explicitly passed', async () => {
    const token = await signMapKitJwt('TEAM', 'KEY', TEST_KEY_PEM, Date.now(), 'https://strokes-golf.app');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    expect(claims.origin).toBe('https://strokes-golf.app');
  });

  it('produces a different signature for a tampered payload (sanity check the signature is load-bearing)', async () => {
    const token = await signMapKitJwt('TEAM', 'KEY', TEST_KEY_PEM, Date.now());
    const [headerB64, claimsB64, sigB64] = token.split('.');
    const tamperedClaims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf-8'));
    tamperedClaims.iss = 'ATTACKER';
    const tamperedClaimsB64 = base64url(new TextEncoder().encode(JSON.stringify(tamperedClaims)));

    const nodePublicKey = createPublicKey(createPrivateKey(TEST_KEY_PEM));
    const publicKeyDer = nodePublicKey.export({ type: 'spki', format: 'der' });
    const verifyKey = await crypto.subtle.importKey(
      'spki', publicKeyDer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      Buffer.from(sigB64, 'base64url'),
      new TextEncoder().encode(`${headerB64}.${tamperedClaimsB64}`)
    );
    expect(valid).toBe(false);
  });
});
