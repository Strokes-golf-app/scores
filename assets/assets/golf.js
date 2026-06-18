/* ===========================================================
   golf.js — pure scoring logic, no DOM, no database calls.
   Every function takes plain data and returns plain data,
   so it's easy to reason about independent of how the data
   was fetched (Supabase, Firebase, or anything else).
=========================================================== */

const Golf = (() => {

  /**
   * Standard USGA-style stroke allocation by hole "difficulty rank".
   * If the round doesn't have per-hole handicap ranks set, we fall back
   * to allocating strokes in hole order (1, 2, 3...) which is a
   * reasonable approximation for casual rounds.
   */
  function allocateStrokes(courseHandicap, holeCount, strokeIndex) {
    const idx = strokeIndex && strokeIndex.length === holeCount
      ? strokeIndex
      : Array.from({ length: holeCount }, (_, i) => i + 1);

    const result = new Array(holeCount).fill(0);
    const hcp = Math.max(0, Math.round(courseHandicap || 0));

    for (let h = 0; h < holeCount; h++) {
      const rank = idx[h];
      if (rank <= hcp) result[h] += 1;
      if (hcp > holeCount && rank <= (hcp - holeCount)) result[h] += 1;
    }
    return result;
  }

  function netHoleScore(grossStrokes, strokesReceived) {
    if (grossStrokes == null) return null;
    return grossStrokes - strokesReceived;
  }

  /**
   * Stableford points for one hole, standard scale:
   * net double bogey or worse = 0, net bogey = 1, net par = 2,
   * net birdie = 3, net eagle = 4, and so on.
   */
  function stablefordPoints(netScore, par) {
    if (netScore == null) return null;
    const diff = netScore - par;
    if (diff <= -3) return 6;
    if (diff === -2) return 5;
    if (diff === -1) return 4;
    if (diff === 0) return 3;
    if (diff === 1) return 2;
    if (diff === 2) return 1;
    return 0;
  }

  /**
   * Build a per-player summary across all holes played so far.
   * @param {object} player - { id, name, handicap }
   * @param {object} scores - map of holeNumber(string) -> grossStrokes
   * @param {number[]} pars - array indexed by hole (0-based)
   * @param {number[]} strokeIndex - array indexed by hole (0-based), difficulty rank
   * @param {number} holeCount
   */
  function summarizePlayer(player, scores, pars, strokeIndex, holeCount) {
    const strokesPerHole = allocateStrokes(player.handicap, holeCount, strokeIndex);
    const holes = [];
    let thru = 0;
    let grossTotal = 0;
    let netTotal = 0;
    let stablefordTotal = 0;
    let parPlayedTotal = 0;

    for (let h = 0; h < holeCount; h++) {
      const holeNum = h + 1;
      const gross = scores && scores[String(holeNum)] != null ? Number(scores[String(holeNum)]) : null;
      const par = (pars && pars[h]) || 4;
      const received = strokesPerHole[h];
      const net = netHoleScore(gross, received);
      const pts = stablefordPoints(net, par);

      if (gross != null) {
        thru = holeNum;
        grossTotal += gross;
        netTotal += net;
        stablefordTotal += pts;
        parPlayedTotal += par;
      }

      holes.push({ hole: holeNum, par, gross, received, net, points: pts });
    }

    return {
      playerId: player.id,
      name: player.name,
      handicap: player.handicap || 0,
      holes,
      thru,
      grossTotal,
      netTotal,
      stablefordTotal,
      toParGross: grossTotal - parPlayedTotal,
      toParNet: netTotal - parPlayedTotal,
      parPlayedTotal,
    };
  }

  /**
   * Rank a list of player summaries for a given mode. Lower is better for
   * gross/net, higher is better for stableford. Ties share a rank.
   */
  function rankPlayers(summaries, mode) {
    const withScore = summaries.map(s => {
      let value;
      if (mode === 'stableford') value = s.stablefordTotal;
      else if (mode === 'net') value = s.toParNet;
      else value = s.toParGross;
      return { ...s, sortValue: value };
    });

    const played = withScore.filter(s => s.thru > 0);
    const notStarted = withScore.filter(s => s.thru === 0);

    played.sort((a, b) => {
      if (mode === 'stableford') return b.sortValue - a.sortValue;
      return a.sortValue - b.sortValue;
    });

    let rank = 0;
    let lastValue = null;
    played.forEach((p, i) => {
      if (lastValue === null || p.sortValue !== lastValue) {
        rank = i + 1;
        lastValue = p.sortValue;
      }
      p.rank = rank;
    });
    notStarted.forEach(p => { p.rank = null; });

    return [...played, ...notStarted];
  }

  /**
   * Skins: for each hole where ALL players in the list have entered a score,
   * the player with the lowest net score wins a skin. Ties push (no winner).
   */
  function computeSkins(summaries, holeCount) {
    const skinsByPlayer = {};
    summaries.forEach(s => { skinsByPlayer[s.playerId] = 0; });
    const log = [];

    for (let h = 0; h < holeCount; h++) {
      const entries = summaries
        .map(s => ({ playerId: s.playerId, net: s.holes[h] ? s.holes[h].net : null }))
        .filter(e => e.net != null);

      if (entries.length < summaries.length || entries.length === 0) {
        log.push({ hole: h + 1, winnerId: null, pending: entries.length < summaries.length });
        continue;
      }

      const minNet = Math.min(...entries.map(e => e.net));
      const winners = entries.filter(e => e.net === minNet);

      if (winners.length === 1) {
        skinsByPlayer[winners[0].playerId] += 1;
        log.push({ hole: h + 1, winnerId: winners[0].playerId, pending: false });
      } else {
        log.push({ hole: h + 1, winnerId: null, pending: false });
      }
    }

    return { skinsByPlayer, log };
  }

  /**
   * Match play between exactly two players, hole-by-hole net score.
   */
  function computeMatchPlay(summaryA, summaryB, holeCount) {
    let diff = 0;
    let thru = 0;
    const log = [];

    for (let h = 0; h < holeCount; h++) {
      const a = summaryA.holes[h];
      const b = summaryB.holes[h];
      if (a.gross == null || b.gross == null) break;
      thru = h + 1;

      if (a.net < b.net) diff += 1;
      else if (b.net < a.net) diff -= 1;
      log.push({ hole: h + 1, result: a.net === b.net ? 'halved' : (a.net < b.net ? 'A' : 'B') });

      const holesRemaining = holeCount - thru;
      if (Math.abs(diff) > holesRemaining) {
        return {
          thru, diff, decided: true,
          winner: diff > 0 ? 'A' : 'B',
          margin: Math.abs(diff),
          remaining: holesRemaining,
          log,
        };
      }
    }

    return {
      thru, diff,
      decided: thru === holeCount && diff !== 0,
      winner: diff > 0 ? 'A' : (diff < 0 ? 'B' : null),
      margin: Math.abs(diff),
      remaining: holeCount - thru,
      log,
    };
  }

  function formatToPar(n) {
    if (n === 0) return 'E';
    return n > 0 ? `+${n}` : `${n}`;
  }

  return {
    allocateStrokes,
    netHoleScore,
    stablefordPoints,
    summarizePlayer,
    rankPlayers,
    computeSkins,
    computeMatchPlay,
    formatToPar,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Golf;
}
