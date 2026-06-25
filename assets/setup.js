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
      refreshMatchPlayerSelects();
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
      refreshMatchPlayerSelects();
    });
  });

  refreshMatchPlayerSelects();
}

function refreshMatchPlayerSelects() {
  const p1 = document.getElementById('match-p1');
  const p2 = document.getElementById('match-p2');
  [p1, p2].forEach(sel => sel.innerHTML = '');
  state.setupPlayers.forEach(p => {
    const label = p.name || 'Unnamed player';
    p1.innerHTML += `<option value="${p.id}">${escapeHtml(label)}</option>`;
    p2.innerHTML += `<option value="${p.id}">${escapeHtml(label)}</option>`;
  });
  if (state.setupPlayers.length > 1) p2.selectedIndex = 1;
}

async function resetSetupScreen() {
  document.getElementById('course-name').value = '';
  document.getElementById('hole-count').value = '18';
  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    if (cb.value !== 'gross') cb.checked = false;
    cb.closest('.mode-card').classList.toggle('checked', cb.checked);
  });
  document.getElementById('match-players-field').hidden = true;

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

  state.setupPlayers = [{ id: uid('p'), name: hostName, handicap: hostHandicap }];
  renderParGrid();
  renderSetupPlayerList();
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

  let matchPlayerAName = null, matchPlayerBName = null;
  if (modes.includes('match')) {
    const p1 = document.getElementById('match-p1').value;
    const p2 = document.getElementById('match-p2').value;
    if (!p1 || !p2 || p1 === p2) {
      showToast('Pick two different players for match play');
      return;
    }
    matchPlayerAName = state.setupPlayers.find(p => p.id === p1)?.name;
    matchPlayerBName = state.setupPlayers.find(p => p.id === p2)?.name;
  }

  const code = makeRoundCode();

  try {
    const { data: { user: currentUser } } = await supabaseClient.auth.getUser();
    if (!currentUser) throw new Error('No signed-in user found');

    const roundId = crypto.randomUUID();

    // 1. Insert the round row with a client-generated id — we can't read
    // it back with .select() here, since nobody's a member yet (that
    // happens in the next step).
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
      });

    if (roundErr) throw roundErr;

    // 2. Insert all players, also with client-generated ids, for the
    // same reason — no need to read them back.
    const playerRows = validPlayers.map((p, i) => ({
      id: crypto.randomUUID(),
      round_id: roundId,
      name: p.name.trim(),
      handicap: p.handicap || 0,
      user_id: i === 0 ? currentUser.id : null,
    }));

    const { error: playersErr } = await supabaseClient
      .from('players')
      .insert(playerRows);

    if (playersErr) throw playersErr;

    // 3. Now that players have ids, fill in host + match player ids and save.
    const hostId = playerRows[0].id;
    let matchA = null, matchB = null;
    if (matchPlayerAName) matchA = playerRows.find(p => p.name === matchPlayerAName)?.id || null;
    if (matchPlayerBName) matchB = playerRows.find(p => p.name === matchPlayerBName)?.id || null;

    const { error: updateErr } = await supabaseClient
      .from('rounds')
      .update({ host_player_id: hostId, match_player_a: matchA, match_player_b: matchB })
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
