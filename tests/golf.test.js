import { describe, it, expect } from 'vitest';
import Golf from '../assets/golf.js';
describe('allocateStrokes', () => {
  it('gives one stroke to the hardest N holes for a standard handicap', () => {
    const strokes = Golf.allocateStrokes(10, 18);
    expect(strokes).toHaveLength(18);
    expect(strokes.slice(0, 10)).toEqual(new Array(10).fill(1));
    expect(strokes.slice(10)).toEqual(new Array(8).fill(0));
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(10);
  });

  describe('toRelativeStrokeIndex', () => {
  it('re-ranks a 9-hole subset of an 18-hole stroke index to 1-9', () => {
    const backNine = [2, 14, 6, 18, 4, 16, 8, 12, 10];
    expect(Golf.toRelativeStrokeIndex(backNine)).toEqual([1, 7, 3, 9, 2, 8, 4, 6, 5]);
  });

  it('leaves an already-dense 1-9 ranking unchanged', () => {
    expect(Golf.toRelativeStrokeIndex([3, 1, 2, 5, 4, 9, 7, 8, 6])).toEqual([3, 1, 2, 5, 4, 9, 7, 8, 6]);
  });
});

  it('gives a second stroke on the hardest holes once handicap exceeds hole count', () => {
    const strokes = Golf.allocateStrokes(20, 18);
    expect(strokes[0]).toBe(2);
    expect(strokes[1]).toBe(2);
    expect(strokes.slice(2)).toEqual(new Array(16).fill(1));
    expect(strokes.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('respects a custom stroke index instead of hole order', () => {
    const strokeIndex = [3, 2, 1]; // hole 3 is hardest, hole 1 is easiest
    const strokes = Golf.allocateStrokes(1, 3, strokeIndex);
    expect(strokes).toEqual([0, 0, 1]);
  });
});

describe('netHoleScore', () => {
  it('returns null when no score has been entered', () => {
    expect(Golf.netHoleScore(null, 1)).toBeNull();
  });

  it('subtracts strokes received from the gross score', () => {
    expect(Golf.netHoleScore(5, 1)).toBe(4);
    expect(Golf.netHoleScore(4, 0)).toBe(4);
    expect(Golf.netHoleScore(6, 2)).toBe(4);
  });
});

describe('stablefordPoints', () => {
  it('returns null when there is no net score yet', () => {
    expect(Golf.stablefordPoints(null, 4)).toBeNull();
  });

  it('scores common results on the standard points scale', () => {
    const par = 4;
    expect(Golf.stablefordPoints(par - 3, par)).toBe(6); // albatross+
    expect(Golf.stablefordPoints(par - 2, par)).toBe(5); // eagle
    expect(Golf.stablefordPoints(par - 1, par)).toBe(4); // birdie
    expect(Golf.stablefordPoints(par, par)).toBe(3);     // par
    expect(Golf.stablefordPoints(par + 1, par)).toBe(2); // bogey
    expect(Golf.stablefordPoints(par + 2, par)).toBe(1); // double bogey
    expect(Golf.stablefordPoints(par + 3, par)).toBe(0); // triple+
  });
});

describe('summarizePlayer', () => {
  it('totals gross, net, and Stableford correctly for a 9-hole sample round', () => {
    const player = { id: 'p1', name: 'Hunter', handicap: 5 };
    const pars = [4, 4, 3, 5, 4, 4, 3, 5, 4];
    // handicap 5, default stroke index: holes 1-5 get a stroke, 6-9 don't
    const scores = { 1: 5, 2: 4, 3: 4, 4: 7, 5: 5, 6: 5, 7: 3, 8: 6, 9: 5 };

    const summary = Golf.summarizePlayer(player, scores, pars, null, 9);

    expect(summary.thru).toBe(9);
    expect(summary.grossTotal).toBe(44);
    expect(summary.netTotal).toBe(39);
    expect(summary.stablefordTotal).toBe(24);
    expect(summary.toParGross).toBe(8);
    expect(summary.toParNet).toBe(3);
  });

  it('only counts holes that have actually been played', () => {
    const player = { id: 'p2', name: 'Partial', handicap: 0 };
    const pars = [4, 4, 4];
    const scores = { 1: 4 }; // holes 2 and 3 not entered yet
    const summary = Golf.summarizePlayer(player, scores, pars, null, 3);

    expect(summary.thru).toBe(1);
    expect(summary.grossTotal).toBe(4);
    expect(summary.parPlayedTotal).toBe(4);
  });
});

describe('rankPlayers', () => {
  const summaries = [
    { playerId: 'a', name: 'Alice', thru: 9, toParGross: 2, toParNet: -1, stablefordTotal: 30 },
    { playerId: 'b', name: 'Bob', thru: 9, toParGross: -3, toParNet: 1, stablefordTotal: 25 },
    { playerId: 'c', name: 'Cara', thru: 0, toParGross: 0, toParNet: 0, stablefordTotal: 0 },
  ];

  it('ranks gross mode lowest-to-par first, with non-starters last', () => {
    const ranked = Golf.rankPlayers(summaries, 'gross');
    expect(ranked.map(r => r.playerId)).toEqual(['b', 'a', 'c']);
    expect(ranked[0].rank).toBe(1);
    expect(ranked.find(r => r.playerId === 'c').rank).toBeNull();
  });

  it('ranks net mode by net-to-par', () => {
    const ranked = Golf.rankPlayers(summaries, 'net');
    expect(ranked.map(r => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('ranks Stableford mode highest points first', () => {
    const ranked = Golf.rankPlayers(summaries, 'stableford');
    expect(ranked.map(r => r.playerId)).toEqual(['a', 'b', 'c']);
  });

  it('gives tied players the same rank', () => {
    const tied = [
      { playerId: 'x', name: 'X', thru: 9, toParGross: 0, toParNet: 0, stablefordTotal: 20 },
      { playerId: 'y', name: 'Y', thru: 9, toParGross: 0, toParNet: 0, stablefordTotal: 20 },
      { playerId: 'z', name: 'Z', thru: 9, toParGross: 1, toParNet: 1, stablefordTotal: 18 },
    ];
    const ranked = Golf.rankPlayers(tied, 'gross');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(1);
    expect(ranked[2].rank).toBe(3);
  });
});

describe('computeSkins', () => {
  it('awards the pot to the lowest net score, carrying ties to the next hole', () => {
    const pars = [4, 4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 5, 3: 3 }, pars, null, 3);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 5, 2: 5, 3: 4 }, pars, null, 3);

    const { skinsByPlayer, log, carry } = Golf.computeSkins([a, b], 3);

    // Hole 1: Alice wins (1). Hole 2: tied, skin carries. Hole 3: Alice
    // wins the carried pot (1 + 1 = 2), ending with 3 total.
    expect(skinsByPlayer.a).toBe(3);
    expect(skinsByPlayer.b).toBe(0);
    expect(log[1].winnerId).toBeNull(); // hole 2 tied, pot carried
    expect(log[2].value).toBe(2);       // hole 3 paid out the carried pot
    expect(carry).toBe(0);
  });
  it('marks a hole pending when not everyone has entered a score yet', () => {
    const pars = [4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 5 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4 }, pars, null, 2);

    const { skinsByPlayer, log } = Golf.computeSkins([a, b], 2);

    expect(log[0].pending).toBe(false); // hole 1: both in, tied
    expect(log[1].pending).toBe(true);  // hole 2: still waiting on Bob
    expect(skinsByPlayer.a).toBe(0);
    expect(skinsByPlayer.b).toBe(0);
  });

  it('accumulates a multi-hole carry and pays the full pot to the next winner', () => {
    const pars = [4, 4, 4, 4];
    // Holes 1 and 2 tie; hole 3 Alice wins outright and takes 1+1+1 = 3.
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4, 3: 3, 4: 5 }, pars, null, 4);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);

    const { skinsByPlayer, log, carry } = Golf.computeSkins([a, b], 4);

    expect(log[2].value).toBe(3);    // hole 3 pays the two carried skins plus its own
    expect(skinsByPlayer.a).toBe(3); // hole 4 goes to Bob
    expect(skinsByPlayer.b).toBe(1);
    expect(carry).toBe(0);
  });

  it('reports skins left in the pot when the final hole is tied', () => {
    const pars = [4, 4];
    // Both holes tie, so the pot ends unclaimed.
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);

    const { skinsByPlayer, carry } = Golf.computeSkins([a, b], 2);

    expect(skinsByPlayer.a).toBe(0);
    expect(skinsByPlayer.b).toBe(0);
    expect(carry).toBe(2); // both holes rolled forward with no winner
  });
});

