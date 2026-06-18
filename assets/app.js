/* ===========================================================
   app.js — screen wiring, Supabase sync, rendering.
   Depends on: golf.js (Golf), supabase-config.js (supabase client)

   Data model (see supabase_schema.sql):
   - rounds(id, code, course_name, hole_count, pars, modes,
            match_player_a, match_player_b, host_player_id,
            started, ended)
   - players(id, round_id, name, handicap)
   - scores(id, player_id, hole, strokes)
=========================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  const state = {
    roundId: null,        // internal uuid
    roundCode: null,       // human-facing short code
    round: null,            // { ...round row, players: [{...player row, scores: {hole: strokes}}] }
    myPlayerId: null,
    currentHole: 1,
    activeTab: 'card',
    activeModeTab: null,
    setupPlayers: [],
    realtimeChannel: null,
  };

  const LS_KEY = 'fairwaylive_session';

  // ---------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------
  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
  }

  function makeRoundCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function saveSession() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        roundCode: state.roundCode,
        myPlayerId: state.myPlayerId,
      }));
    } catch (e) { /* storage unavailable, ignore */ }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // Parse a handicap string, allowing one decimal place (e.g. 10.2).
  // Returns a number rounded to 1 decimal place, clamped 0–54.
  function parseHandicap(val) {
    const n = parseFloat(val);
    if (isNaN(n)) return 0;
    return Math.min(54, Math.max(0, Math.round(n * 10) / 10));
  }

  // ---------------------------------------------------------
  // Setup screen: player + par + mode builders
  // ---------------------------------------------------------
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

  function resetSetupScreen() {
    document.getElementById('course-name').value = '';
    document.getElementById('hole-count').value = '18';
    document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
      if (cb.value !== 'gross') cb.checked = false;
      cb.closest('.mode-card').classList.toggle('checked', cb.checked);
    });
    document.getElementById('match-players-field').hidden = true;
    state.setupPlayers = [{ id: uid('p'), name: '', handicap: 0 }];
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
      // 1. Insert the round row.
      const { data: roundRow, error: roundErr } = await supabaseClient
        .from('rounds')
        .insert({
          code,
          course_name: courseName,
          hole_count: holeCount,
          pars,
          modes,
          started: false,
          ended: false,
        })
        .select()
        .single();

      if (roundErr) throw roundErr;

      // 2. Insert all players, getting back their real database ids.
      const { data: playerRows, error: playersErr } = await supabaseClient
        .from('players')
        .insert(validPlayers.map(p => ({
          round_id: roundRow.id,
          name: p.name.trim(),
          handicap: p.handicap || 0,
        })))
        .select();

      if (playersErr) throw playersErr;

      // 3. Now that players have real ids, fill in host + match player ids and save.
      const hostId = playerRows[0].id;
      let matchA = null, matchB = null;
      if (matchPlayerAName) matchA = playerRows.find(p => p.name === matchPlayerAName)?.id || null;
      if (matchPlayerBName) matchB = playerRows.find(p => p.name === matchPlayerBName)?.id || null;

      const { error: updateErr } = await supabaseClient
        .from('rounds')
        .update({ host_player_id: hostId, match_player_a: matchA, match_player_b: matchB })
        .eq('id', roundRow.id);

      if (updateErr) throw updateErr;

      state.roundId = roundRow.id;
      state.roundCode = code;
      state.myPlayerId = hostId;
      saveSession();

      await loadRound(roundRow.id);
      subscribeToRound(roundRow.id);
      document.getElementById('lobby-code').textContent = code;
      document.getElementById('lobby-course-name').textContent = courseName;
      showScreen('screen-lobby');
      renderLobby();
    } catch (e) {
      console.error(e);
      showToast('Could not create round — check your connection and Supabase setup');
    }
  }

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
  // Lobby
  // ---------------------------------------------------------
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
    const name = prompt('Player name?');
    if (!name || !name.trim()) return null;
    const hcpRaw = prompt('Handicap? (e.g. 10.2)');
    const handicap = parseHandicap(hcpRaw);

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
  // Wire up DOM events
  // ---------------------------------------------------------
  function init() {
    document.getElementById('btn-new-round').addEventListener('click', () => {
      resetSetupScreen();
      showScreen('screen-setup');
    });

    document.getElementById('form-join').addEventListener('submit', e => {
      e.preventDefault();
      joinRound(document.getElementById('join-code').value);
    });

    document.getElementById('btn-setup-back').addEventListener('click', () => showScreen('screen-home'));

    document.getElementById('hole-count').addEventListener('change', renderParGrid);

    document.getElementById('btn-add-player').addEventListener('click', () => {
      state.setupPlayers.push({ id: uid('p'), name: '', handicap: 0 });
      renderSetupPlayerList();
    });

    document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
      cb.addEventListener('change', () => {
        document.getElementById('match-players-field').hidden = !document.getElementById('mode-grid').querySelector('input[value="match"]').checked;
        cb.closest('.mode-card').classList.toggle('checked', cb.checked);
      });
    });

    document.getElementById('btn-create-round').addEventListener('click', createRound);

    document.getElementById('btn-lobby-leave').addEventListener('click', goHome);
    document.getElementById('btn-copy-code').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.roundCode);
        showToast('Code copied');
      } catch (e) {
        showToast(`Your code: ${state.roundCode}`);
      }
    });
    document.getElementById('btn-lobby-add-player').addEventListener('click', () => {
      addPlayerToRound(state.roundId);
    });
    document.getElementById('btn-start-round').addEventListener('click', async () => {
      if (!state.round || state.round.players.length === 0) {
        showToast('Add at least one player before starting');
        return;
      }
      if (!state.myPlayerId) {
        showToast('Tap a player below to identify yourself first');
        renderIdentifyList(state.round);
        showScreen('screen-identify');
        return;
      }
      const { error } = await supabaseClient.from('rounds').update({ started: true }).eq('id', state.roundId);
      if (error) {
        showToast('Could not start round — check your connection');
        return;
      }
      await loadRound(state.roundId);
      enterRound();
    });

    document.getElementById('btn-identify-back').addEventListener('click', goHome);
    document.getElementById('btn-identify-add-self').addEventListener('click', async () => {
      const id = await addPlayerToRound(state.roundId);
      if (id) selectIdentity(id);
    });

    document.getElementById('btn-round-leave').addEventListener('click', goHome);
    document.getElementById('btn-round-share').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.roundCode);
        showToast('Round code copied: ' + state.roundCode);
      } catch (e) {
        showToast('Round code: ' + state.roundCode);
      }
    });

    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => setTab(t.dataset.tab));
    });

    document.getElementById('btn-hole-prev').addEventListener('click', () => {
      state.currentHole = Math.max(1, state.currentHole - 1);
      document.getElementById('par-editor').hidden = true;
      renderScorecardTab();
    });
    document.getElementById('btn-hole-next').addEventListener('click', () => {
      state.currentHole = Math.min(state.round.holeCount, state.currentHole + 1);
      document.getElementById('par-editor').hidden = true;
      renderScorecardTab();
    });

    document.getElementById('btn-par-toggle').addEventListener('click', () => {
      const el = document.getElementById('par-editor');
      el.hidden = !el.hidden;
    });
    document.getElementById('btn-par-save').addEventListener('click', savePar);

    document.getElementById('btn-stroke-minus').addEventListener('click', () => setStroke(-1));
    document.getElementById('btn-stroke-plus').addEventListener('click', () => setStroke(1));

    // Try to resume a previous session.
    const session = loadSession();
    if (session && session.roundCode) {
      resumeSession(session);
    } else {
      resetSetupScreen();
      showScreen('screen-home');
    }
  }

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

  document.addEventListener('DOMContentLoaded', init);
})();
