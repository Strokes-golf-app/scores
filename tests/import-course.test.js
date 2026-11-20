import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCorsHeaders,
  authenticateRequest,
  validateExternalCourseId,
  isCourseStale,
  decideImportAction,
  stripHoleGeometryPlaceholders,
  normalizeCourseRow,
  normalizeFeature,
  filterFeatures,
  EXCLUDED_FEATURE_TYPES,
  courseRowToClientJson,
  computeBackoffDelayMs,
  shouldBackOffFromRateLimitHeaders,
  fetchWithRetry,
} from '../edge-functions/import-course/import-course.ts';

describe('import-course security', () => {
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

describe('validateExternalCourseId', () => {
  it('accepts a real OpenGolfAPI UUID-shaped id', () => {
    expect(validateExternalCourseId('40977ee8-33ee-4195-b6a2-99a4ca83c2bc')).toBe('40977ee8-33ee-4195-b6a2-99a4ca83c2bc');
  });

  it('rejects path-traversal-shaped and overlong strings, and non-strings', () => {
    expect(validateExternalCourseId('../../etc/passwd')).toBeNull();
    expect(validateExternalCourseId('x'.repeat(65))).toBeNull();
    expect(validateExternalCourseId(12345)).toBeNull();
    expect(validateExternalCourseId(null)).toBeNull();
    expect(validateExternalCourseId('')).toBeNull();
  });
});

describe('isCourseStale', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');

  it('is fresh exactly staleDays old', () => {
    const fetchedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isCourseStale(fetchedAt, now, 30)).toBe(false);
  });

  it('is stale one second past staleDays old', () => {
    const fetchedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString();
    expect(isCourseStale(fetchedAt, now, 30)).toBe(true);
  });

  it('treats an unparseable date as stale', () => {
    expect(isCourseStale('not-a-date', now, 30)).toBe(true);
  });
});

describe('decideImportAction', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const freshFetchedAt = now.toISOString();
  const staleFetchedAt = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  it('uses the cache when fresh and features are already imported', () => {
    expect(decideImportAction({ fetchedAt: freshFetchedAt, hasFeatures: true }, now, 30, true)).toBe('use-cache');
    // Still use-cache even if quota happened to be denied -- a fresh hit never needs it.
    expect(decideImportAction({ fetchedAt: freshFetchedAt, hasFeatures: true }, now, 30, false)).toBe('use-cache');
  });

  it('refetches when fresh but features were never imported (scorecard-only partial import)', () => {
    expect(decideImportAction({ fetchedAt: freshFetchedAt, hasFeatures: false }, now, 30, true)).toBe('refetch');
  });

  it('refetches when stale and quota allows', () => {
    expect(decideImportAction({ fetchedAt: staleFetchedAt, hasFeatures: true }, now, 30, true)).toBe('refetch');
  });

  it('degrades to the stale cached copy when quota is denied but a row exists', () => {
    expect(decideImportAction({ fetchedAt: staleFetchedAt, hasFeatures: true }, now, 30, false)).toBe('degrade-to-stale');
  });

  it('fails with no data when nothing is cached and quota is denied', () => {
    expect(decideImportAction(null, now, 30, false)).toBe('fail-no-data');
  });

  it('refetches when nothing is cached and quota allows', () => {
    expect(decideImportAction(null, now, 30, true)).toBe('refetch');
  });
});

describe('stripHoleGeometryPlaceholders', () => {
  it('keeps only number/par/handicap_index/yardages, dropping always-null geometry fields', () => {
    const holesData = [{
      number: 1, par: 4, handicap_index: 6,
      yardages: { red: 310, white: 337, blue: 378 },
      tee_coords: null, green: { center: null, front: null, back: null },
      green_polygon: null, fairway_polygon: null, hazards: [],
    }];
    expect(stripHoleGeometryPlaceholders(holesData)).toEqual([
      { number: 1, par: 4, handicap_index: 6, yardages: { red: 310, white: 337, blue: 378 } },
    ]);
  });

  it('returns an empty array for non-array input', () => {
    expect(stripHoleGeometryPlaceholders(null)).toEqual([]);
    expect(stripHoleGeometryPlaceholders(undefined)).toEqual([]);
  });
});