describe('computeMatchPlay', () => {
  it('declares the match decided early once it is out of reach', () => {
    const pars = [4, 4, 4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 3, 2: 3, 3: 3 }, pars, null, 4);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 5, 2: 5, 3: 5 }, pars, null, 4);

    const result = Golf.computeMatchPlay(a, b, 4);

    expect(result.decided).toBe(true);
    expect(result.winner).toBe('A');
    expect(result.thru).toBe(3);
    expect(result.margin).toBe(3);
    expect(result.remaining).toBe(1); // "3 and 1" in golf terms
  });

  it('reports an undecided, all-square match when every hole is halved', () => {
    const pars = [4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 2);

    const result = Golf.computeMatchPlay(a, b, 2);

    expect(result.decided).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.diff).toBe(0);
  });
});

describe('computeMatchPlay — teams and best ball', () => {
  const pars = [4, 4, 4, 4];

  it('uses best-ball net score per hole for a 2v2 match', () => {
    const alice = Golf.summarizePlayer({ id: 'alice', name: 'Alice', handicap: 0 }, { 1: 3, 2: 3, 3: 5, 4: 5 }, pars, null, 4);
    const andy = Golf.summarizePlayer({ id: 'andy', name: 'Andy', handicap: 0 }, { 1: 5, 2: 5, 3: 3, 4: 3 }, pars, null, 4);
    const beth = Golf.summarizePlayer({ id: 'beth', name: 'Beth', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);
    const bob = Golf.summarizePlayer({ id: 'bob', name: 'Bob', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);

    // Team A's best ball is a 3 every hole (someone always beats par);
    // Team B is always 4. Team A should win comfortably.
    const result = Golf.computeMatchPlay([alice, andy], [beth, bob], 4);

    expect(result.thru).toBe(3);
    expect(result.decided).toBe(true);
    expect(result.winner).toBe('A');
    expect(result.margin).toBe(3);
    expect(result.remaining).toBe(1); // "3 and 1"
  });

  it('supports a 1v2 match (one player against a two-player team)', () => {
    const carl = Golf.summarizePlayer({ id: 'carl', name: 'Carl', handicap: 0 }, { 1: 4, 2: 4, 3: 4, 4: 4 }, pars, null, 4);
    const dana = Golf.summarizePlayer({ id: 'dana', name: 'Dana', handicap: 0 }, { 1: 5, 2: 5, 3: 5, 4: 5 }, pars, null, 4);
    const eli = Golf.summarizePlayer({ id: 'eli', name: 'Eli', handicap: 0 }, { 1: 5, 2: 3, 3: 5, 4: 5 }, pars, null, 4);

    const result = Golf.computeMatchPlay([carl], [dana, eli], 4);

    expect(result.thru).toBe(4);
    expect(result.diff).toBe(2); // Carl wins holes 1,3,4; the team wins hole 2 via Eli's birdie
    expect(result.winner).toBe('A');
  });

  it('compares gross instead of net when useHandicap is false', () => {
    const big = Golf.summarizePlayer({ id: 'big', name: 'Big', handicap: 10 }, { 1: 6 }, [4], [1], 1);
    const small = Golf.summarizePlayer({ id: 'small', name: 'Small', handicap: 0 }, { 1: 5 }, [4], [1], 1);

    const netResult = Golf.computeMatchPlay([big], [small], 1, true);
    expect(netResult.log[0].result).toBe('A'); // Big's handicap strokes bring his net to 4, beating Small's net of 5

    const grossResult = Golf.computeMatchPlay([big], [small], 1, false);
    expect(grossResult.log[0].result).toBe('B'); // On raw strokes, Small's 5 beats Big's 6
  });
});

// Nassau's three sub-competitions are scored over hole windows.
describe('computeMatchPlayRange / computeStrokeRange', () => {
  const pars = Array(18).fill(4);
  // A wins the front (holes 1-2), B wins the back (holes 10-11), rest halved.
  const aScores = { 1: 3, 2: 3, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4 };
  const bScores = { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 3, 11: 3, 12: 4, 13: 4, 14: 4, 15: 4, 16: 4, 17: 4, 18: 4 };
  const A = Golf.summarizePlayer({ id: 'a', name: 'A', handicap: 0 }, aScores, pars, null, 18);
  const B = Golf.summarizePlayer({ id: 'b', name: 'B', handicap: 0 }, bScores, pars, null, 18);

  it('scores the front nine, back nine, and full 18 as separate matches', () => {
    const front = Golf.computeMatchPlayRange([A], [B], 1, 9);
    expect(front.winner).toBe('A');
    expect(front.margin).toBe(2);
    expect(front.thru).toBe(9);

    const back = Golf.computeMatchPlayRange([A], [B], 10, 18);
    expect(back.winner).toBe('B');
    expect(back.margin).toBe(2);

    const total = Golf.computeMatchPlayRange([A], [B], 1, 18);
    expect(total.winner).toBe(null); // 2 up front, 2 down back → all square
    expect(total.diff).toBe(0);
    expect(total.thru).toBe(18);
  });

  it('reports "remaining" relative to the segment (early-decided within a nine)', () => {
    const runaway = Golf.summarizePlayer({ id: 'c', name: 'C', handicap: 0 }, { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 }, pars, null, 18);
    const seg = Golf.computeMatchPlayRange([runaway], [B], 1, 9);
    expect(seg.decided).toBe(true);
    expect(seg.margin).toBe(5);
    expect(seg.remaining).toBe(4); // "5 and 4" within the front nine
    expect(seg.thru).toBe(5);
  });

  it('computeMatchPlay is the full-round window', () => {
    const viaRange = Golf.computeMatchPlayRange([A], [B], 1, 18);
    const viaFull = Golf.computeMatchPlay([A], [B], 18);
    expect(viaFull).toEqual(viaRange);
  });

  it('sums best-ball stroke totals per window, lower total leading', () => {
    const front = Golf.computeStrokeRange([A], [B], 1, 9);
    expect(front.teamATotal).toBe(34); // 3+3+4*7
    expect(front.teamBTotal).toBe(36);
    expect(front.leader).toBe('A');
    expect(front.diff).toBe(2);

    const back = Golf.computeStrokeRange([A], [B], 10, 18);
    expect(back.leader).toBe('B');
    expect(back.diff).toBe(2);

    const total = Golf.computeStrokeRange([A], [B], 1, 18);
    expect(total.teamATotal).toBe(70);
    expect(total.teamBTotal).toBe(70);
    expect(total.leader).toBe(null);
  });

  it('stops at the first hole a side has not completed', () => {
    const partial = Golf.summarizePlayer({ id: 'd', name: 'D', handicap: 0 }, { 1: 4, 2: 4 }, pars, null, 18);
    const seg = Golf.computeStrokeRange([A], [partial], 1, 9);
    expect(seg.thru).toBe(2);
    const backSeg = Golf.computeMatchPlayRange([A], [partial], 10, 18);
    expect(backSeg.thru).toBe(0); // nobody has a back-nine score
  });
});

describe('sixesSegments', () => {
  it('rotates all four partnerships across three 6-hole windows', () => {
    const segs = Golf.sixesSegments();
    expect(segs.map(s => [s.from, s.to])).toEqual([[1, 6], [7, 12], [13, 18]]);
    expect(segs.map(s => [s.teamX, s.teamY])).toEqual([
      [[0, 1], [2, 3]],
      [[0, 2], [1, 3]],
      [[0, 3], [1, 2]],
    ]);
    // Every player (seat) partners each of the other three exactly once.
    const partners = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set() };
    segs.forEach(({ teamX, teamY }) => {
      [teamX, teamY].forEach(([a, b]) => { partners[a].add(b); partners[b].add(a); });
    });
    expect(partners[0]).toEqual(new Set([1, 2, 3]));
    expect(partners[1]).toEqual(new Set([0, 2, 3]));
    expect(partners[2]).toEqual(new Set([0, 1, 3]));
    expect(partners[3]).toEqual(new Set([0, 1, 2]));
  });
});

describe('matchRunning', () => {
  it('accumulates the running differential after each hole', () => {
    const log = [
      { hole: 1, result: 'A' },
      { hole: 2, result: 'A' },
      { hole: 3, result: 'halved' },
      { hole: 4, result: 'B' },
    ];
    expect(Golf.matchRunning(log)).toEqual([
      { hole: 1, cum: 1 }, // A 1up
      { hole: 2, cum: 2 }, // A 2up
      { hole: 3, cum: 2 }, // halved — no change
      { hole: 4, cum: 1 }, // A back to 1up
    ]);
  });

  it('goes negative when Team B is ahead and returns to square', () => {
    const log = [
      { hole: 1, result: 'B' },
      { hole: 2, result: 'B' },
      { hole: 3, result: 'A' },
      { hole: 4, result: 'A' },
    ];
    expect(Golf.matchRunning(log).map(e => e.cum)).toEqual([-1, -2, -1, 0]);
  });

  it('returns an empty array for an empty or missing log', () => {
    expect(Golf.matchRunning([])).toEqual([]);
    expect(Golf.matchRunning(undefined)).toEqual([]);
  });
});

describe('formatToPar', () => {
  it('formats even, over, and under par correctly', () => {
    expect(Golf.formatToPar(0)).toBe('E');
    expect(Golf.formatToPar(3)).toBe('+3');
    expect(Golf.formatToPar(-2)).toBe('-2');
  });
});

describe('findMissingScores', () => {
  it('returns an empty array when everyone has a score for every hole', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4, 3: 4 } },
    ];
    expect(Golf.findMissingScores(players, 3)).toEqual([]);
  });

  it('lists the specific holes a player is missing', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5 } }, // missing holes 2 and 3
    ];
    const missing = Golf.findMissingScores(players, 3);
    expect(missing).toEqual([{ name: 'Bob', missingHoles: [2, 3] }]);
  });

  it('reports every incomplete player, not just the first one found', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4 } },        // missing hole 2
      { name: 'Bob', scores: { 1: 5 } },          // missing hole 2
      { name: 'Cara', scores: { 1: 4, 2: 4 } },   // complete
    ];
    const missing = Golf.findMissingScores(players, 2);
    expect(missing.map(m => m.name)).toEqual(['Alice', 'Bob']);
  });

  it('treats a player with no scores object at all as fully missing', () => {
    const players = [{ name: 'NewGuy' }];
    const missing = Golf.findMissingScores(players, 2);
    expect(missing).toEqual([{ name: 'NewGuy', missingHoles: [1, 2] }]);
  });
});

