'use strict';

/* ===========================================================
   setup.js — the "new round" screen: player list, par grid,
   game mode selection, and creating the round in Supabase.
   Depends on: core.js (state, uid, escapeHtml/escapeAttr)
=========================================================== */

function renderParGrid() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const grid = document.getElementById('par-grid');
  grid.innerHTML = '';
  // Back nine of an 18-hole course: holes are still stored as positions
  // 1..9 internally (data-hole, which the scoring logic depends on), but
  // we label them 10..18 so the grid matches the scorecard on the course.
  const labelOffset = state.selectedCourseNine === 'back' ? 9 : 0;
  for (let h = 1; h <= holeCount; h++) {
    const cell = document.createElement('div');
    cell.className = 'par-cell';
    cell.innerHTML = `
      <span class="par-cell-label">${h + labelOffset}</span>
      <span class="par-cell-sublabel">Par</span>
      <input type="number" class="par-input" data-hole="${h}" min="2" max="6" placeholder="4" inputmode="numeric">
      <span class="par-cell-sublabel">Hcp</span>
      <input type="number" class="hole-hcp-input" data-hole="${h}" min="1" max="${holeCount}" inputmode="numeric">
    `;
    grid.appendChild(cell);
  }
}

function renderSetupPlayerList() {
  const wrap = document.getElementById('player-list');
  wrap.innerHTML = '';
  state.setupPlayers.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <input type="text" value="${escapeAttr(p.name)}" placeholder="Player name" data-id="${p.id}" class="setup-name-input">
      <span class="hcp-label">HCP</span>
      <input type="number" value="${p.handicap}" data-id="${p.id}" class="hcp-input setup-hcp-input" inputmode="decimal" min="0" max="54" step="0.1" placeholder="0">
      <button class="player-row-remove" data-id="${p.id}" aria-label="Remove player">×</button>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.setup-name-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (p) p.name = e.target.value;
      renderMatchAssignList();
    });
  });
  wrap.querySelectorAll('.setup-hcp-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (p) p.handicap = parseHandicap(e.target.value);
    });
    inp.addEventListener('blur', async e => {
      const isHostRow = state.setupPlayers[0] && state.setupPlayers[0].id === e.target.dataset.id;
      if (!isHostRow) return;

      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) return;

      const p = state.setupPlayers.find(x => x.id === e.target.dataset.id);
      if (!p) return;

      await supabaseClient
        .from('user_profiles')
        .update({ default_handicap: p.handicap })
        .eq('id', user.id);
    });
  });
  wrap.querySelectorAll('.player-row-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      state.setupPlayers = state.setupPlayers.filter(x => x.id !== e.target.dataset.id);
      renderSetupPlayerList();
      renderMatchAssignList();
    });
  });

  renderMatchAssignList();
}