describe('normalizeCourseRow', () => {
  it('projects a fully-populated course without throwing', () => {
    const detail = {
      course_name: 'Pebble Beach Golf Links', club_name: null, city: 'Pebble Beach', state: 'CA',
      country_iso: 'US', lat: 36.5685, lng: -121.949, type: 'Resort/Public', par: 72, holes: 18,
      yardage: 6828, architect: 'Jack Neville and Douglas Grant', year_built: 1919,
      description_source: { name: 'Wikipedia', url: 'https://en.wikipedia.org/x', license: 'CC BY-SA 4.0' },
      holes_data: [{ number: 1, par: 4, handicap_index: 6, yardages: { white: 337 }, green_polygon: null }],
      insights: { hazard_count: 46, bunker_count: 11 },
    };
    const row = normalizeCourseRow(detail, '40977ee8-33ee-4195-b6a2-99a4ca83c2bc');
    expect(row.external_id).toBe('40977ee8-33ee-4195-b6a2-99a4ca83c2bc');
    expect(row.course_name).toBe('Pebble Beach Golf Links');
    expect(row.description_source).toEqual({ name: 'Wikipedia', url: 'https://en.wikipedia.org/x', license: 'CC BY-SA 4.0' });
    expect(row.holes_data).toEqual([{ number: 1, par: 4, handicap_index: 6, yardages: { white: 337 } }]);
  });

  it('tolerates a near-empty (St Andrews-shaped) detail without throwing', () => {
    const detail = { course_name: 'Old Course', city: 'St Andrews', tees: [], holes_data: [], par: null, holes: null };
    expect(() => normalizeCourseRow(detail, 'abc')).not.toThrow();
    const row = normalizeCourseRow(detail, 'abc');
    expect(row.course_name).toBe('Old Course');
    expect(row.par).toBeNull();
    expect(row.holes_data).toEqual([]);
  });

  it('tolerates an internally-inconsistent (Bobby Jones-shaped) detail without throwing', () => {
    // `holes: 18` disagrees with the actual holes_data length (16) -- normalizeCourseRow
    // must store both as given, not try to reconcile them.
    const detail = {
      course_name: 'Bobby Jones Golf Course The Cupp Links', holes: 18,
      holes_data: Array.from({ length: 16 }, (_, i) => ({ number: i + 1, par: 4, handicap_index: null, yardages: null })),
    };
    expect(() => normalizeCourseRow(detail, 'xyz')).not.toThrow();
    const row = normalizeCourseRow(detail, 'xyz');
    expect(row.holes).toBe(18);
    expect(row.holes_data).toHaveLength(16);
  });

  it('tolerates completely missing/malformed input', () => {
    expect(() => normalizeCourseRow(null, 'abc')).not.toThrow();
    expect(() => normalizeCourseRow(undefined, 'abc')).not.toThrow();
    expect(normalizeCourseRow(null, 'abc').external_id).toBe('abc');
  });
});