describe('groupThru', () => {
  it('returns the highest hole every player has completed', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4, 3: 4 } },
    ];
    expect(Golf.groupThru(players, 18)).toBe(3);
  });

  it('is limited by the player who has completed the fewest holes', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 2: 4 } }, // only thru 2
    ];
    expect(Golf.groupThru(players, 18)).toBe(2);
  });

  it('stops at the first hole not everyone has, even if a later hole is filled', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4, 2: 5, 3: 3 } },
      { name: 'Bob', scores: { 1: 5, 3: 4 } }, // missing hole 2
    ];
    expect(Golf.groupThru(players, 18)).toBe(1);
  });

  it('returns 0 when nobody has completed hole 1 for everyone', () => {
    const players = [
      { name: 'Alice', scores: { 1: 4 } },
      { name: 'Bob', scores: {} },
    ];
    expect(Golf.groupThru(players, 18)).toBe(0);
  });

  it('returns 0 for an empty player list', () => {
    expect(Golf.groupThru([], 18)).toBe(0);
  });
});

describe('computeMoney', () => {
  const pars = [4, 4, 4];
  const player = (id, scores, handicap = 0) =>
    Golf.summarizePlayer({ id, name: id, handicap }, scores, pars, null, 3);

  it('gross ante pot: winner takes all, everyone else is down their ante', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byMode, byPlayer } = Golf.computeMoney([a, b], {
      modes: ['gross'], stakes: { gross: 5 }, holeCount: 3,
    });
    expect(byMode.gross.a).toBe(5);
    expect(byMode.gross.b).toBe(-5);
    expect(byPlayer.a + byPlayer.b).toBe(0);
  });

  it('splits the pot among tied winners', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 4, 2: 4, 3: 4 });
    const c = player('c', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer } = Golf.computeMoney([a, b, c], {
      modes: ['gross'], stakes: { gross: 10 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(5);  // pot 30 / 2 winners = 15, minus 10 ante
    expect(byPlayer.b).toBe(5);
    expect(byPlayer.c).toBe(-10);
  });

  it('skins: every other player pays the winner per skin, zero-sum', () => {
    const a = player('a', { 1: 4, 2: 5, 3: 3 }); // wins hole 1, then the carried pot on 3
    const b = player('b', { 1: 5, 2: 5, 3: 4 });
    const { byPlayer } = Golf.computeMoney([a, b], {
      modes: ['skins'], stakes: { skins: 2 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(6);  // 3 skins × $2 from Bob
    expect(byPlayer.b).toBe(-6);
  });

  it('match play: losing side pays the team pot', () => {
    const a = player('a', { 1: 3, 2: 3, 3: 3 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer } = Golf.computeMoney([a, b], {
      modes: ['match'], stakes: { match: 20 }, holeCount: 3,
      matchTeamA: ['a'], matchTeamB: ['b'],
    });
    expect(byPlayer.a).toBe(20);
    expect(byPlayer.b).toBe(-20);
  });

  it('sums multiple bets and returns a balanced settle-up', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byPlayer, transactions } = Golf.computeMoney([a, b], {
      modes: ['gross', 'skins'], stakes: { gross: 5, skins: 2 }, holeCount: 3,
    });
    expect(byPlayer.a).toBe(11); // +5 gross, +6 skins
    expect(byPlayer.b).toBe(-11);
    expect(transactions).toEqual([{ from: 'b', to: 'a', amount: 11 }]);
  });

  it('moves no money for a mode with no stake set', () => {
    const a = player('a', { 1: 4, 2: 4, 3: 4 });
    const b = player('b', { 1: 5, 2: 5, 3: 5 });
    const { byMode, byPlayer } = Golf.computeMoney([a, b], {
      modes: ['gross'], stakes: {}, holeCount: 3,
    });
    expect(byMode.gross).toBeUndefined();
    expect(byPlayer.a).toBe(0);
    expect(byPlayer.b).toBe(0);
  });
});
