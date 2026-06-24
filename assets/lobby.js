'use strict';

/* ===========================================================
   lobby.js — the pre-round lobby, joining by code, picking
   your identity, leaving a round, and resuming a session on
   page reload.
   Depends on: core.js (state, session helpers)
   Calls into: round.js (loadRound, subscribeToRound, enterRound)
=========================================================== */

function renderLobby() {
  const r = state.round;
  if (!r) return;
  document.getElementById('lobby-course-name').textContent = r.courseName;
  document.getElementById('lobby-code').textContent = r.code;

  document.getElementById('lobby-player-count').textContent = r.players.length;

  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  r.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    const hostBadge = p.id === r.hostId ? '<span class="chip chip-host">Host</span>' : '';
    row.innerHTML = `
      <span class="player-chip-name">${escapeHtml(p.name)}</span>
      ${hostBadge}
      <span class="player-chip-hcp">HCP ${p.handicap}</span>
    `;
    list.appendChild(row);
  });

  const modeNames = { gross: 'Gross', net: 'Net', stableford: 'Stableford', skins: 'Skins', match: 'Match play' };
  document.getElementById('lobby-modes').innerHTML =
    (r.modes || ['gross']).map(m => `<span class="chip">${modeNames[m] || m}</span>`).join('');

  if (r.started) enterRound();
}

async function addPlayerToRound(roundId) {
  const { data: { user } } = await supabaseClient.auth.getUser();

  let defaultName = '';
  let defaultHandicap = 0;
  if (user) {
    const { data: profile } = await supabaseClient
      .from('user_profiles')
      .select('display_name, default_handicap')
      .eq('id', user.id)
      .single();
    if (profile) {
      defaultName = profile.display_name;
      defaultHandicap = profile.default_handicap;
    }
  }

  const name = prompt('Your name?', defaultName);
  if (!name || !name.trim()) return null;

  const hcpRaw = prompt('Handicap? (e.g. 10.2) — edit if it has changed', defaultHandicap);
  const handicap = parseHandicap(hcpRaw);

  if (user && handicap !== defaultHandicap) {
    await supabaseClient
      .from('user_profiles')
      .update({ default_handicap: handicap })
      .eq('id', user.id);
  }

  const { data, error } = await supabaseClient
    .from('players')
    .insert({ round_id: roundId, name: name.trim(), handicap })
    .select()
    .single();

  if (error) {
    showToast('Could not add player — check your connection');
    return null;
  }
  await loadRound(roundId);
  return data.id;
}

// ---------------------------------------------------------
// Join flow
// ---------------------------------------------------------
async function joinRound(code) {
  code = code.trim().toUpperCase();
  if (!code) return;

  try {
    const { data: roundRow, error } = await supabaseClient
      .from('rounds')
      .select('*')
      .eq('code', code)
      .single();

    if (error || !roundRow) {
      showToast('No round found with that code');
      return;
    }

    state.roundId = roundRow.id;
    state.roundCode = code;
    await loadRound(roundRow.id);
    subscribeToRound(roundRow.id);

    document.getElementById('identify-course-name').textContent = roundRow.course_name;
    renderIdentifyList(state.round);
    showScreen('screen-identify');
  } catch (e) {
    console.error(e);
    showToast('Could not reach the round — check your connection');
  }
}

function renderIdentifyList(round) {
  const list = document.getElementById('identify-player-list');
  list.innerHTML = '';
  round.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="player-chip-name">${escapeHtml(p.name)}</span>
      <span class="player-chip-hcp">HCP ${p.handicap}</span>
    `;
    row.addEventListener('click', () => selectIdentity(p.id));
    list.appendChild(row);
  });
}

function selectIdentity(playerId) {
  state.myPlayerId = playerId;
  saveSession();
  if (state.round && state.round.started) {
    enterRound();
  } else {
    showScreen('screen-lobby');
    renderLobby();
  }
}

// ---------------------------------------------------------
// Navigation / leaving
// ---------------------------------------------------------
function goHome() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.roundId = null;
  state.roundCode = null;
  state.round = null;
  state.myPlayerId = null;
  clearSession();
  showScreen('screen-home');
}

// ---------------------------------------------------------
// Resuming a session on page reload
// ---------------------------------------------------------
async function resumeSession(session) {
  try {
    const { data: roundRow, error } = await supabaseClient
      .from('rounds')
      .select('*')
      .eq('code', session.roundCode)
      .single();

    if (error || !roundRow) {
      clearSession();
      resetSetupScreen();
      showScreen('screen-home');
      return;
    }

    state.roundId = roundRow.id;
    state.roundCode = session.roundCode;
    state.myPlayerId = session.myPlayerId;
    await loadRound(roundRow.id);
    subscribeToRound(roundRow.id);

    if (state.round.started) {
      enterRound();
    } else {
      document.getElementById('lobby-course-name').textContent = state.round.courseName;
      document.getElementById('lobby-code').textContent = state.round.code;
      showScreen('screen-lobby');
      renderLobby();
    }
  } catch (e) {
    console.error(e);
    clearSession();
    resetSetupScreen();
    showScreen('screen-home');
  }
}