// Builds the team-assignment list shown when "Match play" is checked.
// Each player gets a select: not in match / Team A / Team B. Re-renders
// preserve existing picks (matched by player id) so editing a name or
// adding another player doesn't wipe out assignments already made.
function renderMatchAssignList() {
  const wrap = document.getElementById('match-assign-list');
  if (!wrap) return;

  const previous = {};
  wrap.querySelectorAll('.match-assign-select').forEach(sel => {
    previous[sel.dataset.id] = sel.value;
  });

  wrap.innerHTML = '';
  state.setupPlayers.forEach(p => {
    const label = p.name || 'Unnamed player';
    const row = document.createElement('div');
    row.className = 'match-assign-row';
    row.innerHTML = `
      <span class="match-assign-name">${escapeHtml(label)}</span>
      <select class="match-assign-select" data-id="${p.id}">
        <option value="">Not in match</option>
        <option value="A">Team A</option>
        <option value="B">Team B</option>
      </select>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.match-assign-select').forEach(sel => {
    if (previous[sel.dataset.id]) sel.value = previous[sel.dataset.id];
  });
}

// Reads the team selects into { teamA: [ids], teamB: [ids] }, only
// counting players who currently have a name entered.
function collectMatchAssignments() {
  const validIds = new Set(state.setupPlayers.filter(p => p.name.trim()).map(p => p.id));
  const teamA = [], teamB = [];
  document.querySelectorAll('.match-assign-select').forEach(sel => {
    if (!validIds.has(sel.dataset.id)) return;
    if (sel.value === 'A') teamA.push(sel.dataset.id);
    else if (sel.value === 'B') teamB.push(sel.dataset.id);
  });
  return { teamA, teamB };
}

async function resetSetupScreen() {
  document.getElementById('course-name').value = '';
  document.getElementById('hole-count').value = '18';
  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    if (cb.value !== 'gross') cb.checked = false;
    cb.closest('.mode-card').classList.toggle('checked', cb.checked);
  });
  document.getElementById('match-players-field').hidden = true;
  document.getElementById('match-use-handicap').checked = true;
  state.setupBetsEnabled = false;
  state.setupStakes = {};
  document.getElementById('bets-enabled').checked = false;
  document.getElementById('set-stakes-field').hidden = true;

  let hostName = '';
  let hostHandicap = 0;
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (user) {
    const { data: profile } = await supabaseClient
      .from('user_profiles')
      .select('display_name, default_handicap')
      .eq('id', user.id)
      .single();
    if (profile) {
      hostName = profile.display_name;
      hostHandicap = Number(profile.default_handicap) || 0;
    }
  }

  state.selectedCourseStrokeIndex = null;
  state.selectedFullCourse = null;
  state.selectedCourseNine = null;
  document.getElementById('nine-select-field').hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));
  await renderCourseSelectOptions();
  state.setupPlayers = [{ id: uid('p'), name: hostName, handicap: hostHandicap }];
  renderParGrid();
  renderSetupPlayerList();
}


function initializeSetupCourseSearch() {
  const searchInput = document.getElementById('setup-course-search');
  const resultsEl = document.getElementById('setup-course-search-results');
  if (!searchInput || !resultsEl || searchInput.dataset.initialized === 'true') return;

  searchInput.dataset.initialized = 'true';

  const runSetupCourseSearch = () => searchSetupCourseResults(searchInput.value);

  const searchBtn = document.getElementById('btn-setup-course-search');
  if (searchBtn) searchBtn.addEventListener('click', runSetupCourseSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSetupCourseSearch();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.course-search-wrapper')) {
      hideSetupCourseSearchResults();
    }
  });
}

async function searchSetupCourseResults(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    hideSetupCourseSearchResults();
    showToast('Type at least 2 characters to search');
    return;
  }

  const localResults = await searchLocalCourses(trimmed);
  let apiResults = [];
  if (localResults.length < 5) {
    apiResults = filterCachedApiResults(await searchApiCourses(trimmed), localResults);
  }
  displaySetupCourseSearchResults(localResults, apiResults);
}

function displaySetupCourseSearchResults(localResults, apiResults) {
  const resultsEl = document.getElementById('setup-course-search-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = '';

  // One flat list — local (saved) results first, then API results.
  // No labels, no visual distinction between the two sources.
  const combined = [
    ...localResults.map(course => ({ ...course, source: 'local' })),
    ...apiResults
  ];

  if (combined.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-result-empty';
    empty.textContent = 'No matches found.';
    resultsEl.appendChild(empty);

    const manualRow = document.createElement('div');
    manualRow.className = 'search-result-item manual';
    manualRow.textContent = 'Enter this course manually';
    manualRow.addEventListener('click', useSetupManualEntry);
    resultsEl.appendChild(manualRow);

    resultsEl.hidden = false;
    return;
  }

  combined.forEach(item => {
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.textContent = `${item.name || item.course_name || 'Course'}${item.location ? ` - ${item.location}` : ''}`;
    row.addEventListener('click', () => selectSetupCourseResult(item));
    resultsEl.appendChild(row);
  });

  resultsEl.hidden = false;
}

function hideSetupCourseSearchResults() {
  const resultsEl = document.getElementById('setup-course-search-results');
  if (resultsEl) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
  }
}

function useSetupManualEntry() {
  hideSetupCourseSearchResults();
  const searchInput = document.getElementById('setup-course-search');
  if (searchInput) searchInput.value = '';
  state.selectedFullCourse = null;
  state.selectedCourseNine = null;
  state.selectedCourseStrokeIndex = null;
  const nineField = document.getElementById('nine-select-field');
  if (nineField) nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('course-name').value = '';
  renderParGrid();
  document.getElementById('course-name').focus();
}

async function selectSetupCourseResult(course) {
  hideSetupCourseSearchResults();
  if (!course) return;

  if (course.source === 'api') {
    await importSetupApiCourse(course);
    return;
  }

  document.getElementById('setup-course-search').value = '';
  applySelectedCourse(course);
}

async function findOrSaveApiCourse({
  name,
  location,
  holeCount,
  pars,
  strokeIndex,
  externalId,
  apiClubName,
  apiLocation,
  userId
}) {
  // First try to find an existing course by external_id
  if (externalId) {
    const { data: existing } = await supabaseClient
      .from('courses')
      .select('*')
      .eq('external_id', externalId)
      .maybeSingle();

    if (existing) {
      return existing;
    }
  }

  // Attempt to insert a new cached course
  const { data: inserted, error } = await supabaseClient
    .from('courses')
    .insert({
      name,
      location,
      hole_count: holeCount,
      pars,
      stroke_index: strokeIndex,
      source: 'api',
      external_id: externalId,
      api_club_name: apiClubName,
      api_location: apiLocation,
      user_id: userId
    })
    .select()
    .single();

  if (!error) {
    return inserted;
  }

  // Someone else may have inserted it first.
  if (error.code === '23505') {
    let query = supabaseClient
      .from('courses')
      .select('*');

    if (externalId) {
      query = query.or(
        `external_id.eq.${externalId},and(name.ilike.${name},location.ilike.${location})`
      );
    } else {
      query = query
        .ilike('name', name)
        .ilike('location', location);
    }

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      return existing;
    }
  }

  console.error('Failed to cache imported course', error);

  return null;
}

async function importSetupApiCourse(course) {
  const searchInput = document.getElementById('setup-course-search');
  const originalValue = searchInput?.value || '';

  // Already imported by someone — reuse it instead of burning another
  // get-golf-course call.
  const cached = await findCachedApiCourse(course.external_id || course.id);
  if (cached) {
    hideSetupCourseSearchResults();
    if (searchInput) searchInput.value = '';
    state.myCourses = [
      ...(state.myCourses || []).filter(c => c.id !== cached.id),
      cached
    ];
    populateSetupCourseFields(cached);
    return;
  }

  if (searchInput) {
    searchInput.disabled = true;
    searchInput.value = 'Loading course details...';
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    showToast('You need to be logged in to import a course');
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = originalValue;
    }
    return;
  }

  try {
    const { data, error } = await supabaseClient.functions.invoke('get-golf-course', {
      body: { courseId: course.external_id || course.id, userId: user.id }
    });

    if (error || data?.error) {
      console.error(error || data?.error);
      showToast('Could not import that course right now');
      if (searchInput) {
        searchInput.disabled = false;
        searchInput.value = originalValue;
      }
      return;
    }

    // setup.js — importSetupApiCourse
    const holes = Array.isArray(data.holes) ? data.holes : [];
    const name = data.course_name || course.name || '';
    const location =
      data.location?.city && data.location?.state
        ? `${data.location.city}, ${data.location.state}`
        : data.location?.city || data.location?.state || '';

    const importedCourse = {
      id: `api:${course.external_id || course.id}`,
      name,
      location,
      hole_count: data.hole_count || holes.length || 18,
      pars: holes.map(h => h.par),
      stroke_index: holes.map(h => h.handicap),
      source: 'api'
    };

    // Save to the shared course cache
    const savedCourse = await findOrSaveApiCourse({
      name,
      location,
      holeCount: importedCourse.hole_count,
      pars: importedCourse.pars,
      strokeIndex: importedCourse.stroke_index,
      externalId: course.external_id || course.id,
      apiClubName: data.club_name || null,
      apiLocation: data.location || null,
      userId: user.id
    });

    // Keep local cache in sync so future searches don't require another API call
    if (savedCourse) {
      state.myCourses = [
        ...(state.myCourses || []).filter(c => c.id !== savedCourse.id),
        savedCourse
      ];
    }

    populateSetupCourseFields(savedCourse || importedCourse);

    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = '';
    }

  } catch (err) {
    console.error('Failed to import course', err);
    showToast('Could not import that course right now');
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = originalValue;
    }
  }
}

function populateSetupCourseFields(course) {
  const nineField = document.getElementById('nine-select-field');
  state.selectedFullCourse = course || null;
  state.selectedCourseNine = null;
  nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));

  if (!course) {
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('course-name').value = course.name || '';
  const roundHoleCount = Number(document.getElementById('hole-count').value);

  if (roundHoleCount === 9 && course.hole_count === 18) {
    nineField.hidden = false;
    document.getElementById('par-grid').innerHTML = '';
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('hole-count').value = String(course.hole_count || 18);
  applyCourseToGrid(course, null);
}

async function renderCourseSelectOptions() {
  // The manual-entry <select> was removed; saved courses are now reached
  // through the search field. We still load them into state so
  // applySelectedCourse() and the search-result handlers can find them.
  state.myCourses = await loadMyCourses();
}

function applySelectedCourse(courseOrId) {
  const course = (courseOrId && typeof courseOrId === 'object')
    ? courseOrId
    : (state.myCourses || []).find(c => c.id === courseOrId);
  const nineField = document.getElementById('nine-select-field');

  state.selectedFullCourse = course || null;
  state.selectedCourseNine = null;
  nineField.hidden = true;
  document.querySelectorAll('.nine-btn').forEach(b => b.classList.remove('selected'));

  if (!course) {
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('course-name').value = course.name;

  const roundHoleCount = Number(document.getElementById('hole-count').value);

  // A 9-hole round against an 18-hole saved course needs the player to
  // pick which nine before we know which pars/stroke index to use.
  if (roundHoleCount === 9 && course.hole_count === 18) {
    nineField.hidden = false;
    document.getElementById('par-grid').innerHTML = '';
    state.selectedCourseStrokeIndex = null;
    return;
  }

  document.getElementById('hole-count').value = String(course.hole_count);
  applyCourseToGrid(course, null);
}

// Fills the par grid (and stroke index) from a saved course. `nine` is
// null for a full course, or 'front'/'back' when a 9-hole round is
// using one half of an 18-hole course.
function applyCourseToGrid(course, nine) {
  renderParGrid();

  let pars = course.pars;
  let strokeIndex = course.stroke_index;

  if (nine === 'front') {
    pars = course.pars.slice(0, 9);
    strokeIndex = strokeIndex ? strokeIndex.slice(0, 9) : null;
  } else if (nine === 'back') {
    pars = course.pars.slice(9, 18);
    strokeIndex = strokeIndex ? strokeIndex.slice(9, 18) : null;
  }

  document.querySelectorAll('.par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = pars[h];
  });

  document.querySelectorAll('.hole-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = strokeIndex && strokeIndex[h] != null ? strokeIndex[h] : '';
  });

  state.selectedCourseStrokeIndex = strokeIndex ? Golf.toRelativeStrokeIndex(strokeIndex) : null;
}

function selectCourseNine(nine) {
  if (!state.selectedFullCourse) return;
  state.selectedCourseNine = nine;
  document.querySelectorAll('.nine-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.nine === nine);
  });
  const label = nine === 'front' ? 'Front 9' : 'Back 9';
  document.getElementById('course-name').value = `${state.selectedFullCourse.name} — ${label}`;
  applyCourseToGrid(state.selectedFullCourse, nine);
}

function collectPars() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const pars = [];
  document.querySelectorAll('.par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    pars[h] = Number(inp.value) || 4;
  });
  for (let i = 0; i < holeCount; i++) {
    if (!pars[i]) pars[i] = 4;
  }
  return pars;
}

// Reads the per-hole Hcp inputs. Returns { strokeIndex, partial }:
// strokeIndex is the relative stroke index when every hole has a
// value, otherwise null; partial flags a half-filled grid so the
// caller can warn that the values were skipped.
function collectStrokeIndex() {
  const holeCount = Number(document.getElementById('hole-count').value);
  const raw = new Array(holeCount).fill(null);
  document.querySelectorAll('.hole-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    const v = Number(inp.value);
    if (inp.value !== '' && v >= 1 && v <= holeCount) raw[h] = v;
  });
  const filled = raw.filter(v => v != null).length;
  return {
    strokeIndex: filled === holeCount ? Golf.toRelativeStrokeIndex(raw) : null,
    partial: filled > 0 && filled < holeCount
  };
}

function collectModes() {
  return Array.from(document.querySelectorAll('#mode-grid input[name="mode"]:checked')).map(cb => cb.value);
}

// Stakes screen — shared by setup (in-memory, pre-create) and the
// lobby (writes back to the round). Sublabels encode the settlement
// model for each mode.
const STAKE_ORDER = ['gross', 'net', 'stableford', 'skins', 'match'];
const STAKE_META = {
  gross: { label: 'Gross', sub: 'Ante per player' },
  net: { label: 'Net', sub: 'Ante per player' },
  stableford: { label: 'Stableford', sub: 'Ante per player' },
  skins: { label: 'Skins', sub: 'Per skin won' },
  match: { label: 'Match play', sub: 'Team A vs Team B' },
};

// Plain-language "what this bet is" for the info dialog on the stakes
// screen. Kept next to STAKE_META so the two stay in sync.
const BET_EXPLAINERS = {
  gross: {
    title: 'Gross — winner takes the pot',
    body: 'Everyone antes the same amount into one pot. Whoever posts the lowest total strokes for the round — no handicap applied — takes the whole pot. If players tie for the low score, they split it evenly.',
  },
  net: {
    title: 'Net — winner takes the pot',
    body: "Same as gross, but each player's handicap is applied first to level the field. Everyone antes; the lowest net total wins the entire pot, and ties split it evenly.",
  },
  stableford: {
    title: 'Stableford — winner takes the pot',
    body: 'Everyone antes into one pot. You earn points on each hole — more points for better scores — and whoever finishes with the most points wins the whole pot. Ties split evenly.',
  },
  skins: {
    title: 'Skins — win holes, get paid',
    body: 'Every hole is worth one skin. Win a hole outright and each of the other players pays you the skin value. Tie a hole and its skin carries to the next, so a single hole can be worth several stacked skins. Any skins still carrying at the end pay no one.',
  },
  match: {
    title: 'Match play — team vs team',
    body: 'The two sides play head-to-head, hole by hole. Whoever is ahead when the match can no longer be caught wins it. The losing side pays the match stake, split across the winning team. A tied (halved) match pays nothing.',
  },
};

function openBetInfo(mode) {
  const info = BET_EXPLAINERS[mode];
  if (!info) return;
  document.getElementById('bet-info-title').textContent = info.title;
  document.getElementById('bet-info-body').textContent = info.body;
  document.getElementById('bet-info-modal').hidden = false;
}

function closeBetInfo() {
  document.getElementById('bet-info-modal').hidden = true;
}

function renderStakesScreen(modes, stakes) {
  const list = document.getElementById('stakes-list');
  const ordered = STAKE_ORDER.filter(m => modes.includes(m));
  if (!ordered.length) {
    list.innerHTML = '<p class="field-hint">Pick at least one game mode first, then set its stake here.</p>';
    return;
  }
  list.innerHTML = ordered.map(m => {
    const meta = STAKE_META[m];
    const val = stakes && stakes[m] != null ? stakes[m] : '';
    return `
      <div class="stakes-row">
        <div>
          <span class="stakes-row-name">${meta.label}</span>
          <button type="button" class="stakes-row-sub stakes-info-link" data-mode="${m}" aria-label="What ${meta.label} means">${meta.sub}<span class="stakes-info-icon" aria-hidden="true">ⓘ</span></button>
        </div>
        <div class="stakes-amount">
          <span class="cur">$</span>
          <input type="number" class="stakes-input" data-mode="${m}" min="0" step="1" inputmode="numeric" placeholder="0" value="${val}">
        </div>
      </div>`;
  }).join('');
}

function collectStakes() {
  const stakes = {};
  document.querySelectorAll('#stakes-list .stakes-input').forEach(inp => {
    const v = Number(inp.value);
    if (inp.value !== '' && v > 0) stakes[inp.dataset.mode] = v;
  });
  return stakes;
}

function openStakesScreen(context) {
  state.stakesContext = context;
  if (context === 'lobby') {
    const r = state.round;
    renderStakesScreen(r.modes || ['gross'], r.stakes || {});
  } else {
    renderStakesScreen(collectModes(), state.setupStakes || {});
  }
  showScreen('screen-stakes');
}

async function saveStakesScreen() {
  const stakes = collectStakes();
  if (state.stakesContext === 'lobby') {
    const { error } = await supabaseClient
      .from('rounds')
      .update({ stakes, bets_enabled: true })
      .eq('id', state.roundId);
    if (error) { console.error(error); showToast('Could not save stakes — try again'); return; }
    await loadRound(state.roundId);
    showScreen('screen-lobby');
    renderLobby();
    showToast('Stakes updated');
  } else {
    state.setupStakes = stakes;
    showScreen('screen-setup');
    showToast('Stakes saved');
  }
}

// ---------------------------------------------------------
// Round creation
// ---------------------------------------------------------
async function createRound() {
  const courseName = document.getElementById('course-name').value.trim() || 'Untitled round';
  const holeCount = Number(document.getElementById('hole-count').value);
  const pars = collectPars();
  const modes = collectModes();
  const { strokeIndex, partial: hcpPartial } = collectStrokeIndex();
  if (hcpPartial) showToast('Hole handicaps skipped — fill every hole or leave them all blank');
  const validPlayers = state.setupPlayers.filter(p => p.name.trim().length > 0);
  if (validPlayers.length === 0) {
    showToast('Add at least one player first');
    return;
  }

  let matchTeamATempIds = [], matchTeamBTempIds = [], matchUseHandicap = true;
  if (modes.includes('match')) {
    const { teamA, teamB } = collectMatchAssignments();
    if (teamA.length === 0 || teamB.length === 0) {
      showToast('Assign at least one player to each match play team');
      return;
    }
    if (teamA.length > 3 || teamB.length > 3) {
      showToast('Match play teams can have at most 3 players each');
      return;
    }
    matchTeamATempIds = teamA;
    matchTeamBTempIds = teamB;
    matchUseHandicap = document.getElementById('match-use-handicap').checked;
  }

  const code = makeRoundCode();

  try {
    const { data: { user: currentUser } } = await supabaseClient.auth.getUser();
    if (!currentUser) throw new Error('No signed-in user found');

    const roundId = crypto.randomUUID();

    const { error: roundErr } = await supabaseClient
      .from('rounds')
      .insert({
        id: roundId,
        code,
        course_name: courseName,
        hole_count: holeCount,
        pars,
        modes,
        started: false,
        ended: false,
        host_user_id: currentUser.id,
        stroke_index: strokeIndex,
        hole_offset: state.selectedCourseNine === 'back' ? 9 : 0,
        bets_enabled: state.setupBetsEnabled === true,
        stakes: state.setupBetsEnabled ? (state.setupStakes || {}) : {},
      });

    if (roundErr) throw roundErr;

    // Insert the host's own row FIRST, on its own — this one doesn't
    // depend on the round being readable yet, just on user_id matching.
    const hostRow = {
      id: crypto.randomUUID(),
      round_id: roundId,
      name: validPlayers[0].name.trim(),
      handicap: validPlayers[0].handicap || 0,
      user_id: currentUser.id,
    };

    // Maps each setup-screen player to their real database row id, so
    // match play team picks (collected by temp id) can be translated
    // to real player ids below.
    const tempIdToDbId = { [validPlayers[0].id]: hostRow.id };

    const { error: hostErr } = await supabaseClient.from('players').insert(hostRow);
    if (hostErr) throw hostErr;

    // Now insert any other players typed in at setup, as a SEPARATE
    // step — by now the host's row above is committed, so the
    // "host can pre-add a placeholder" check can actually see it.
    const otherPlayers = validPlayers.slice(1).map(p => {
      const dbId = crypto.randomUUID();
      tempIdToDbId[p.id] = dbId;
      return {
        id: dbId,
        round_id: roundId,
        name: p.name.trim(),
        handicap: p.handicap || 0,
        user_id: null,
      };
    });

    if (otherPlayers.length > 0) {
      const { error: othersErr } = await supabaseClient.from('players').insert(otherPlayers);
      if (othersErr) throw othersErr;
    }

    const hostId = hostRow.id;
    const matchTeamA = matchTeamATempIds.map(id => tempIdToDbId[id]).filter(Boolean);
    const matchTeamB = matchTeamBTempIds.map(id => tempIdToDbId[id]).filter(Boolean);

    const { error: updateErr } = await supabaseClient
      .from('rounds')
      .update({
        host_player_id: hostId,
        match_team_a: matchTeamA.length ? matchTeamA : null,
        match_team_b: matchTeamB.length ? matchTeamB : null,
        match_use_handicap: matchUseHandicap,
      })
      .eq('id', roundId);

    if (updateErr) throw updateErr;

    state.roundId = roundId;
    state.roundCode = code;
    state.myPlayerId = hostId;
    saveSession();

    await loadRound(roundId);
    subscribeToRound(roundId);
    document.getElementById('lobby-code').textContent = code;
    document.getElementById('lobby-course-name').textContent = courseName;
    showScreen('screen-lobby');
    renderLobby();
  } catch (e) {
    console.error(e);
    showToast('Could not create round — check your connection and Supabase setup');
  }
}
