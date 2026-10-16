/* ===========================================================
   gps-round.js — GPS course search/import, the live geolocation watch
   (native/web dual path), live yardage rendering, and Practice mode.
   Depends on: core.js (state, isNativeApp, showScreen, showToast,
   escapeHtml, escapeAttr), gps-geometry.js (GpsGeometry), course-cache.js
   (CourseCache), course-map.js (initCourseMap), supabase-config.js
   (supabaseClient). Not unit-tested — DOM/platform glue; the math it
   calls into lives in gps-geometry.js, which is.
=========================================================== */

let gpsWatchHandle = null; // { type: 'native', id } | { type: 'web', id }
let gpsPositionHistory = []; // accepted fixes, most recent last — see GpsGeometry.smoothPosition
let isPracticeMode = false;
let practicePosition = null;
let currentGpsCourse = null; // client-facing course JSON from import-course / the local cache
let currentGpsFeatures = []; // all imported features for the current course
let currentGpsHole = 1;

function updateGpsStatusIndicator(statusText) {
  const chip = document.getElementById('gps-status-chip');
  if (chip) chip.textContent = statusText;
}

// Native: an explicit permission check/request via the Capacitor plugin.
// Web: there's no separate request step — the browser's own prompt
// appears the first time watchPosition is actually called, so this is
// a no-op there. Either way, this is only ever called when the user
// opens the GPS screen, never at app launch.
async function requestLocationPermission() {
  if (isNativeApp()) {
    const { Geolocation } = window.Capacitor.Plugins;
    try {
      const current = await Geolocation.checkPermissions();
      if (current.location === 'granted') return true;
      const requested = await Geolocation.requestPermissions();
      return requested.location === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

function handleRawPositionFix(rawCoords) {
  const fix = { lat: rawCoords.latitude, lng: rawCoords.longitude, accuracy: rawCoords.accuracy };
  if (!GpsGeometry.isFixUsable(fix)) return;
  const smoothed = GpsGeometry.smoothPosition(gpsPositionHistory, fix);
  gpsPositionHistory.push({ ...fix });
  if (gpsPositionHistory.length > 10) gpsPositionHistory.shift();
  updateGpsStatusIndicator('GPS active');
  if (!isPracticeMode) {
    renderLiveYardages(currentGpsHole, currentGpsFeatures, smoothed);
  }
}

async function startGpsWatch() {
  stopGpsWatch();
  if (isPracticeMode) return;

  const granted = await requestLocationPermission();
  if (!granted) {
    updateGpsStatusIndicator('Location denied');
    showToast('Location access was denied — try Practice mode instead, or enable it in Settings.');
    return;
  }

  updateGpsStatusIndicator('Finding GPS…');

  if (isNativeApp()) {
    const { Geolocation } = window.Capacitor.Plugins;
    try {
      const id = await Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 10000 }, (position, err) => {
        if (err || !position) {
          updateGpsStatusIndicator('GPS unavailable');
          return;
        }
        handleRawPositionFix(position.coords);
      });
      gpsWatchHandle = { type: 'native', id };
    } catch {
      updateGpsStatusIndicator('GPS unavailable');
    }
    return;
  }

  if (!navigator.geolocation) {
    updateGpsStatusIndicator('GPS not supported');
    return;
  }
  const id = navigator.geolocation.watchPosition(
    (position) => handleRawPositionFix(position.coords),
    (err) => updateGpsStatusIndicator(err.code === 1 ? 'Location denied' : 'GPS unavailable'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
  );
  gpsWatchHandle = { type: 'web', id };
}

function stopGpsWatch() {
  if (!gpsWatchHandle) return;
  if (gpsWatchHandle.type === 'native' && window.Capacitor && window.Capacitor.Plugins.Geolocation) {
    window.Capacitor.Plugins.Geolocation.clearWatch({ id: gpsWatchHandle.id }).catch(() => {});
  } else if (gpsWatchHandle.type === 'web' && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchHandle.id);
  }
  gpsWatchHandle = null;
  gpsPositionHistory = [];
}

function enterPracticeMode() {
  isPracticeMode = true;
  stopGpsWatch();
  updateGpsStatusIndicator('Practice mode — tap the map to set your position');
  const fallback = currentGpsCourse && currentGpsCourse.lat != null
    ? { lat: currentGpsCourse.lat, lng: currentGpsCourse.lng }
    : null;
  if (!practicePosition && fallback) practicePosition = fallback;
  if (practicePosition) renderLiveYardages(currentGpsHole, currentGpsFeatures, practicePosition);
  refreshCourseMapScreen();
}

function exitPracticeMode() {
  isPracticeMode = false;
  practicePosition = null;
  refreshCourseMapScreen();
  startGpsWatch();
}

function setPracticePosition(lat, lng) {
  practicePosition = { lat, lng };
  renderLiveYardages(currentGpsHole, currentGpsFeatures, practicePosition);
}

function getCurrentEffectivePosition() {
  if (isPracticeMode) return practicePosition;
  const last = gpsPositionHistory[gpsPositionHistory.length - 1];
  return last ? { lat: last.lat, lng: last.lng } : null;
}

// Renders front/center/back of the current hole's green, plus a
// carry-to-water line when a water hazard is present on this hole.
// Features with hole === null are course-level/ungrouped (e.g. every
// St Andrews feature) and are included for every hole, since there's
// no reliable way to attribute them to a specific one.
function renderLiveYardages(hole, features, playerPos) {
  const frontEl = document.getElementById('gps-yardage-front');
  const centerEl = document.getElementById('gps-yardage-center');
  const backEl = document.getElementById('gps-yardage-back');
  const hazardEl = document.getElementById('gps-hazard-line');

  const holeFeatures = (features || []).filter((f) => f.hole === hole || f.hole == null);
  const green = holeFeatures.find((f) => f.feature_type === 'green');

  if (!playerPos || !green) {
    if (frontEl) frontEl.textContent = '—';
    if (centerEl) centerEl.textContent = '—';
    if (backEl) backEl.textContent = '—';
    if (hazardEl) hazardEl.hidden = true;
    return;
  }

  const front = GpsGeometry.frontOfGreenYards(green.geometry, playerPos);
  const center = GpsGeometry.centerOfGreenYards(green.geometry, playerPos);
  const back = GpsGeometry.backOfGreenYards(green.geometry, playerPos);

  if (frontEl) frontEl.textContent = front != null ? String(Math.round(front)) : '—';
  if (centerEl) centerEl.textContent = center != null ? String(Math.round(center)) : '—';
  if (backEl) backEl.textContent = back != null ? String(Math.round(back)) : '—';

  const carry = GpsGeometry.carryToWaterYards(holeFeatures, playerPos);
  if (hazardEl) {
    if (carry != null) {
      hazardEl.textContent = `Carry to water: ${Math.round(carry)} yd`;
      hazardEl.hidden = false;
    } else {
      hazardEl.hidden = true;
    }
  }
}

async function openGpsSearchScreen() {
  const hint = document.getElementById('gps-search-hint');
  const results = document.getElementById('gps-search-results');
  const input = document.getElementById('gps-search-input');
  if (hint) hint.hidden = true;
  if (results) results.innerHTML = '';
  if (input) input.value = '';
  showScreen('screen-gps-search');
}

async function runGpsCourseSearch(query, lat, lng) {
  const hint = document.getElementById('gps-search-hint');
  const resultsEl = document.getElementById('gps-search-results');
  if (resultsEl) resultsEl.innerHTML = '<p class="field-hint">Searching…</p>';
  if (hint) hint.hidden = true;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  const body = {};
  if (query) body.query = query;
  if (lat != null && lng != null) {
    body.lat = lat;
    body.lng = lng;
  }

  const { data, error } = await supabaseClient.functions.invoke('search-course', { body });
  if (error || !data) {
    if (resultsEl) resultsEl.innerHTML = '';
    if (hint) {
      hint.textContent = 'Search is temporarily unavailable — try again shortly.';
      hint.hidden = false;
    }
    return;
  }

  if (data.limited && hint) {
    hint.textContent = data.message || 'Search is busy right now — results may be incomplete.';
    hint.hidden = false;
  }

  renderGpsSearchResults(data.results || []);
}

function renderGpsSearchResults(results) {
  const resultsEl = document.getElementById('gps-search-results');
  if (!resultsEl) return;

  if (results.length === 0) {
    resultsEl.innerHTML = '<p class="field-hint">No courses found by that name. Try "Search near my location" instead.</p>';
    return;
  }

  resultsEl.innerHTML = results.map((r) => `
    <button class="gps-search-result" type="button" data-external-id="${escapeAttr(r.externalId)}">
      <span class="gps-search-result-name">${escapeHtml(r.courseName || 'Unnamed course')}</span>
      <span class="gps-search-result-meta">${escapeHtml([r.city, r.state].filter(Boolean).join(', '))}</span>
    </button>
  `).join('');

  resultsEl.querySelectorAll('.gps-search-result').forEach((btn) => {
    btn.addEventListener('click', () => selectGpsCourse(btn.dataset.externalId));
  });
}

async function selectGpsCourse(externalId) {
  showToast('Loading course…');
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return;

  const { data, error } = await supabaseClient.functions.invoke('import-course', { body: { externalId } });
  if (error || !data || !data.course) {
    showToast((data && data.message) || 'Could not load this course — try again shortly.');
    return;
  }

  currentGpsCourse = data.course;
  currentGpsHole = 1;
  practicePosition = null;

  await loadGpsCourseFeatures(externalId);
  await CourseCache.writeCachedCourse(externalId, currentGpsCourse, currentGpsFeatures);

  showScreen('screen-course-map');
  await refreshCourseMapScreen();
  if (!isPracticeMode) startGpsWatch();
}

// Reads geometry directly from golf_course_features — it's
// authenticated-readable by design (any logged-in user can SELECT), so
// there's no need to round-trip through an edge function just to read
// data that's already public to any signed-in user.
async function loadGpsCourseFeatures(externalId) {
  const { data: courseRow } = await supabaseClient
    .from('golf_courses')
    .select('id')
    .eq('external_id', externalId)
    .maybeSingle();

  if (!courseRow) {
    currentGpsFeatures = [];
    return;
  }

  const { data: features } = await supabaseClient
    .from('golf_course_features')
    .select('*')
    .eq('course_id', courseRow.id);

  currentGpsFeatures = features || [];
}

// Offline entry point: loads whatever was last cached for a course,
// with no network calls at all. Used when opening the GPS screen with
// no connection (Capacitor Filesystem / localStorage only).
async function loadGpsCourseFromCache(externalId) {
  const cached = await CourseCache.readCachedCourse(externalId);
  if (!cached) return false;
  currentGpsCourse = cached.course;
  currentGpsFeatures = cached.features || [];
  currentGpsHole = 1;
  return true;
}

async function refreshCourseMapScreen() {
  const nameEl = document.getElementById('course-map-name');
  const subEl = document.getElementById('course-map-sub');
  const holeEl = document.getElementById('gps-hole-number');
  if (nameEl) nameEl.textContent = (currentGpsCourse && currentGpsCourse.courseName) || 'Course';
  if (subEl) subEl.textContent = (currentGpsCourse && [currentGpsCourse.city, currentGpsCourse.state].filter(Boolean).join(', ')) || '';
  if (holeEl) holeEl.textContent = String(currentGpsHole);

  const mapkitEl = document.getElementById('course-map-mapkit');
  const canvasEl = document.getElementById('course-map-canvas');
  if (!mapkitEl || !canvasEl) return;

  const playerPos = getCurrentEffectivePosition();
  const holeFeatures = currentGpsFeatures.filter((f) => f.hole === currentGpsHole || f.hole == null);

  const onTap = isPracticeMode ? (point) => setPracticePosition(point.lat, point.lng) : null;
  await initCourseMap(mapkitEl, canvasEl, currentGpsCourse, holeFeatures, playerPos, onTap);
  renderLiveYardages(currentGpsHole, currentGpsFeatures, playerPos);
}

function changeGpsHole(delta) {
  const max = (currentGpsCourse && currentGpsCourse.holes) || 18;
  currentGpsHole = Math.max(1, Math.min(max, currentGpsHole + delta));
  refreshCourseMapScreen();
}

function leaveGpsCourseMapScreen() {
  stopGpsWatch();
  isPracticeMode = false;
  practicePosition = null;
  destroyCourseMap();
}

function initGpsFeature() {
  document.getElementById('btn-round-gps').addEventListener('click', async () => {
    if (currentGpsCourse) {
      showScreen('screen-course-map');
      await refreshCourseMapScreen();
      if (!isPracticeMode) startGpsWatch();
    } else {
      openGpsSearchScreen();
    }
  });

  document.getElementById('btn-gps-change-course').addEventListener('click', () => {
    stopGpsWatch();
    openGpsSearchScreen();
  });

  document.getElementById('btn-gps-search-back').addEventListener('click', () => {
    showScreen(currentGpsCourse ? 'screen-course-map' : 'screen-round');
  });

  document.getElementById('btn-gps-search-submit').addEventListener('click', () => {
    const query = document.getElementById('gps-search-input').value.trim();
    if (query.length < 2) {
      showToast('Enter at least 2 characters to search');
      return;
    }
    runGpsCourseSearch(query, null, null);
  });

  document.getElementById('gps-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-gps-search-submit').click();
  });

  document.getElementById('btn-gps-search-location').addEventListener('click', async () => {
    const granted = await requestLocationPermission();
    if (!granted) {
      showToast('Location access is needed to search nearby — try a text search instead.');
      return;
    }
    const geo = isNativeApp() ? window.Capacitor.Plugins.Geolocation : navigator.geolocation;
    if (!geo) {
      showToast('Location is not available on this device');
      return;
    }
    showToast('Finding your location…');
    const onFix = (coords) => runGpsCourseSearch(null, coords.latitude, coords.longitude);
    if (isNativeApp()) {
      geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
        .then((pos) => onFix(pos.coords))
        .catch(() => showToast('Could not get your location'));
    } else {
      geo.getCurrentPosition(
        (pos) => onFix(pos.coords),
        () => showToast('Could not get your location'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
  });

  document.getElementById('btn-course-map-back').addEventListener('click', () => {
    leaveGpsCourseMapScreen();
    showScreen('screen-round');
  });

  document.getElementById('btn-gps-hole-prev').addEventListener('click', () => changeGpsHole(-1));
  document.getElementById('btn-gps-hole-next').addEventListener('click', () => changeGpsHole(1));

  document.getElementById('btn-gps-practice-toggle').addEventListener('click', () => {
    if (isPracticeMode) exitPracticeMode();
    else enterPracticeMode();
  });

  document.getElementById('btn-about-credits').addEventListener('click', () => showScreen('screen-about-credits'));
  document.getElementById('btn-about-credits-back').addEventListener('click', () => showScreen('screen-home'));
}
