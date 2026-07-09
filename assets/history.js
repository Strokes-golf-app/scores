'use strict';

/* ===========================================================
   history.js — the round-history screen: lists the signed-in
   user's completed rounds (newest first) with their own
   gross-to-par for each.

   Rows come from completed_rounds; its RLS SELECT policy
   (auth.uid() = ANY participant_user_ids) already scopes the
   result to rounds this user played in. Gross-to-par is computed
   with Golf.summarizePlayer — the same engine the live
   leaderboard uses — so history matches what players saw.

   Loads after leaderboard.js, before app.js. Functions stay
   global. Depends on: core.js (escapeHtml, showScreen),
   golf.js (Golf.*), Supabase client.
=========================================================== */

async function openRoundHistory() {
  showScreen('screen-history');
  await loadRoundHistory();
}

async function loadRoundHistory() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="history-empty">Loading your rounds…</div>';

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    listEl.innerHTML = '<div class="history-empty">Log in to see your round history.</div>';
    return;
  }

  const { data: rows, error } = await supabaseClient
    .from('completed_rounds')
    .select('*')
    .order('ended_at', { ascending: false });

  if (error) {
    console.error(error);
    listEl.innerHTML = '<div class="history-empty">Could not load your rounds — check your connection.</div>';
    return;
  }

  if (!rows || rows.length === 0) {
    listEl.innerHTML = "<div class=\"history-empty\">No completed rounds yet. Finish a round and it'll show up here.</div>";
    return;
  }

  listEl.innerHTML = '';
  rows.forEach(row => {
    const card = buildHistoryCard(row, user.id);
    if (card) listEl.appendChild(card);
  });
}

// One card per completed round, showing the signed-in user's own line
// (name + gross + to-par). Everything needed is inside the snapshot, so
// no extra queries. Stage 3 will make the card tappable for the full
// all-players detail view.
function buildHistoryCard(row, userId) {
  const snap = row.round_snapshot || {};
  const players = row.players_snapshot || [];
  const scores = row.scores_snapshot || [];

  const mePlayer = players.find(p => p.user_id === userId);
  const holeCount = snap.hole_count || (snap.pars ? snap.pars.length : 18);

  let playerLine = '';
  let scoreHtml = '';

  if (mePlayer) {
    // Golf.summarizePlayer expects a holeNumber(string) -> gross map.
    const scoreMap = {};
    scores.forEach(s => {
      if (s.player_id === mePlayer.id) scoreMap[String(s.hole)] = s.strokes;
    });

    const summary = Golf.summarizePlayer(
      mePlayer, scoreMap, snap.pars || [], snap.stroke_index || null, holeCount
    );

    const toParClass = summary.toParGross < 0 ? 'neg' : (summary.toParGross > 0 ? 'pos' : '');
    playerLine = `<span class="history-card-player">${escapeHtml(mePlayer.name)}</span>`;
    scoreHtml = `
      <div class="history-card-score">
        <span class="history-card-gross">${summary.grossTotal}</span>
        <span class="history-card-topar ${toParClass}">${Golf.formatToPar(summary.toParGross)}</span>
      </div>`;
  }

  const card = document.createElement('div');
  card.className = 'history-card';
  card.innerHTML = `
    <div class="history-card-main">
      <span class="history-card-course">${escapeHtml(row.course_name || snap.course_name || 'Round')}</span>
      <span class="history-card-meta">${formatHistoryDate(row.ended_at)} · ${holeCount} holes</span>
      ${playerLine}
    </div>
    ${scoreHtml}
  `;
  return card;
}

// "Jun 29, 2026" — empty string on a missing/bad date.
function formatHistoryDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
