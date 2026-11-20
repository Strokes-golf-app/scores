/* ===========================================================
   course-cache.js — offline cache for an imported GPS course (its row
   plus geometry features), so on-course yardages and the layout map
   keep working with no connection.
   Depends on: core.js (isNativeApp)

   Pure functions (cacheKeyForCourse, isCacheFresh, serializeCachePayload,
   parseCachePayload) have no DOM/platform dependency and are fully
   Vitest-tested. The I/O layer below them (readCachedCourse,
   writeCachedCourse, clearCachedCourse, listCachedCourses) is a thin,
   deliberately untested Capacitor Filesystem (native) / localStorage
   (web) wrapper behind isNativeApp() — same split as golf.js's tested
   pure core vs. everything else.
=========================================================== */

const CourseCache = (() => {
  const CACHE_VERSION = 1;
  const KEY_PREFIX = 'strokes-golf-course-cache-';
  const NATIVE_DIR = 'DATA'; // Capacitor Filesystem Directory.Data
  const NATIVE_ENCODING = 'utf8'; // Capacitor Filesystem Encoding.UTF8

  function cacheKeyForCourse(externalId) {
    return `${KEY_PREFIX}${externalId}`;
  }

  // A cached course is fresh when it's not yet staleDays old — exactly
  // staleDays old still counts as fresh, matching import-course.ts's
  // isCourseStale boundary so client and server agree on when a
  // refresh is actually due.
  function isCacheFresh(cachedAt, now, staleDays) {
    const cachedTime = new Date(cachedAt).getTime();
    if (Number.isNaN(cachedTime)) return false;
    const ageMs = now.getTime() - cachedTime;
    return ageMs <= staleDays * 24 * 60 * 60 * 1000;
  }

  function serializeCachePayload(course, features) {
    return JSON.stringify({
      version: CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      course,
      features,
    });
  }

  // Returns null for corrupted JSON, a missing/invalid version, or a
  // version newer than this build understands — forward-compat: never
  // trust a cache shape a future app version might have written.
  function parseCachePayload(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.cachedAt !== 'string' || !parsed.course) return null;
    return parsed;
  }

  async function readCachedCourse(externalId) {
    const key = cacheKeyForCourse(externalId);
    try {
      let raw = null;
      if (isNativeApp()) {
        const { Filesystem } = window.Capacitor.Plugins;
        const result = await Filesystem.readFile({ path: `${key}.json`, directory: NATIVE_DIR, encoding: NATIVE_ENCODING });
        raw = result.data;
      } else {
        raw = window.localStorage.getItem(key);
      }
      return parseCachePayload(raw);
    } catch {
      return null; // not cached yet, or storage unavailable — treat as "nothing cached"
    }
  }

  async function writeCachedCourse(externalId, course, features) {
    const key = cacheKeyForCourse(externalId);
    const payload = serializeCachePayload(course, features);
    try {
      if (isNativeApp()) {
        const { Filesystem } = window.Capacitor.Plugins;
        await Filesystem.writeFile({ path: `${key}.json`, data: payload, directory: NATIVE_DIR, encoding: NATIVE_ENCODING });
      } else {
        window.localStorage.setItem(key, payload);
      }
      return true;
    } catch {
      return false; // e.g. storage quota — caller should degrade to "no offline copy", not fail the whole feature
    }
  }

  async function clearCachedCourse(externalId) {
    const key = cacheKeyForCourse(externalId);
    try {
      if (isNativeApp()) {
        const { Filesystem } = window.Capacitor.Plugins;
        await Filesystem.deleteFile({ path: `${key}.json`, directory: NATIVE_DIR });
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // already gone, or storage unavailable — nothing more to do
    }
  }

  // Returns the externalIds of every course currently cached offline.
  async function listCachedCourses() {
    try {
      if (isNativeApp()) {
        const { Filesystem } = window.Capacitor.Plugins;
        const result = await Filesystem.readdir({ path: '', directory: NATIVE_DIR });
        return (result.files || [])
          .map((f) => (typeof f === 'string' ? f : f.name))
          .filter((name) => name.startsWith(KEY_PREFIX) && name.endsWith('.json'))
          .map((name) => name.slice(KEY_PREFIX.length, -'.json'.length));
      }
      const ids = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(KEY_PREFIX)) ids.push(key.slice(KEY_PREFIX.length));
      }
      return ids;
    } catch {
      return [];
    }
  }

  return {
    cacheKeyForCourse,
    isCacheFresh,
    serializeCachePayload,
    parseCachePayload,
    readCachedCourse,
    writeCachedCourse,
    clearCachedCourse,
    listCachedCourses,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CourseCache;
}
