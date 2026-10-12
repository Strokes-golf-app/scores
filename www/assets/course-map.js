/* ===========================================================
   course-map.js — MapKit JS satellite view with polygon overlays,
   falling back to a canvas schematic when MapKit is unavailable
   (offline, no token, or the SDK failed to load/init).
   Depends on: core.js (isNativeApp), gps-geometry.js (GpsGeometry),
   supabase-config.js (supabaseClient). Not unit-tested — this is DOM/
   platform glue; the geometry math it calls into lives in
   gps-geometry.js, which is.
=========================================================== */

let activeMapHandle = null;
let cachedMapkitToken = null;
let cachedMapkitTokenExpiresAt = 0;
let mapkitInitialized = false;
// Bounding box used by the last renderCanvasFallback call, so a tap on
// the canvas (Practice mode's "set simulated position") can be
// inverted back to lat/lng — see unprojectCanvasPoint.
let lastCanvasBounds = null;

// Design-system colors, read from the live CSS custom properties rather
// than duplicated hex literals, so this stays in sync with styles.css.
// The palette has no blue, so water features fall back to a neutral ink
// tone rather than an invented color.
function featureColor(featureType) {
  const style = getComputedStyle(document.documentElement);
  const tokenByType = {
    green: '--fairway-light',
    fairway: '--fairway',
    rough: '--fairway-dark',
    bunker: '--sand',
    water_hazard: '--ink-soft',
    creek: '--ink-soft',
    cart_path: '--line',
    tee: '--flag',
    pin: '--flag-dark',
    tree: '--fairway-dark',
    tree_cluster: '--fairway-dark',
    driving_range: '--sand-light',
    hole_line: '--ink-faint',
  };
  const token = tokenByType[featureType] || '--ink-faint';
  return style.getPropertyValue(token).trim() || '#8C8676';
}

// Mints (or reuses, if not near expiry) a MapKit JS JWT via the
// mapkit-token Edge Function. Called by MapKit JS's own
// authorizationCallback renewal mechanism, not cached long-term.
async function getMapKitToken() {
  const now = Date.now();
  if (cachedMapkitToken && now < cachedMapkitTokenExpiresAt - 60000) return cachedMapkitToken;

  const { data, error } = await supabaseClient.functions.invoke('mapkit-token', { body: {} });
  if (error || !data || !data.token) throw new Error('mapkit-token request failed');

  cachedMapkitToken = data.token;
  cachedMapkitTokenExpiresAt = new Date(data.expiresAt).getTime();
  return cachedMapkitToken;
}

async function ensureMapkitInitialized() {
  if (typeof window.mapkit === 'undefined') return false;
  if (mapkitInitialized) return true;
  try {
    window.mapkit.init({
      authorizationCallback: (done) => {
        getMapKitToken().then(done).catch(() => done(''));
      },
    });
    mapkitInitialized = true;
    return true;
  } catch {
    return false;
  }
}

function renderMapKitOverlays(map, features) {
  (features || []).forEach((f) => {
    const color = featureColor(f.feature_type);
    const rings = GpsGeometry.polygonRings(f.geometry);
    if (rings.length > 0) {
      rings.forEach((ring) => {
        const coords = ring.map((p) => new window.mapkit.Coordinate(p.lat, p.lng));
        const polygon = new window.mapkit.PolygonOverlay(coords, {
          style: new window.mapkit.Style({ fillColor: color, fillOpacity: 0.45, strokeColor: color, lineWidth: 1 }),
        });
        map.addOverlay(polygon);
      });
      return;
    }
    if (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
      const [lng, lat] = f.geometry.coordinates;
      const annotation = new window.mapkit.MarkerAnnotation(new window.mapkit.Coordinate(lat, lng), {
        color,
        title: f.feature_type === 'pin' ? 'Pin (approximate)' : f.feature_type,
      });
      map.addAnnotation(annotation);
    }
  });
}

