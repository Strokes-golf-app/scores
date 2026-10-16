/* ===========================================================
   gps-geometry.js — pure GPS/geometry math, no DOM, no network.
   Depends on: nothing (loads right after golf.js, before core.js).

   Takes plain GeoJSON geometry (as stored in golf_course_features)
   and plain {lat, lng} points, returns plain numbers/points. Front,
   center, and back of green are computed entirely from the green's
   polygon boundary relative to the player's live position -- the
   OpenGolfAPI course data never supplies these as explicit fields
   (confirmed always null on every course tested), so deriving them
   from the polygon is the actual data source, not a fallback.

   GeoJSON coordinates are [lng, lat] -- the opposite order of this
   module's {lat, lng} point convention. geoJsonCoordToPoint is the
   one place that conversion happens; every other function works in
   {lat, lng} space.

   Boundary/centroid math (nearestPointOnPolygonBoundary, centroid,
   farthestVertexFromPoint) is done in a local flat-meters projection
   around the geometry's own first vertex, since golf features span at
   most tens of yards -- Earth's curvature is immaterial at that scale,
   and a flat plane makes point-to-segment projection exact instead of
   approximate. Final yardages are always reported via true haversine
   distance from the player's actual GPS position.
=========================================================== */

const GpsGeometry = (() => {
  const EARTH_RADIUS_YARDS = 6371000 / 0.9144;
  const METERS_PER_DEGREE_LAT = 111320;

  function toRadians(deg) {
    return (deg * Math.PI) / 180;
  }

  function isPoint(p) {
    return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
      Number.isFinite(p.lat) && Number.isFinite(p.lng);
  }

  function haversineDistanceYards(a, b) {
    if (!isPoint(a) || !isPoint(b)) return null;
    const phi1 = toRadians(a.lat);
    const phi2 = toRadians(b.lat);
    const dPhi = toRadians(b.lat - a.lat);
    const dLambda = toRadians(b.lng - a.lng);
    const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return EARTH_RADIUS_YARDS * c;
  }

  function bearingDegrees(from, to) {
    if (!isPoint(from) || !isPoint(to)) return null;
    const phi1 = toRadians(from.lat);
    const phi2 = toRadians(to.lat);
    const dLambda = toRadians(to.lng - from.lng);
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = Math.atan2(y, x);
    return ((theta * 180) / Math.PI + 360) % 360;
  }

  function metersPerDegreeLng(latDeg) {
    return METERS_PER_DEGREE_LAT * Math.cos(toRadians(latDeg));
  }

  function projectToLocalMeters(point, origin) {
    return {
      x: (point.lng - origin.lng) * metersPerDegreeLng(origin.lat),
      y: (point.lat - origin.lat) * METERS_PER_DEGREE_LAT,
    };
  }

  function unprojectFromLocalMeters(local, origin) {
    return {
      lat: origin.lat + local.y / METERS_PER_DEGREE_LAT,
      lng: origin.lng + local.x / metersPerDegreeLng(origin.lat),
    };
  }

  function geoJsonCoordToPoint(coord) {
    if (!Array.isArray(coord) || coord.length < 2) return null;
    const [lng, lat] = coord;
    return isPoint({ lat, lng }) ? { lat, lng } : null;
  }

  // Normalizes Polygon or MultiPolygon GeoJSON into an array of exterior
  // rings (each an array of {lat, lng} points, NOT closed -- no repeated
  // first/last point). Interior rings (holes) are ignored -- irrelevant
  // for golf feature shapes. Degenerate rings (fewer than 3 usable
  // points) are dropped. Any other geometry type (Point, LineString)
  // returns an empty array -- callers that need those handle them
  // separately (see nearestFeatureDistanceYards).
  function polygonRings(geometry) {
    if (!geometry || typeof geometry !== 'object') return [];
    const coords = geometry.coordinates;
    if (!Array.isArray(coords)) return [];

    if (geometry.type === 'Polygon') {
      const exterior = coords[0];
      if (!Array.isArray(exterior)) return [];
      const ring = exterior.map(geoJsonCoordToPoint).filter(Boolean);
      return ring.length >= 3 ? [ring] : [];
    }

    if (geometry.type === 'MultiPolygon') {
      const rings = [];
      coords.forEach((polygon) => {
        if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) return;
        const ring = polygon[0].map(geoJsonCoordToPoint).filter(Boolean);
        if (ring.length >= 3) rings.push(ring);
      });
      return rings;
    }

    return [];
  }

  function distMeters(p, q) {
    return Math.hypot(p.x - q.x, p.y - q.y);
  }

  // Signed shoelace area + area-weighted centroid of a ring given in
  // local meters. Returns null for a degenerate (collinear/zero-area)
  // ring rather than a misleading point.
  function ringAreaAndCentroid(ringMeters) {
    let areaSum = 0;
    let cx = 0;
    let cy = 0;
    const n = ringMeters.length;
    for (let i = 0; i < n; i++) {
      const p0 = ringMeters[i];
      const p1 = ringMeters[(i + 1) % n];
      const cross = p0.x * p1.y - p1.x * p0.y;
      areaSum += cross;
      cx += (p0.x + p1.x) * cross;
      cy += (p0.y + p1.y) * cross;
    }
    const area = areaSum / 2;
    if (Math.abs(area) < 1e-9) return null;
    return { area: Math.abs(area), cx: cx / (6 * area), cy: cy / (6 * area) };
  }

  // Centroid of a feature's geometry, as {lat, lng}. When a MultiPolygon
  // has more than one ring (rare -- OpenGolfAPI mostly uses single-ring
  // MultiPolygon as an encoding choice, not genuinely disjoint shapes),
  // the largest-area ring wins rather than blending them.
  function centroid(geometry) {
    const rings = polygonRings(geometry);
    if (rings.length === 0) return null;
    const origin = rings[0][0];
    let best = null;
    rings.forEach((ring) => {
      const local = ring.map((p) => projectToLocalMeters(p, origin));
      const result = ringAreaAndCentroid(local);
      if (result && (!best || result.area > best.area)) best = result;
    });
    if (!best) return null;
    return unprojectFromLocalMeters({ x: best.cx, y: best.cy }, origin);
  }

  function nearestPointOnSegmentMeters(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    let t = abLenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / abLenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * abx, y: a.y + t * aby };
  }

  // Nearest point ON THE BOUNDARY (an edge, not necessarily a vertex) to
  // playerPos -- used for front-of-green, since the closest edge of a
  // green is usually mid-side, not at a corner.
  function nearestPointOnPolygonBoundary(geometry, playerPos) {
    const rings = polygonRings(geometry);
    if (rings.length === 0 || !isPoint(playerPos)) return null;
    const origin = rings[0][0];
    const playerLocal = projectToLocalMeters(playerPos, origin);
    let best = null;
    rings.forEach((ring) => {
      const local = ring.map((p) => projectToLocalMeters(p, origin));
      const n = local.length;
      for (let i = 0; i < n; i++) {
        const candidate = nearestPointOnSegmentMeters(playerLocal, local[i], local[(i + 1) % n]);
        const d = distMeters(playerLocal, candidate);
        if (!best || d < best.d) best = { d, point: candidate };
      }
    });
    return best ? unprojectFromLocalMeters(best.point, origin) : null;
  }

  // Farthest point from playerPos -- used for back-of-green. For a
  // straight-edged polygon the farthest boundary point from an external
  // point is always a vertex (distance along any edge is monotonic), so
  // checking vertices alone is exact, not an approximation.
  function farthestVertexFromPoint(geometry, playerPos) {
    const rings = polygonRings(geometry);
    if (rings.length === 0 || !isPoint(playerPos)) return null;
    const origin = rings[0][0];
    const playerLocal = projectToLocalMeters(playerPos, origin);
    let best = null;
    rings.forEach((ring) => {
      ring.forEach((p) => {
        const local = projectToLocalMeters(p, origin);
        const d = distMeters(playerLocal, local);
        if (!best || d > best.d) best = { d, point: local };
      });
    });
    return best ? unprojectFromLocalMeters(best.point, origin) : null;
  }

  function frontOfGreenYards(geometry, playerPos) {
    const point = nearestPointOnPolygonBoundary(geometry, playerPos);
    return point ? haversineDistanceYards(playerPos, point) : null;
  }

  function backOfGreenYards(geometry, playerPos) {
    const point = farthestVertexFromPoint(geometry, playerPos);
    return point ? haversineDistanceYards(playerPos, point) : null;
  }

  function centerOfGreenYards(geometry, playerPos) {
    const point = centroid(geometry);
    return point ? haversineDistanceYards(playerPos, point) : null;
  }

  // Nearest point among a list of {feature_type, geometry} features to
  // playerPos, across polygon boundaries and bare Points (e.g. a 'pin'
  // feature). Returns {feature, distanceYards, point} or null.
  function nearestFeatureDistanceYards(features, playerPos) {
    if (!Array.isArray(features) || !isPoint(playerPos)) return null;
    let best = null;
    features.forEach((f) => {
      if (!f || !f.geometry) return;
      let point = null;
      if (f.geometry.type === 'Point') {
        point = geoJsonCoordToPoint(f.geometry.coordinates);
      } else {
        point = nearestPointOnPolygonBoundary(f.geometry, playerPos);
      }
      if (!point) return;
      const d = haversineDistanceYards(playerPos, point);
      if (d != null && (!best || d < best.distanceYards)) best = { feature: f, distanceYards: d, point };
    });
    return best;
  }

  // Carry distance to the nearest edge of a water hazard. Simplification:
  // nearest boundary point overall, not constrained to the player's line
  // toward a target -- the standard approximation GPS yardage apps use;
  // true line-intersection carry is a possible future refinement.
  function carryToWaterYards(features, playerPos) {
    const waterOnly = (features || []).filter((f) => f && f.feature_type === 'water_hazard');
    const nearest = nearestFeatureDistanceYards(waterOnly, playerPos);
    return nearest ? nearest.distanceYards : null;
  }

  function isFixUsable(fix, opts) {
    const maxAccuracyM = (opts && opts.maxAccuracyM) || 30;
    if (!fix || !isPoint(fix)) return false;
    if (fix.accuracy != null && fix.accuracy > maxAccuracyM) return false;
    return true;
  }

  // Blends newFix against the last entry in history, weighting each
  // inversely by its reported GPS accuracy (a tighter/more confident fix
  // pulls the smoothed position further toward it). Callers should
  // filter raw fixes through isFixUsable before calling this --
  // smoothPosition assumes newFix already passed that gate.
  function smoothPosition(history, newFix) {
    if (!newFix || !isPoint(newFix)) {
      const last = history && history.length ? history[history.length - 1] : null;
      return last ? { lat: last.lat, lng: last.lng } : null;
    }
    if (!history || history.length === 0) return { lat: newFix.lat, lng: newFix.lng };

    const last = history[history.length - 1];
    const lastAccuracy = last.accuracy != null ? last.accuracy : 10;
    const newAccuracy = newFix.accuracy != null ? newFix.accuracy : 10;
    const wNew = 1 / Math.max(newAccuracy, 1);
    const wLast = 1 / Math.max(lastAccuracy, 1);
    const total = wNew + wLast;
    return {
      lat: (newFix.lat * wNew + last.lat * wLast) / total,
      lng: (newFix.lng * wNew + last.lng * wLast) / total,
    };
  }

  return {
    haversineDistanceYards,
    bearingDegrees,
    polygonRings,
    centroid,
    nearestPointOnPolygonBoundary,
    farthestVertexFromPoint,
    frontOfGreenYards,
    backOfGreenYards,
    centerOfGreenYards,
    nearestFeatureDistanceYards,
    carryToWaterYards,
    isFixUsable,
    smoothPosition,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GpsGeometry;
}
