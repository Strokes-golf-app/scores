'use strict';

/* ===========================================================
   round.js — everything about an in-progress round: pulling
   state from Supabase, the realtime subscription, the
   scorecard tab (entering strokes), and the leaderboard tab
   (gross/net/stableford/skins/match play).

   Data model (see supabase_schema.sql):
   - rounds(id, code, course_name, hole_count, pars, modes,
            match_player_a, match_player_b, host_player_id,
            started, ended)
   - players(id, round_id, name, handicap)
   - scores(id, player_id, hole, strokes)

   Depends on: core.js (state, escapeHtml, showToast, showScreen),
   golf.js (Golf), lobby.js (goHome, enterRound is called from here
   but defined below — see note at populateModeTabs).
=========================================================== */

// ---------------------------------------------------------
// Mapping raw Supabase rows into the in-memory round shape
// ---------------------------------------------------------

// Builds the per-hole { "1": strokes, ... } object for one player.
function mapPlayerScores(scoreRows, playerId) {
  const scores = {};
  scoreRows
    .filter(s => s.player_id === playerId)
    .forEach(s => { scores[String(s.hole)] = s.strokes; });
  return scores;
}

// Builds the per-hole { "1": putts, ... } object for one player.
// Putts are optional, so holes without a recorded count are simply absent.
function mapPlayerPutts(scoreRows, playerId) {
  const putts = {};
  scoreRows
    .filter(s => s.player_id === playerId)
    .forEach(s => { if (s.putts != null) putts[String(s.hole)] = s.putts; });
  return putts;
}

// Turns raw player rows + score rows into the player objects the app
// uses (handicap coerced to a number, scores keyed by hole).
function mapPlayers(playerRows, scoreRows) {
  return playerRows.map(p => ({
    ...p,
    handicap: Number(p.handicap) || 0,
    scores: mapPlayerScores(scoreRows, p.id),
    putts: mapPlayerPutts(scoreRows, p.id),
  }));
}

// Turns a raw round row + already-mapped players into state.round.
// Both the RPC path and the direct-read path funnel through here, so
// this is the single place to touch when a round column is added.
function mapRoundRow(row, players) {
  return {
    id: row.id, code: row.code, courseName: row.course_name, holeCount: row.hole_count,
    pars: row.pars, modes: row.modes, strokeIndex: row.stroke_index || null,
    matchTeamA: row.match_team_a || null, matchTeamB: row.match_team_b || null,
    matchUseHandicap: row.match_use_handicap !== false,
    hostId: row.host_player_id, started: row.started, ended: row.ended,
    holeOffset: row.hole_offset || 0,
    betsEnabled: row.bets_enabled === true, stakes: row.stakes || {},
    players,
  };
}

// ---------------------------------------------------------
// Loading a round's full state from Supabase
// ---------------------------------------------------------
async function loadRound(roundId) {
  if (!state.myPlayerId) {
    // Not a confirmed member yet (e.g. on the identify screen right
    // after joining by code) — this is the one deliberate exception.
    const { data, error } = await supabaseClient.rpc('get_round_state', { p_round_id: roundId });
    if (error || !data || !data.round) {
      showToast('This round no longer exists');
      goHome();
      return null;
    }
    const players = mapPlayers(data.players, data.scores);
    state.round = mapRoundRow(data.round, players);
    return state.round;
  }

  // Already a confirmed member — use real, RLS-protected reads.
  const { data: roundRow, error: roundErr } = await supabaseClient
    .from('rounds').select('*').eq('id', roundId).single();
  if (roundErr || !roundRow) {
    showToast('This round no longer exists');
    goHome();
    return null;
  }

  const { data: playerRows, error: playersErr } = await supabaseClient
    .from('players').select('*').eq('round_id', roundId).order('created_at', { ascending: true });
  if (playersErr) { showToast('Could not load players'); return null; }

  const playerIds = playerRows.map(p => p.id);
  let scoreRows = [];
  if (playerIds.length > 0) {
    const { data: sRows, error: scoresErr } = await supabaseClient
      .from('scores').select('*').in('player_id', playerIds);
    if (scoresErr) { showToast('Could not load scores'); return null; }
    scoreRows = sRows;
  }

  const players = mapPlayers(playerRows, scoreRows);
  state.round = mapRoundRow(roundRow, players);
  return state.round;
}
// ---------------------------------------------------------
// Realtime subscription
// ---------------------------------------------------------
function subscribeToRound(roundId) {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }

  const channel = supabaseClient
    .channel('round-' + roundId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rounds', filter: `id=eq.${roundId}` },
      (payload) => {
        // Caught the moment the host ends the round — jump straight to
        // the final leaderboard instead of doing a normal reload, since
        // the round is about to be archived and deleted out from under us.
        if (payload.new && payload.new.ended === true && state.round && !state.round.ended) {
          enterFinalLeaderboard();
        } else {
          onRoundChanged(roundId);
        }
      })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rounds', filter: `id=eq.${roundId}` },
      () => onRoundChanged(roundId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `round_id=eq.${roundId}` },
      () => onRoundChanged(roundId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' },
      () => onRoundChanged(roundId))
    .subscribe();

  state.realtimeChannel = channel;
}