// Projects features + the player position onto a canvas using a simple
// bounding-box normalization — not a real map projection, but at
// golf-hole scale (tens of yards) that distortion is immaterial, same
// reasoning gps-geometry.js uses for its local-meters polygon math.
function renderCanvasFallback(canvasEl, features, playerPos) {
  const ctx = canvasEl.getContext('2d');
  const w = canvasEl.width;
  const h = canvasEl.height;
  const style = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = style.getPropertyValue('--cream').trim() || '#F6F1E4';
  ctx.fillRect(0, 0, w, h);

  const allPoints = [];
  (features || []).forEach((f) => {
    GpsGeometry.polygonRings(f.geometry).forEach((ring) => allPoints.push(...ring));
    if (f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
      allPoints.push({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });
    }
  });
  if (playerPos) allPoints.push(playerPos);
  if (allPoints.length === 0) return;

  const lats = allPoints.map((p) => p.lat);
  const lngs = allPoints.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const padLat = (maxLat - minLat) * 0.15 || 0.0005;
  const padLng = (maxLng - minLng) * 0.15 || 0.0005;
  const lo = { lat: minLat - padLat, lng: minLng - padLng };
  const hi = { lat: maxLat + padLat, lng: maxLng + padLng };
  lastCanvasBounds = { lo, hi, w, h };

  function project(p) {
    return {
      x: ((p.lng - lo.lng) / (hi.lng - lo.lng)) * w,
      y: h - ((p.lat - lo.lat) / (hi.lat - lo.lat)) * h,
    };
  }

  (features || []).forEach((f) => {
    const color = featureColor(f.feature_type);
    const rings = GpsGeometry.polygonRings(f.geometry);
    rings.forEach((ring) => {
      ctx.beginPath();
      ring.forEach((p, i) => {
        const { x, y } = project(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    if (rings.length === 0 && f.geometry && f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
      const { x, y } = project({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  });

  if (playerPos) {
    const { x, y } = project(playerPos);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = style.getPropertyValue('--flag').trim() || '#B5402F';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
}

function destroyCourseMap() {
  if (activeMapHandle && activeMapHandle.type === 'mapkit' && activeMapHandle.map && typeof activeMapHandle.map.destroy === 'function') {
    try { activeMapHandle.map.destroy(); } catch { /* already gone */ }
  }
  activeMapHandle = null;
}

// Tries MapKit JS (satellite/hybrid, needs a token + connectivity);
// falls back to the canvas schematic on any failure — offline, no
// mapkit global, token request failed, or map construction threw.
// `onTap(point)` is optional — when provided, it's wired to both the
// MapKit map and the canvas fallback's click/tap, each converted to a
// plain {lat, lng}. Used for Practice mode's "tap the map to set a
// simulated position," so gps-round.js never needs to know whether
// MapKit or the canvas fallback is actually active.
async function initCourseMap(mapkitContainerEl, canvasEl, course, features, playerPos, onTap) {
  destroyCourseMap();
  canvasEl.onclick = null;

  const fallbackNote = document.getElementById('course-map-fallback-note');
  const canTryMapkit = navigator.onLine !== false && course && course.lat != null && course.lng != null;

  if (canTryMapkit) {
    try {
      const ready = await ensureMapkitInitialized();
      if (ready) {
        mapkitContainerEl.hidden = false;
        canvasEl.hidden = true;

        const map = new window.mapkit.Map(mapkitContainerEl, {
          mapType: window.mapkit.Map.MapTypes.Hybrid,
          showsMapTypeControl: false,
        });
        map.region = new window.mapkit.CoordinateRegion(
          new window.mapkit.Coordinate(course.lat, course.lng),
          new window.mapkit.CoordinateSpan(0.01, 0.01)
        );
        renderMapKitOverlays(map, features);
        if (playerPos) {
          map.addAnnotation(new window.mapkit.MarkerAnnotation(
            new window.mapkit.Coordinate(playerPos.lat, playerPos.lng),
            { color: getComputedStyle(document.documentElement).getPropertyValue('--flag').trim(), title: 'You' }
          ));
        }
        if (typeof onTap === 'function') {
          map.element.addEventListener('click', (evt) => {
            const coord = map.convertPointOnPageToCoordinate(new DOMPoint(evt.pageX, evt.pageY));
            onTap({ lat: coord.latitude, lng: coord.longitude });
          });
        }

        activeMapHandle = { type: 'mapkit', map };
        if (fallbackNote) fallbackNote.hidden = true;
        return activeMapHandle;
      }
    } catch {
      // fall through to the canvas fallback below
    }
  }

  mapkitContainerEl.hidden = true;
  canvasEl.hidden = false;
  renderCanvasFallback(canvasEl, features, playerPos);
  if (fallbackNote) fallbackNote.hidden = false;
  if (typeof onTap === 'function') {
    canvasEl.onclick = (evt) => {
      const point = unprojectCanvasPoint(canvasEl, evt.clientX, evt.clientY);
      if (point) onTap(point);
    };
  }
  activeMapHandle = { type: 'canvas' };
  return activeMapHandle;
}

// Inverts the canvas fallback's bounding-box projection, so a tap at
// pixel (clientX, clientY) on the canvas can be turned back into a
// {lat, lng} — used by Practice mode's "tap the map to set a simulated
// position." Returns null if nothing has been rendered yet (no bounds
// to invert against) or the canvas fallback isn't the active view.
function unprojectCanvasPoint(canvasEl, clientX, clientY) {
  if (!lastCanvasBounds) return null;
  const rect = canvasEl.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * canvasEl.width;
  const y = ((clientY - rect.top) / rect.height) * canvasEl.height;
  const { lo, hi, w, h } = lastCanvasBounds;
  return {
    lng: lo.lng + (x / w) * (hi.lng - lo.lng),
    lat: lo.lat + ((h - y) / h) * (hi.lat - lo.lat),
  };
}
