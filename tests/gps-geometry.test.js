import { describe, it, expect } from 'vitest';
import GpsGeometry from '../assets/gps-geometry.js';

describe('haversineDistanceYards', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 36.5685, lng: -121.949 };
    expect(GpsGeometry.haversineDistanceYards(p, p)).toBeCloseTo(0, 6);
  });

  it('matches the well-known ~69 miles-per-degree-of-latitude approximation', () => {
    const yards = GpsGeometry.haversineDistanceYards({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    const miles = yards / 1760;
    expect(miles).toBeGreaterThan(68.5);
    expect(miles).toBeLessThan(69.5);
  });

  it('returns null for missing or invalid points', () => {
    expect(GpsGeometry.haversineDistanceYards(null, { lat: 1, lng: 1 })).toBeNull();
    expect(GpsGeometry.haversineDistanceYards({ lat: 1 }, { lat: 1, lng: 1 })).toBeNull();
    expect(GpsGeometry.haversineDistanceYards(undefined, undefined)).toBeNull();
  });
});

describe('bearingDegrees', () => {
  const origin = { lat: 36, lng: -121 };

  it('is ~0 degrees for a point due north', () => {
    expect(GpsGeometry.bearingDegrees(origin, { lat: 36.01, lng: -121 })).toBeCloseTo(0, 0);
  });

  it('is ~90 degrees for a point due east', () => {
    expect(GpsGeometry.bearingDegrees(origin, { lat: 36, lng: -120.99 })).toBeCloseTo(90, 0);
  });

  it('returns null for missing points', () => {
    expect(GpsGeometry.bearingDegrees(null, origin)).toBeNull();
  });
});

describe('centroid', () => {
  it('computes the centroid of a simple square polygon', () => {
    const geometry = {
      type: 'Polygon',
      coordinates: [[
        [-121.0, 36.0], [-121.0, 36.0001], [-120.9999, 36.0001], [-120.9999, 36.0], [-121.0, 36.0],
      ]],
    };
    const c = GpsGeometry.centroid(geometry);
    expect(c.lat).toBeCloseTo(36.00005, 5);
    expect(c.lng).toBeCloseTo(-120.99995, 5);
  });

  it('returns null for a degenerate ring with too few usable vertices', () => {
    const geometry = { type: 'Polygon', coordinates: [[[-121, 36], [-121, 36]]] };
    expect(GpsGeometry.centroid(geometry)).toBeNull();
  });

  it('returns null for empty or missing geometry', () => {
    expect(GpsGeometry.centroid({ type: 'Polygon', coordinates: [] })).toBeNull();
    expect(GpsGeometry.centroid(null)).toBeNull();
  });
});

describe('front/center/back of green — Polygon vs MultiPolygon equivalence', () => {
  // A simple rectangular "green": lng -121.0005..-120.9995, lat 36.000..36.0005.
  const ring = [
    [-121.0005, 36.0000], [-121.0005, 36.0005],
    [-120.9995, 36.0005], [-120.9995, 36.0000],
    [-121.0005, 36.0000],
  ];
  const polygon = { type: 'Polygon', coordinates: [ring] };
  const multiPolygon = { type: 'MultiPolygon', coordinates: [[ring]] };
  const player = { lat: 35.999, lng: -121.0000 }; // south of the green, on its centerline

  it('front of green is closer than center, which is closer than back', () => {
    const front = GpsGeometry.frontOfGreenYards(polygon, player);
    const center = GpsGeometry.centerOfGreenYards(polygon, player);
    const back = GpsGeometry.backOfGreenYards(polygon, player);
    expect(front).toBeLessThan(center);
    expect(center).toBeLessThan(back);
  });

  it('back of green matches a brute-force max-distance-to-vertex check', () => {
    const vertices = ring.map(([lng, lat]) => ({ lat, lng }));
    const bruteForceMax = Math.max(...vertices.map((v) => GpsGeometry.haversineDistanceYards(player, v)));
    const back = GpsGeometry.backOfGreenYards(polygon, player);
    expect(back).toBeCloseTo(bruteForceMax, 4);
  });

  it('gives identical front/center/back results for Polygon and single-ring MultiPolygon', () => {
    expect(GpsGeometry.frontOfGreenYards(multiPolygon, player)).toBeCloseTo(GpsGeometry.frontOfGreenYards(polygon, player), 6);
    expect(GpsGeometry.centerOfGreenYards(multiPolygon, player)).toBeCloseTo(GpsGeometry.centerOfGreenYards(polygon, player), 6);
    expect(GpsGeometry.backOfGreenYards(multiPolygon, player)).toBeCloseTo(GpsGeometry.backOfGreenYards(polygon, player), 6);
  });

  it('returns null for a degenerate 1-vertex "green" rather than throwing', () => {
    const degenerate = { type: 'Polygon', coordinates: [[[-121, 36]]] };
    expect(() => GpsGeometry.frontOfGreenYards(degenerate, player)).not.toThrow();
    expect(GpsGeometry.frontOfGreenYards(degenerate, player)).toBeNull();
    expect(GpsGeometry.backOfGreenYards(degenerate, player)).toBeNull();
    expect(GpsGeometry.centerOfGreenYards(degenerate, player)).toBeNull();
  });
});

