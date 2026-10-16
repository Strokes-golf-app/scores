import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCorsHeaders,
  authenticateRequest,
  validateSearchRequest,
  computeBackoffDelayMs,
  shouldBackOffFromRateLimitHeaders,
  fetchWithRetry,
  normalizeSearchResults,
} from '../edge-functions/search-course/search-course.ts';

describe('search-course security', () => {
  it('allows only configured origins, including the Capacitor iOS origin', () => {
    expect(buildCorsHeaders('https://strokes-golf.app')['Access-Control-Allow-Origin']).toBe('https://strokes-golf.app');
    expect(buildCorsHeaders('capacitor://localhost')['Access-Control-Allow-Origin']).toBe('capacitor://localhost');
    expect(buildCorsHeaders('https://evil.example.com')['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects missing or invalid bearer tokens', async () => {
    const noToken = await authenticateRequest(
      new Request('https://example.com', { method: 'POST' }),
      'https://project.supabase.co', 'anon-key'
    );
    expect(noToken.ok).toBe(false);
    expect(noToken.status).toBe(401);
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

describe('validateSearchRequest', () => {
  it('accepts a text query alone', () => {
    expect(validateSearchRequest({ query: 'Pebble Beach' })).toEqual({
      query: 'Pebble Beach', lat: null, lng: null, radiusMi: 25, state: null,
    });
  });

  it('accepts a lat/lng location alone, defaulting and clamping radiusMi', () => {
    expect(validateSearchRequest({ lat: 56.35, lng: -2.8 })).toEqual({
      query: null, lat: 56.35, lng: -2.8, radiusMi: 25, state: null,
    });
    expect(validateSearchRequest({ lat: 56.35, lng: -2.8, radiusMi: 500 }).radiusMi).toBe(50);
    expect(validateSearchRequest({ lat: 56.35, lng: -2.8, radiusMi: 0 }).radiusMi).toBe(1);
  });

  it('rejects when neither a query nor a complete lat/lng pair is given', () => {
    expect(validateSearchRequest({})).toBeNull();
    expect(validateSearchRequest({ lat: 56.35 })).toBeNull();
    expect(validateSearchRequest(null)).toBeNull();
  });

  it('rejects an out-of-range lat/lng', () => {
    expect(validateSearchRequest({ lat: 999, lng: -2.8 })).toBeNull();
    expect(validateSearchRequest({ lat: 56.35, lng: -999 })).toBeNull();
  });

  it('rejects a too-short or too-long query', () => {
    expect(validateSearchRequest({ query: 'A' })).toBeNull();
    expect(validateSearchRequest({ query: 'x'.repeat(200) })).toBeNull();
  });

  it('passes through a valid state filter', () => {
    expect(validateSearchRequest({ query: 'Bobby Jones', state: 'GA' }).state).toBe('GA');
  });
});

describe('computeBackoffDelayMs', () => {
  it('centers attempt 2 around 500ms and attempt 3 around 1500ms, within +/-20% jitter', () => {
    for (let i = 0; i < 20; i++) {
      const d2 = computeBackoffDelayMs(2);
      expect(d2).toBeGreaterThanOrEqual(400);
      expect(d2).toBeLessThanOrEqual(600);
      const d3 = computeBackoffDelayMs(3);
      expect(d3).toBeGreaterThanOrEqual(1200);
      expect(d3).toBeLessThanOrEqual(1800);
    }
  });
});

describe('shouldBackOffFromRateLimitHeaders', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('does not back off when remaining is comfortably above the floor', () => {
    expect(shouldBackOffFromRateLimitHeaders(100, '2026-10-12T00:00:00Z', now)).toBe(false);
  });

  it('backs off when remaining is at or below the floor and reset is still in the future', () => {
    expect(shouldBackOffFromRateLimitHeaders(10, '2026-10-12T00:00:00Z', now)).toBe(true);
    expect(shouldBackOffFromRateLimitHeaders(0, '2026-10-12T00:00:00Z', now)).toBe(true);
  });

  it('stops backing off once the reset time has passed', () => {
    expect(shouldBackOffFromRateLimitHeaders(2, '2026-10-11T00:00:00Z', now)).toBe(false);
  });

  it('ignores a missing or non-numeric remaining header', () => {
    expect(shouldBackOffFromRateLimitHeaders(null, '2026-10-12T00:00:00Z', now)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  // Fake timers so the real ~500ms/1500ms backoff delays don't slow down
  // the suite — each test still exercises the real retry/backoff logic.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('succeeds on the 3rd attempt after two 503s', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    });
    const promise = fetchWithRetry(fakeFetch, 'https://example.com', {}, 3, 8000);
    await vi.runAllTimersAsync();
    const response = await promise;
    expect(response.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('never retries a 429 — returns it immediately', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 429 }));
    const response = await fetchWithRetry(fakeFetch, 'https://example.com', {}, 3, 8000);
    expect(response.status).toBe(429);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('never retries a deterministic 4xx', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 400 }));
    const response = await fetchWithRetry(fakeFetch, 'https://example.com', {}, 3, 8000);
    expect(response.status).toBe(400);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the final failed response after exhausting retries on repeated 5xx', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const promise = fetchWithRetry(fakeFetch, 'https://example.com', {}, 3, 8000);
    await vi.runAllTimersAsync();
    const response = await promise;
    expect(response.status).toBe(503);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on a network error', async () => {
    const fakeFetch = vi.fn(async () => { throw new Error('network down'); });
    const promise = fetchWithRetry(fakeFetch, 'https://example.com', {}, 3, 8000);
    const assertion = expect(promise).rejects.toThrow('network down');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });
});

describe('normalizeSearchResults', () => {
  it('projects only the real OpenGolfAPI field names, dropping entries with no id', () => {
    const raw = {
      results: [
        { id: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc', course_name: 'Pebble Beach Golf Links', city: 'Pebble Beach', state: 'CA', country_iso: 'US', lat: 36.5685, lng: -121.949, type: 'Resort/Public', par: 72, holes: 18, completeness: 0 },
        { course_name: 'No id, should be dropped' },
      ],
    };
    const results = normalizeSearchResults(raw);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      externalId: '40977ee8-33ee-4195-b6a2-99a4ca83c2bc',
      courseName: 'Pebble Beach Golf Links',
      clubName: null,
      city: 'Pebble Beach',
      state: 'CA',
      countryIso: 'US',
      lat: 36.5685,
      lng: -121.949,
      type: 'Resort/Public',
      par: 72,
      holes: 18,
      distanceMi: null,
    });
    // `completeness` is deliberately not in the projection -- observed
    // non-functional (always 0) in live testing.
    expect(results[0]).not.toHaveProperty('completeness');
  });

  it('reads distance_mi on a geo search result', () => {
    const raw = { results: [{ id: 'abc', distance_mi: 0.71 }] };
    expect(normalizeSearchResults(raw)[0].distanceMi).toBe(0.71);
  });

  it('returns an empty array for malformed input', () => {
    expect(normalizeSearchResults(null)).toEqual([]);
    expect(normalizeSearchResults({})).toEqual([]);
    expect(normalizeSearchResults({ results: 'not an array' })).toEqual([]);
  });
});
