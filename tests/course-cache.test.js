import { describe, it, expect } from 'vitest';
import CourseCache from '../assets/course-cache.js';

describe('cacheKeyForCourse', () => {
  it('builds a stable, prefixed key from an external id', () => {
    expect(CourseCache.cacheKeyForCourse('abc-123')).toBe('strokes-golf-course-cache-abc-123');
  });
});

describe('isCacheFresh', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');

  it('is fresh exactly staleDays old', () => {
    const cachedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(CourseCache.isCacheFresh(cachedAt, now, 30)).toBe(true);
  });

  it('is stale one second past staleDays old', () => {
    const cachedAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000 - 1000).toISOString();
    expect(CourseCache.isCacheFresh(cachedAt, now, 30)).toBe(false);
  });

  it('treats an unparseable date as not fresh', () => {
    expect(CourseCache.isCacheFresh('not-a-date', now, 30)).toBe(false);
  });
});

describe('serializeCachePayload / parseCachePayload', () => {
  it('round-trips a course + features payload', () => {
    const course = { externalId: 'abc', courseName: 'Pebble Beach Golf Links' };
    const features = [{ feature_type: 'green', geometry: { type: 'Polygon', coordinates: [] } }];
    const raw = CourseCache.serializeCachePayload(course, features);
    const parsed = CourseCache.parseCachePayload(raw);
    expect(parsed.course).toEqual(course);
    expect(parsed.features).toEqual(features);
    expect(typeof parsed.cachedAt).toBe('string');
    expect(parsed.version).toBe(1);
  });

  it('returns null for corrupted/garbage JSON', () => {
    expect(CourseCache.parseCachePayload('{not valid json')).toBeNull();
    expect(CourseCache.parseCachePayload('')).toBeNull();
    expect(CourseCache.parseCachePayload(null)).toBeNull();
    expect(CourseCache.parseCachePayload(undefined)).toBeNull();
  });

  it('returns null for a well-formed payload with an unrecognized future version', () => {
    const futurePayload = JSON.stringify({ version: 99, cachedAt: new Date().toISOString(), course: { externalId: 'abc' } });
    expect(CourseCache.parseCachePayload(futurePayload)).toBeNull();
  });

  it('returns null for a well-formed JSON object missing required fields', () => {
    expect(CourseCache.parseCachePayload(JSON.stringify({ version: 1 }))).toBeNull();
    expect(CourseCache.parseCachePayload(JSON.stringify({ version: 1, cachedAt: 'x' }))).toBeNull();
    expect(CourseCache.parseCachePayload('[]')).toBeNull();
    expect(CourseCache.parseCachePayload('"just a string"')).toBeNull();
  });
});