describe('normalizeFeature / filterFeatures', () => {
  const polygonFeature = {
    id: 'f1', osm_id: 'way/679342887', feature_type: 'green', hole_number: 7,
    geometry: { type: 'Polygon', coordinates: [[[-121, 36], [-121, 36.001], [-120.999, 36.001], [-120.999, 36], [-121, 36]]] },
    center: { lat: 36.0005, lng: -120.9995 }, tags: ['golf=green'], confidence: 0.7, source: 'osm', license: 'odbl',
  };

  it('normalizes a well-formed feature, preserving hole number and MultiPolygon geometry equally', () => {
    const normalized = normalizeFeature(polygonFeature);
    expect(normalized.feature_type).toBe('green');
    expect(normalized.hole).toBe(7);
    expect(normalized.is_approximate).toBe(false);
    expect(normalized.external_feature_id).toBe('way/679342887');

    const multiPolygonVariant = { ...polygonFeature, geometry: { type: 'MultiPolygon', coordinates: [polygonFeature.geometry.coordinates] } };
    const normalizedMulti = normalizeFeature(multiPolygonVariant);
    expect(normalizedMulti.geometry.type).toBe('MultiPolygon');
  });

  it('preserves a null hole_number as null (course-level/ungrouped), never inferring one', () => {
    const noHole = { ...polygonFeature, hole_number: null };
    expect(normalizeFeature(noHole).hole).toBeNull();
  });

  it('marks only feature_type "pin" as approximate', () => {
    const pin = { feature_type: 'pin', geometry: { type: 'Point', coordinates: [-121, 36] } };
    expect(normalizeFeature(pin).is_approximate).toBe(true);
    expect(normalizeFeature(polygonFeature).is_approximate).toBe(false);
  });

  it('returns null for a feature with no geometry (NOT NULL in the DB) or no feature_type', () => {
    expect(normalizeFeature({ feature_type: 'green' })).toBeNull();
    expect(normalizeFeature({ geometry: { type: 'Point', coordinates: [-121, 36] } })).toBeNull();
    expect(normalizeFeature(null)).toBeNull();
  });

  it('filterFeatures excludes "bridge" and keeps everything else, including "pin"', () => {
    expect(EXCLUDED_FEATURE_TYPES).toEqual(['bridge']);
    const raw = [
      polygonFeature,
      { feature_type: 'pin', geometry: { type: 'Point', coordinates: [-121, 36] } },
      { feature_type: 'bridge', geometry: { type: 'LineString', coordinates: [[-121, 36], [-121.001, 36]] }, tags: ['highway=primary'] },
    ];
    const filtered = filterFeatures(raw);
    expect(filtered.map((f) => f.feature_type)).toEqual(['green', 'pin']);
  });

  it('filterFeatures returns an empty array for non-array input', () => {
    expect(filterFeatures(null)).toEqual([]);
  });
});

describe('courseRowToClientJson', () => {
  it('maps DB snake_case columns to client-facing camelCase, including the stale flag', () => {
    const row = { external_id: 'abc', course_name: 'Pebble Beach Golf Links', year_built: 1919, fetched_at: '2026-10-01T00:00:00Z' };
    const json = courseRowToClientJson(row, true);
    expect(json.externalId).toBe('abc');
    expect(json.courseName).toBe('Pebble Beach Golf Links');
    expect(json.yearBuilt).toBe(1919);
    expect(json.fetchedAt).toBe('2026-10-01T00:00:00Z');
    expect(json.stale).toBe(true);
  });
});

describe('computeBackoffDelayMs', () => {
  it('centers attempt 2 around 500ms and attempt 3 around 1500ms', () => {
    for (let i = 0; i < 20; i++) {
      expect(computeBackoffDelayMs(2)).toBeGreaterThanOrEqual(400);
      expect(computeBackoffDelayMs(2)).toBeLessThanOrEqual(600);
      expect(computeBackoffDelayMs(3)).toBeGreaterThanOrEqual(1200);
      expect(computeBackoffDelayMs(3)).toBeLessThanOrEqual(1800);
    }
  });
});

describe('shouldBackOffFromRateLimitHeaders', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('backs off at/below the floor while the reset is still pending', () => {
    expect(shouldBackOffFromRateLimitHeaders(5, '2026-10-12T00:00:00Z', now)).toBe(true);
  });

  it('does not back off comfortably above the floor', () => {
    expect(shouldBackOffFromRateLimitHeaders(200, '2026-10-12T00:00:00Z', now)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('succeeds on the 3rd attempt after two 503s', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    });
    const promise = fetchWithRetry(fakeFetch, 'https://api.opengolfapi.org/api/v1/courses/abc', {}, 3, 8000);
    await vi.runAllTimersAsync();
    const response = await promise;
    expect(response.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('never retries a 429', async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 429 }));
    const response = await fetchWithRetry(fakeFetch, 'https://api.opengolfapi.org/api/v1/courses/abc', {}, 3, 8000);
    expect(response.status).toBe(429);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