let reloadTimer = null;
function onRoundChanged(roundId) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (!state.myPlayerId) return; // not a confirmed member yet — nothing to refresh
    await loadRound(roundId);
    onRoundUpdate();
  }, 150);
}

function onRoundUpdate() {
  if (!state.round) return;
  const activeId = document.querySelector('.screen.active')?.id;
  if (activeId === 'screen-lobby') renderLobby();
  if (activeId === 'screen-round') {
    if (state.round.started === false) {
      // Host started it elsewhere, or we're still waiting — re-check.
    }
    renderRoundHeader();
    renderScoringSelector();
    renderScorecardTab();
    renderLeaderboardTab();
  }
  if (activeId === 'screen-lobby' && state.round.started) {
    enterRound();
  }
}

// ---------------------------------------------------------
// Entering the round proper
// ---------------------------------------------------------
function enterRound() {
  saveSession();
  state.scoringPlayerId = state.myPlayerId;
  renderScoringSelector();
  populateModeTabs();
  state.currentHole = 1;
  state.hasShownHole15Reminder = false;
  hideFifteenthHoleReminder();
  showScreen('screen-round');
  setTab('card');
  renderRoundHeader();
  renderScorecardTab();
  renderLeaderboardTab();
}

// Lets the host pick any player from a dropdown and enter scores on
// their behalf. Everyone else just sees a static "Entering for you"
// label, same as before.
function renderScoringSelector() {
  const label = document.getElementById('scoring-for-label');
  const select = document.getElementById('scoring-for-select');

  if (!isHost()) {
    const me = myPlayer();
    label.textContent = me ? `Entering for ${me.name}` : 'Entering for you';
    label.hidden = false;
    select.hidden = true;
    return;
  }

  label.textContent = 'Scoring for';
  select.hidden = false;
  select.innerHTML = state.round.players.map(p =>
    `<option value="${p.id}" ${p.id === state.scoringPlayerId ? 'selected' : ''}>${escapeHtml(p.name)}${p.id === state.myPlayerId ? ' (you)' : ''}</option>`
  ).join('');
}

function populateModeTabs() {
  const modes = roundBoardModes(state.round);
  state.activeModeTab = modes[0];
  const row = document.getElementById('modetab-row');
  row.innerHTML = modes.map(m =>
    `<button class="modetab ${m === state.activeModeTab ? 'active' : ''}" data-mode="${m}">${MODE_NAMES[m] || m}</button>`
  ).join('');
  row.querySelectorAll('.modetab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeModeTab = btn.dataset.mode;
      row.querySelectorAll('.modetab').forEach(b => b.classList.toggle('active', b === btn));
      renderLeaderboardTab();
    });
  });
}

function renderRoundHeader() {
  const r = state.round;
  document.getElementById('round-course-name').textContent = r.courseName;
  document.getElementById('round-meta').textContent = r.ended
    ? `${r.holeCount} holes · Final results`
    : `${r.holeCount} holes · code ${r.code}`;
}

// ---------------------------------------------------------
// Ending the round
// ---------------------------------------------------------

// Called on every client the moment rounds.ended flips to true —
// either right after the host's own end_round call, or via the
// realtime UPDATE everyone else receives. Switches to the leaderboard
// tab and stops listening for further changes, since the round is
// about to be archived and deleted.
function enterFinalLeaderboard() {
  if (state.realtimeChannel) {
    supabaseClient.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
  state.round.ended = true;
  setTab('board');
  renderRoundHeader();
  renderScorecardTab();
  renderLeaderboardTab();
}

// Host-only: validates every player has a score for every hole, then
// ends the round. end_round() flips rounds.ended to true (which
// broadcasts to everyone over realtime) and archive_round() — called
// a couple seconds later, giving that broadcast time to land on every
// device — snapshots the round and deletes the live row.
async function endRound() {
  if (state.endingRound) return;
  const r = state.round;

  const missing = Golf.findMissingScores(r.players, r.holeCount);
  if (missing.length > 0) {
    const detail = missing
      .map(m => `${m.name} (hole${m.missingHoles.length > 1 ? 's' : ''} ${m.missingHoles.join(', ')})`)
      .join('; ');
    showToast(`Still missing scores — ${detail}`);
    return;
  }

  state.endingRound = true;
  const { error } = await supabaseClient.rpc('end_round', { p_round_id: r.id });
  if (error) {
    console.error(error);
    showToast('Could not end the round — check your connection');
    state.endingRound = false;
    return;
  }

  enterFinalLeaderboard();

  setTimeout(async () => {
    const { error: archiveErr } = await supabaseClient.rpc('archive_round', { p_round_id: r.id });
    if (archiveErr) console.error(archiveErr);
    state.endingRound = false;
  }, 2000);
}

// ---------------------------------------------------------
// Tabs
// ---------------------------------------------------------
function setTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.remove('active'));
  document.getElementById(tab === 'card' ? 'tab-card' : 'tab-board').classList.add('active');
  if (tab === 'board') renderLeaderboardTab();
}

