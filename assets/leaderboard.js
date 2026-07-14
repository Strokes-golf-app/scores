'use strict';

/* ===========================================================
   leaderboard.js — the leaderboard (output) tab: building
   per-player summaries and rendering the gross/net/stableford
   boards plus the skins and match-play boards.

   Split out of round.js. All functions stay global; loads
   after round.js. See index.html for load order.
   Depends on: core.js (state, escapeHtml), golf.js (Golf.*).
=========================================================== */

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
  const { skinsByPlayer, log, carry } = Golf.computeSkins(summaries, r.holeCount);
  const pendingCount = log.filter(l => l.pending).length;

  if (pendingCount > 0) {
    metaEl.textContent = `Skins won so far. Ties carry to the next hole. ${pendingCount} hole(s) still waiting on everyone's score.`;
  } else if (carry > 0) {
    metaEl.textContent = `Skins won. Ties carry to the next hole. ${carry} skin(s) still in the pot, unclaimed.`;
  } else {
    metaEl.textContent = 'Skins won. Lowest net on a hole takes the pot; ties carry to the next hole.';
  }

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

  boardEl.insertAdjacentHTML('beforeend', skinsStripHtml(log, summaries, r.holeOffset));
}

// Builds the hole-by-hole skins strip: one cell per hole. Green cells are
// holes won outright (main number is the pot that landed, sub is the
// winner); sand cells are ties where the pot rolled forward (main number
// is the skins now riding); dashed cells are holes still pending. Shared
// by the live leaderboard and the history detail view — defined here
// because leaderboard.js loads before history.js.
function skinsStripHtml(log, summaries, holeOffset) {
  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });
  const off = holeOffset || 0;

  const cells = log.map(entry => {
    const num = entry.hole + off;
    if (entry.pending) {
      return `<div class="skins-cell pending"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">·</span></div>`;
    }
    if (entry.winnerId) {
      const first = escapeHtml((nameById[entry.winnerId] || '?').split(' ')[0]);
      return `<div class="skins-cell won"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${entry.value}</span><span class="skins-cell-sub">${first}</span></div>`;
    }
    // Tied — the pot (what carried in, plus this hole) rolls forward.
    const rolling = (entry.carriedIn || 0) + 1;
    return `<div class="skins-cell carry"><span class="skins-cell-num">${num}</span><span class="skins-cell-main">${rolling}</span><span class="skins-cell-sub">carry</span></div>`;
  }).join('');

  return `<div class="skins-strip-wrap"><p class="skins-strip-label">Hole by hole</p><div class="skins-strip">${cells}</div></div>`;
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
