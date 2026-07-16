'use strict';

/* ===========================================================
   scorecard.js — the scorecard (input) tab: hole readout, the
   +/- stroke entry, the per-hole par editor, the hole-15
   reminder, and the mini-hole progress strip.

   Split out of round.js. All functions stay global; this file
   loads after round.js. See index.html for load order.
   Depends on: core.js (state, isHost, showToast), Supabase client.
=========================================================== */

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
  const si = r.strokeIndex && r.strokeIndex[h - 1] != null ? r.strokeIndex[h - 1] : null;
  const gross = player.scores && player.scores[String(h)] != null ? Number(player.scores[String(h)]) : null;

  document.getElementById('hole-number').textContent = h + (r.holeOffset || 0);
  document.getElementById('hole-par').textContent = `Par ${par}`;
  document.getElementById('par-editor-input').value = par;

  // Hole readout under the number: handicap shows whenever the round has
  // stroke-index data; par shows until a score is entered, then gives way
  // to the entered score.
  const hcpEl = document.getElementById('hole-handicap');
  hcpEl.textContent = `Hcp ${si}`;
  hcpEl.hidden = si == null;

  const scoreEl = document.getElementById('hole-score');
  scoreEl.textContent = `Score ${gross}`;
  document.getElementById('hole-par').hidden = gross != null;
  scoreEl.hidden = gross == null;

  document.getElementById('btn-par-toggle').hidden = !isHost();
  if (!isHost()) document.getElementById('par-editor').hidden = true;

  document.getElementById('stroke-number').textContent = gross != null ? gross : '—';
  document.getElementById('stroke-caption').textContent = r.ended
    ? 'This round has ended — scores are locked'
    : (gross != null ? relativeToParLabel(gross, par) : 'Tap + to enter score');

  document.getElementById('btn-stroke-minus').disabled = !!r.ended;
  document.getElementById('btn-stroke-plus').disabled = !!r.ended;

  document.getElementById('end-round-wrap').hidden = !(isHost() && !r.ended && h === r.holeCount);

  renderPuttsRow(player, r, h, gross);

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
    const si = r.strokeIndex && r.strokeIndex[h - 1] != null ? r.strokeIndex[h - 1] : null;
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

    const num = document.createElement('span');
    num.className = 'mini-hole-num';
    num.textContent = h + (r.holeOffset || 0);

    const score = document.createElement('span');
    score.className = 'mini-hole-score';
    score.textContent = gross != null ? gross : '—';

    const sub = document.createElement('div');
    sub.className = 'mini-hole-sub';
    const parLine = document.createElement('span');
    parLine.textContent = `Par ${par}`;
    sub.appendChild(parLine);
    if (si != null) {
      const hcpLine = document.createElement('span');
      hcpLine.textContent = `Hcp ${si}`;
      sub.appendChild(hcpLine);
    }

    cell.append(num, score, sub);
    cell.addEventListener('click', () => { state.currentHole = h; renderScorecardTab(); });
    wrap.appendChild(cell);
  }
}

// The putts chip row (0–5+) under the stroke entry. Shown only once the
// hole has a stroke score and only when entering your own card; the seeded
// default of 2 renders as the selected chip until the player adjusts it.
function renderPuttsRow(player, r, h, gross) {
  const wrap = document.getElementById('putts-row');
  if (!wrap) return;

  const editingSelf = player.id === state.myPlayerId;
  if (gross == null || !editingSelf) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = 'flex';

  const current = player.putts && player.putts[String(h)] != null ? Number(player.putts[String(h)]) : 2;
  const chips = [0, 1, 2, 3, 4, 5];
  const chipHtml = chips.map(v => {
    const label = v === 5 ? '5+' : String(v);
    const active = (v === 5 ? current >= 5 : current === v) ? ' active' : '';
    const disabled = r.ended ? ' disabled' : '';
    return `<button type="button" class="putt-chip${active}" data-putts="${v}"${disabled}>${label}</button>`;
  }).join('');

  wrap.innerHTML = `<span class="putts-label">Putts</span><div class="putts-chips">${chipHtml}</div>`;
}

async function setPutts(value) {
  const r = state.round;
  if (r.ended) {
    showToast('This round has ended');
    return;
  }
  const player = scoringPlayer();
  if (!player) return;
  const h = state.currentHole;

  // Putts only make sense once a stroke score exists for the hole.
  if (!player.scores || player.scores[String(h)] == null) return;

  const putts = Math.max(0, Math.min(10, Number(value)));
  if (!player.putts) player.putts = {};
  player.putts[String(h)] = putts;
  renderScorecardTab();

  const strokes = Number(player.scores[String(h)]);
  const editingSelf = player.id === state.myPlayerId;
  const { error } = editingSelf
    ? await supabaseClient
        .from('scores')
        .upsert({ player_id: player.id, hole: h, strokes, putts }, { onConflict: 'player_id,hole' })
    : await supabaseClient.rpc('host_upsert_score', { p_player_id: player.id, p_hole: h, p_strokes: strokes });

  if (error) {
    console.error(error);
    showToast('Could not save putts — check your connection');
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

  // First score on this hole seeds putts with the default of 2 so the chip
  // row shows a real, saved value the player can adjust down or up.
  if (!player.putts) player.putts = {};
  if (player.putts[String(h)] == null) player.putts[String(h)] = 2;
  const putts = player.putts[String(h)];

  renderScorecardTab();

  const editingSelf = player.id === state.myPlayerId;
  const { error } = editingSelf
    ? await supabaseClient
        .from('scores')
        .upsert({ player_id: player.id, hole: h, strokes: next, putts }, { onConflict: 'player_id,hole' })
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
  showToast(`Hole ${h + (state.round.holeOffset || 0)} par set to ${val}`);
}
