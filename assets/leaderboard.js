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

// Total recorded putts for a player across every hole. Holes with no putt
// count recorded are simply skipped. Used on the gross board.
function playerPuttsTotal(playerId) {
  const p = (state.round.players || []).find(pl => pl.id === playerId);
  if (!p || !p.putts) return 0;
  return Object.keys(p.putts).reduce((sum, hole) => {
    const hasScore = p.scores && p.scores[hole] != null;
    return sum + (hasScore ? (Number(p.putts[hole]) || 0) : 0);
  }, 0);
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
  if (mode === 'money') {
    renderMoneyBoard(summaries, r);
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
        <span class="lb-thru">${s.thru > 0 ? 'thru ' + s.thru + (mode === 'gross' ? ' · ' + playerPuttsTotal(s.playerId) + ' putts' : '') : 'not started'}</span>
      </span>
      <span class="lb-detail">${s.thru > 0 ? detail : ''}</span>
      <span class="lb-score ${scoreClass}">${scoreText}</span>
    `;
    boardEl.appendChild(row);
  });
}

function renderMoneyBoard(summaries, r) {
  const metaEl = document.getElementById('board-meta');
  const boardEl = document.getElementById('leaderboard');

  const { byMode, byPlayer, transactions } = Golf.computeMoney(summaries, {
    modes: r.modes,
    stakes: r.stakes,
    holeCount: r.holeCount,
    matchTeamA: r.matchTeamA,
    matchTeamB: r.matchTeamB,
    matchUseHandicap: r.matchUseHandicap,
  });

  metaEl.textContent = 'Net across every bet this round. Provisional until all scores are in.';

  const nameById = {};
  summaries.forEach(s => { nameById[s.playerId] = s.name; });

  const rows = Object.entries(byPlayer)
    .map(([id, net]) => ({ id, net, name: nameById[id] || '?' }))
    .sort((a, b) => b.net - a.net);

  boardEl.innerHTML = '';
  rows.forEach((p, i) => {
    const cls = p.net > 0 ? 'money-up' : (p.net < 0 ? 'money-down' : '');
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === 0 && p.net > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name-wrap"><span class="lb-name">${escapeHtml(p.name)}</span></span>
      <span class="lb-detail"></span>
      <span class="lb-score ${cls}">${Golf.formatMoney(p.net)}</span>
    `;
    boardEl.appendChild(row);
  });

  boardEl.insertAdjacentHTML('beforeend', moneySettleHtml(transactions, nameById));
  boardEl.insertAdjacentHTML('beforeend', moneyBreakdownHtml(byMode, r.stakes, nameById));
}

// Per-mode explainer under the Money board: the rule for each bet that
// moved money (the "why") plus each player's net within it (the "how").
function moneyBreakdownHtml(byMode, stakes, nameById) {
  const modes = STAKE_ORDER.filter(m => byMode[m]);
  if (!modes.length) return '';

  const ruleFor = (m) => {
    const s = stakes && stakes[m] != null ? stakes[m] : '';
    switch (m) {
      case 'gross': return `Everyone antes $${s}. Lowest gross takes the whole pot.`;
      case 'net': return `Everyone antes $${s}. Lowest net takes the whole pot.`;
      case 'stableford': return `Everyone antes $${s}. Most points takes the whole pot.`;
      case 'skins': return `Each skin is worth $${s}, paid to its winner by every other player. Tied holes carry to the next.`;
      case 'match': return `The losing side pays $${s}, split across the winning team.`;
      default: return '';
    }
  };

  const blocks = modes.map(m => {
    const nets = byMode[m];
    const chips = Object.entries(nets)
      .filter(([, v]) => Math.abs(v) > 0.005)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => {
        const dir = v > 0 ? 'money-chip-up' : 'money-chip-down';
        return `<span class="money-chip ${dir}">${escapeHtml(nameById[id] || '?')} <b>${Golf.formatMoney(v)}</b></span>`;
      })
      .join('');
    return `
      <div class="money-mode">
        <div class="money-mode-head">${escapeHtml(MODE_NAMES[m] || m)}</div>
        <div class="money-mode-rule">${ruleFor(m)}</div>
        <div class="money-mode-nets">${chips}</div>
      </div>`;
  }).join('');

  return `<div class="money-breakdown"><div class="money-settle-title">How it breaks down</div>${blocks}</div>`;
}

function moneySettleHtml(transactions, nameById) {
  if (!transactions || !transactions.length) {
    return '<div class="money-settle"><div class="money-settle-title">Settle up</div><div class="money-settle-empty">All square — nothing owed yet.</div></div>';
  }
  const rows = transactions.map(t => {
    const amt = Number.isInteger(t.amount) ? t.amount : t.amount.toFixed(2);
    return `<div class="money-settle-row"><span>${escapeHtml(nameById[t.from] || '?')}</span><i class="money-arrow">→</i><span>${escapeHtml(nameById[t.to] || '?')}</span><span class="money-settle-amt">$${amt}</span></div>`;
  }).join('');
  return `<div class="money-settle"><div class="money-settle-title">Settle up</div>${rows}</div>`;
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
