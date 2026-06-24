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
  const { data: roundRow, error: roundErr } = await supabaseClient
    .from('rounds')
    .select('*')
    .eq('id', roundId)
    .single();
  if (roundErr || !roundRow) {
    showToast('This round no longer exists');
    goHome();
    return null;
  }

  const { data: playerRows, error: playersErr } = await supabaseClient
    .from('players')
    .select('*')
    .eq('round_id', roundId)
    .order('created_at', { ascending: true });
  if (playersErr) {
    showToast('Could not load players');
    return null;
  }

  const playerIds = playerRows.map(p => p.id);
  let scoreRows = [];
  if (playerIds.length > 0) {
    const { data: sRows, error: scoresErr } = await supabaseClient
      .from('scores')
      .select('*')
      .in('player_id', playerIds);
    if (scoresErr) {
      showToast('Could not load scores');
      return null;
    }
    scoreRows = sRows;
  }

  const players = playerRows.map(p => {
    const scores = {};
    scoreRows.filter(s => s.player_id === p.id).forEach(s => {
      scores[String(s.hole)] = s.strokes;
    });
    return { ...p, scores };
  });

  state.round = {
    id: roundRow.id,
    code: roundRow.code,
    courseName: roundRow.course_name,
    holeCount: roundRow.hole_count,
    pars: roundRow.pars,
    modes: roundRow.modes,
    matchPlayers: (roundRow.match_player_a && roundRow.match_player_b)
      ? [roundRow.match_player_a, roundRow.match_player_b] : null,
    hostId: roundRow.host_player_id,
    started: roundRow.started,
    ended: roundRow.ended,
    players,
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

  const channel = supabaseClient
    .channel('round-' + roundId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `id=eq.${roundId}` },
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
  const me = state.round.players.find(p => p.id === state.myPlayerId);
  document.getElementById('scoring-for-label').textContent = me ? `Entering for ${me.name}` : 'Entering for you';
  populateModeTabs();
  state.currentHole = 1;
  showScreen('screen-round');
  setTab('card');
  renderRoundHeader();
  renderScorecardTab();
  renderLeaderboardTab();
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
  document.getElementById('round-meta').textContent = `${r.holeCount} holes · code ${r.code}`;
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

function renderScorecardTab() {
  const r = state.round;
  const player = myPlayer();
  if (!player) return;

  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  document.getElementById('hole-number').textContent = h;
  document.getElementById('hole-par').textContent = `Par ${par}`;
  document.getElementById('par-editor-input').value = par;

  const gross = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
  document.getElementById('stroke-number').textContent = gross != null ? gross : '—';
  document.getElementById('stroke-caption').textContent = r.ended
    ? 'This round has ended — scores are locked'
    : (gross != null ? relativeToParLabel(gross, par) : 'Tap + to enter score');

  document.getElementById('btn-stroke-minus').disabled = !!r.ended;
  document.getElementById('btn-stroke-plus').disabled = !!r.ended;

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
  const player = myPlayer();
  if (!player) return;
  const h = state.currentHole;
  const par = r.pars[h - 1] || 4;
  const current = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;
  let next = current == null ? par : current + delta;
  next = Math.max(1, Math.min(15, next));

  player.scores[String(h)] = next;
  renderScorecardTab();

  const { error } = await supabaseClient
    .from('scores')
    .upsert({ player_id: player.id, hole: h, strokes: next }, { onConflict: 'player_id,hole' });

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
    Golf.summarizePlayer(p, p.scores || {}, r.pars, null, r.holeCount)
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

  if (!r.matchPlayers || r.matchPlayers.length !== 2) {
    metaEl.textContent = '';
    boardEl.innerHTML = '<div class="lb-empty">Match play needs exactly two players selected at setup.</div>';
    return;
  }

  const sA = summaries.find(s => s.playerId === r.matchPlayers[0]);
  const sB = summaries.find(s => s.playerId === r.matchPlayers[1]);
  if (!sA || !sB) return;

  const m = Golf.computeMatchPlay(sA, sB, r.holeCount);
  metaEl.textContent = 'Head-to-head, net score per hole.';

  let statusText;
  if (m.thru === 0) {
    statusText = 'Not started';
  } else if (m.diff === 0) {
    statusText = 'All square';
  } else {
    const leaderName = m.diff > 0 ? sA.name : sB.name;
    statusText = m.decided && m.thru < r.holeCount
      ? `${leaderName} wins ${m.margin}&${m.remaining}`
      : `${leaderName} ${m.margin} up`;
  }

  boardEl.innerHTML = `
    <div class="match-card">
      <p class="match-vs">${escapeHtml(sA.name)} vs ${escapeHtml(sB.name)}</p>
      <p class="match-status">${statusText}</p>
      <p class="match-thru">thru ${m.thru} of ${r.holeCount}</p>
    </div>
  `;
}