describe('nearestFeatureDistanceYards / carryToWaterYards', () => {
  const player = { lat: 36.000, lng: -121.000 };

  it('finds the nearest feature among several, including a Point feature', () => {
    const features = [
      {
        feature_type: 'water_hazard',
        geometry: { type: 'Polygon', coordinates: [[[-121.01, 36.01], [-121.01, 36.011], [-121.009, 36.011], [-121.009, 36.01], [-121.01, 36.01]]] },
      },
      { feature_type: 'pin', geometry: { type: 'Point', coordinates: [-121.0001, 36.0001] } },
    ];
    const nearest = GpsGeometry.nearestFeatureDistanceYards(features, player);
    expect(nearest.feature.feature_type).toBe('pin');
  });

  it('returns null when given no usable features', () => {
    expect(GpsGeometry.nearestFeatureDistanceYards([], player)).toBeNull();
    expect(GpsGeometry.nearestFeatureDistanceYards(null, player)).toBeNull();
  });

  it('carryToWaterYards only considers water_hazard features, ignoring a closer non-water one', () => {
    const features = [
      { feature_type: 'bunker', geometry: { type: 'Point', coordinates: [-121.0001, 36.0001] } },
      { feature_type: 'water_hazard', geometry: { type: 'Point', coordinates: [-121.001, 36.001] } },
    ];
    const yards = GpsGeometry.carryToWaterYards(features, player);
    const expected = GpsGeometry.haversineDistanceYards(player, { lat: 36.001, lng: -121.001 });
    expect(yards).toBeCloseTo(expected, 4);
  });

  it('returns null when there are no water_hazard features at all', () => {
    const features = [{ feature_type: 'bunker', geometry: { type: 'Point', coordinates: [-121, 36] } }];
    expect(GpsGeometry.carryToWaterYards(features, player)).toBeNull();
  });
});

describe('isFixUsable', () => {
  it('accepts a fix within the default accuracy threshold', () => {
    expect(GpsGeometry.isFixUsable({ lat: 36, lng: -121, accuracy: 10 })).toBe(true);
  });

  it('rejects a fix beyond the default accuracy threshold', () => {
    expect(GpsGeometry.isFixUsable({ lat: 36, lng: -121, accuracy: 60 })).toBe(false);
  });

  it('respects a custom maxAccuracyM option', () => {
    expect(GpsGeometry.isFixUsable({ lat: 36, lng: -121, accuracy: 40 }, { maxAccuracyM: 50 })).toBe(true);
  });

  it('rejects a missing or malformed fix', () => {
    expect(GpsGeometry.isFixUsable(null)).toBe(false);
    expect(GpsGeometry.isFixUsable({ lat: 36 })).toBe(false);
  });
});

describe('smoothPosition', () => {
  it('returns the new fix outright when history is empty', () => {
    expect(GpsGeometry.smoothPosition([], { lat: 36, lng: -121, accuracy: 5 })).toEqual({ lat: 36, lng: -121 });
  });

  it('lands exactly at the midpoint when the new fix and last fix have equal accuracy', () => {
    const history = [{ lat: 36, lng: -121, accuracy: 10 }];
    const r = GpsGeometry.smoothPosition(history, { lat: 36.001, lng: -121, accuracy: 10 });
    expect(r.lat).toBeCloseTo(36.0005, 6);
  });

  it('weights a more accurate new fix more heavily than a less accurate prior one', () => {
    const history = [{ lat: 36, lng: -121, accuracy: 50 }];
    const r = GpsGeometry.smoothPosition(history, { lat: 36.001, lng: -121, accuracy: 2 });
    expect(Math.abs(r.lat - 36.001)).toBeLessThan(Math.abs(r.lat - 36));
  });

  it('falls back to the last known point when the new fix is invalid', () => {
    const history = [{ lat: 36, lng: -121, accuracy: 10 }];
    expect(GpsGeometry.smoothPosition(history, null)).toEqual({ lat: 36, lng: -121 });
  });
});
