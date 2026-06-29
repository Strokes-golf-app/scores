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
    const players = data.players.map(p => {
      const scores = {};
      data.scores.filter(s => s.player_id === p.id).forEach(s => { scores[String(s.hole)] = s.strokes; });
      return { ...p, handicap: Number(p.handicap) || 0, scores };
    });
    const r = data.round;
    state.round = {
      id: r.id, code: r.code, courseName: r.course_name, holeCount: r.hole_count,
      pars: r.pars, modes: r.modes, strokeIndex: r.stroke_index || null,
      matchTeamA: r.match_team_a || null, matchTeamB: r.match_team_b || null,
      matchUseHandicap: r.match_use_handicap !== false,
      hostId: r.host_player_id, started: r.started, ended: r.ended, players,
    };
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

  const players = playerRows.map(p => {
    const scores = {};
    scoreRows.filter(s => s.player_id === p.id).forEach(s => { scores[String(s.hole)] = s.strokes; });
    return { ...p, handicap: Number(p.handicap) || 0, scores };
  });

  state.round = {
    id: roundRow.id, code: roundRow.code, courseName: roundRow.course_name, holeCount: roundRow.hole_count,
    pars: roundRow.pars, modes: roundRow.modes, strokeIndex: roundRow.stroke_index || null,
    matchTeamA: roundRow.match_team_a || null, matchTeamB: roundRow.match_team_b || null,
    matchUseHandicap: roundRow.match_use_handicap !== false,
    hostId: roundRow.host_player_id, started: roundRow.started, ended: roundRow.ended, players,
  };
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
  const modes = state.round.modes && state.round.modes.length ? state.round.modes : ['gross'];
  state.activeModeTab = modes[0];
  const modeNames = { gross: 'Gross', net: 'Net', stableford: 'Stableford', skins: 'Skins', match: 'Match play' };
  const row = document.getElementById('modetab-row');
  row.innerHTML = modes.map(m =>
    `<button class="modetab ${m === state.activeModeTab ? 'active' : ''}" data-mode="${m}">${modeNames[m] || m}</button>`
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

// ---------------------------------------------------------
// Scorecard tab rendering
// ---------------------------------------------------------
function myPlayer() {
  return state.round.players.find(p => p.id === state.myPlayerId);
}

// The player whose scorecard is currently being entered — normally
// yourself, but the host can switch this via the dropdown to enter
// scores on behalf of someone else (e.g. their phone died mid-round).
function scoringPlayer() {
  const id = state.scoringPlayerId || state.myPlayerId;
  return state.round.players.find(p => p.id === id);
}

// The hole right after the last one this player has a score for —
// used so switching the scoring dropdown lands you where they left
// off instead of always jumping back to hole 1.
function nextUnplayedHole(player, holeCount) {
  if (!player || !player.scores) return 1;
  let lastPlayed = 0;
  for (let h = 1; h <= holeCount; h++) {
    if (player.scores[String(h)] != null) lastPlayed = h;
  }
  return Math.min(holeCount, lastPlayed + 1);
}

function hideFifteenthHoleReminder() {
  const modal = document.getElementById('hole15-modal');
  if (modal) modal.hidden = true;
}

function showFifteenthHoleReminder() {
  if (!state.round || state.round.holeCount < 15 || state.hasShownHole15Reminder) return;
  const modal = document.getElementById('hole15-modal');
  if (!modal) return;
  modal.hidden = false;
  state.hasShownHole15Reminder = true;
}

function renderScorecardTab() {
  const r = state.round;
  const player = scoringPlayer();
  if (!player) return;

  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  document.getElementById('hole-number').textContent = h;
  document.getElementById('hole-par').textContent = `Par ${par}`;
  document.getElementById('par-editor-input').value = par;

  document.getElementById('btn-par-toggle').hidden = !isHost();
  if (!isHost()) document.getElementById('par-editor').hidden = true;

  const gross = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
  document.getElementById('stroke-number').textContent = gross != null ? gross : '—';
  document.getElementById('stroke-caption').textContent = r.ended
    ? 'This round has ended — scores are locked'
    : (gross != null ? relativeToParLabel(gross, par) : 'Tap + to enter score');

  document.getElementById('btn-stroke-minus').disabled = !!r.ended;
  document.getElementById('btn-stroke-plus').disabled = !!r.ended;

  document.getElementById('end-round-wrap').hidden = !(isHost() && !r.ended && h === r.holeCount);

  if (h === 15) {
    showFifteenthHoleReminder();
  }

  renderMiniHoles(player, r);
}

function relativeToParLabel(gross, par) {
  const diff = gross - par;
  if (diff === 0) return 'Par';
  if (diff === -1) return 'Birdie';
  if (diff <= -2) return 'Eagle or better';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double bogey';
  return `+${diff} over par`;
}

function renderMiniHoles(player, r) {
  const wrap = document.getElementById('mini-holes');
  wrap.innerHTML = '';
  for (let h = 1; h <= r.holeCount; h++) {
    const par = r.pars[h - 1] || 4;
    const gross = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
    const cell = document.createElement('div');
    let cls = 'mini-hole';
    if (gross != null) {
      cls += ' played';
      if (gross < par) cls += ' under';
      else if (gross > par) cls += ' over';
      else cls += ' even';
    }
    if (h === state.currentHole) cls += ' current';
    cell.className = cls;
    cell.textContent = gross != null ? gross : h;
    cell.addEventListener('click', () => { state.currentHole = h; renderScorecardTab(); });
    wrap.appendChild(cell);
  }
}

async function setStroke(delta) {
  const r = state.round;
  if (r.ended) {
    showToast('This round has ended');
    return;
  }
  const player = scoringPlayer();
  if (!player) return;
  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  const current = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
  let next = current == null ? par : current + delta;
  next = Math.max(1, Math.min(15, next));

  player.scores[String(h)] = next;
  renderScorecardTab();

  const editingSelf = player.id === state.myPlayerId;
  const { error } = editingSelf
    ? await supabaseClient
        .from('scores')
        .upsert({ player_id: player.id, hole: h, strokes: next }, { onConflict: 'player_id,hole' })
    : await supabaseClient.rpc('host_upsert_score', { p_player_id: player.id, p_hole: h, p_strokes: next });

  if (error) {
    console.error(error);
    showToast('Could not save score — check your connection');
  }
}

async function savePar() {
  const h = state.currentHole;
  const val = Math.max(2, Math.min(6, Number(document.getElementById('par-editor-input').value) || 4));
  const newPars = [...state.round.pars];
  newPars[h - 1] = val;

  const { error } = await supabaseClient
    .from('rounds')
    .update({ pars: newPars })
    .eq('id', state.round.id);

  if (error) {
    showToast('Could not save par — check your connection');
    return;
  }
  state.round.pars = newPars;
  document.getElementById('par-editor').hidden = true;
  renderScorecardTab();
  showToast(`Hole ${h} par set to ${val}`);
}

// ---------------------------------------------------------
// Leaderboard tab rendering
// ---------------------------------------------------------
function buildSummaries() {
  const r = state.round;
  return r.players.map(p =>
    Golf.summarizePlayer(p, p.scores || {}, r.pars, r.strokeIndex, r.holeCount)
  );
}

function renderLeaderboardTab() {
  const r = state.round;
  if (!r) return;
  const mode = state.activeModeTab || (r.modes && r.modes[0]) || 'gross';
  const summaries = buildSummaries();

  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (summaries.every(s => s.thru === 0)) {
    metaEl.textContent = 'No scores posted yet.';
    boardEl.innerHTML = '<div class="lb-empty">Scores will appear here as players start entering them.</div>';
    return;
  }

  if (mode === 'skins') {
    renderSkinsBoard(summaries, r);
    return;
  }
  if (mode === 'match') {
    renderMatchBoard(summaries, r);
    return;
  }

  metaEl.textContent = mode === 'stableford'
    ? 'Points scored per hole, summed. Higher is better.'
    : 'Total score relative to par. Lower is better.';

  const ranked = Golf.rankPlayers(summaries, mode);
  boardEl.innerHTML = '';
  ranked.forEach(s => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (s.rank === 1 ? ' leader' : '');

    let scoreText, scoreClass = '';
    if (mode === 'stableford') {
      scoreText = s.thru > 0 ? s.stablefordTotal : '–';
    } else {
      const toPar = mode === 'net' ? s.toParNet : s.toParGross;
      scoreText = s.thru > 0 ? Golf.formatToPar(toPar) : '–';
      scoreClass = toPar < 0 ? 'neg' : (toPar > 0 ? 'pos' : '');
    }

    const detail = mode === 'net' ? `${s.netTotal} net` : (mode === 'stableford' ? `${s.grossTotal} gross` : `HCP ${s.handicap}`);

    row.innerHTML = `
      <span class="lb-rank">${s.rank || '–'}</span>
      <span class="lb-name-wrap">
        <span class="lb-name">${escapeHtml(s.name)}</span>
        <span class="lb-thru">${s.thru > 0 ? 'thru ' + s.thru : 'not started'}</span>
      </span>
      <span class="lb-detail">${s.thru > 0 ? detail : ''}</span>
      <span class="lb-score ${scoreClass}">${scoreText}</span>
    `;
    boardEl.appendChild(row);
  });
}

function renderSkinsBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');
  const { skinsByPlayer, log } = Golf.computeSkins(summaries, r.holeCount);
  const pendingCount = log.filter(l => l.pending).length;

  metaEl.textContent = pendingCount > 0
    ? `Skins won so far. ${pendingCount} hole(s) still waiting on everyone's score.`
    : 'Skins won. Lowest net score on a hole takes it; ties push.';

  const ranked = Object.entries(skinsByPlayer)
    .map(([playerId, count]) => ({ playerId, count, name: summaries.find(s => s.playerId === playerId)?.name || '?' }))
    .sort((a, b) => b.count - a.count);

  boardEl.innerHTML = '';
  ranked.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === 0 && p.count > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score">${p.count}</span>
    `;
    boardEl.appendChild(row);
  });
}

function renderMatchBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  if (!r.matchTeamA || !r.matchTeamB || r.matchTeamA.length === 0 || r.matchTeamB.length === 0) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Match play needs teams selected at setup.</div>';
    return;
  }

  const teamASummaries = r.matchTeamA.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  const teamBSummaries = r.matchTeamB.map(id => summaries.find(s => s.playerId === id)).filter(Boolean);
  if (teamASummaries.length === 0 || teamBSummaries.length === 0) return;

  const m = Golf.computeMatchPlay(teamASummaries, teamBSummaries, r.holeCount, r.matchUseHandicap);
  const teamAName = teamASummaries.map(s => s.name).join(' & ');
  const teamBName = teamBSummaries.map(s => s.name).join(' & ');

  metaEl.textContent = r.matchUseHandicap
    ? 'Head-to-head, best-ball net score per hole.'
    : 'Head-to-head, best-ball gross score per hole.';

  let statusText;
  if (m.thru === 0) {
    statusText = 'Not started';
  } else if (m.diff === 0) {
    statusText = 'All square';
  } else {
    const leaderName = m.diff > 0 ? teamAName : teamBName;
    statusText = m.decided && m.thru < r.holeCount
      ? `${leaderName} wins ${m.margin}&${m.remaining}`
      : `${leaderName} ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="match-card">
      <p class="match-vs">${escapeHtml(teamAName)} vs ${escapeHtml(teamBName)}</p>
      <p class="match-status">${statusText}</p>
      <p class="match-thru">thru ${m.thru} of ${r.holeCount}</p>
    </div>
  `;
}
