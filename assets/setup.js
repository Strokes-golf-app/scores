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
  for (let h = 1; h <= holeCount; h++) {
    const cell = document.createElement('div');
    cell.className = 'par-cell';
    cell.innerHTML = `
      <span class="par-cell-label">${h}</span>
      <input type="number" class="par-input" data-hole="${h}" min="2" max="6" placeholder="4" inputmode="numeric">
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
  document.getElementById('course-select').value = '';
  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    if (cb.value !== 'gross') cb.checked = false;
    cb.closest('.mode-card').classList.toggle('checked', cb.checked);
  });
  document.getElementById('match-players-field').hidden = true;
  document.getElementById('match-use-handicap').checked = true;

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
  await renderCourseSelectOptions();

  state.setupPlayers = [{ id: uid('p'), name: hostName, handicap: hostHandicap }];
  renderParGrid();
  renderSetupPlayerList();
}

async function renderCourseSelectOptions() {
  const select = document.getElementById('course-select');
  const courses = await loadMyCourses();
  state.myCourses = courses;
  select.innerHTML = '<option value="">Manual entry</option>' +
    courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)} - ${escapeHtml(c.location)}</option>`).join('');
}

function applySelectedCourse(courseId) {
  const course = (state.myCourses || []).find(c => c.id === courseId);
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

function collectModes() {
  return Array.from(document.querySelectorAll('#mode-grid input[name="mode"]:checked')).map(cb => cb.value);
}

// ---------------------------------------------------------
// Round creation
// ---------------------------------------------------------
async function createRound() {
  const courseName = document.getElementById('course-name').value.trim() || 'Untitled round';
  const holeCount = Number(document.getElementById('hole-count').value);
  const pars = collectPars();
  const modes = collectModes();
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
        stroke_index: state.selectedCourseStrokeIndex || null,
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
