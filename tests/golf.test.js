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
  it('awards a skin to the lowest net score, pushing on ties', () => {
    const pars = [4, 4, 4];
    const a = Golf.summarizePlayer({ id: 'a', name: 'Alice', handicap: 0 }, { 1: 4, 2: 5, 3: 3 }, pars, null, 3);
    const b = Golf.summarizePlayer({ id: 'b', name: 'Bob', handicap: 0 }, { 1: 5, 2: 5, 3: 4 }, pars, null, 3);

    const { skinsByPlayer, log } = Golf.computeSkins([a, b], 3);

    expect(skinsByPlayer.a).toBe(2); // holes 1 and 3
    expect(skinsByPlayer.b).toBe(0);
    expect(log[1].winnerId).toBeNull(); // hole 2 tied, no winner
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
      { name: 'Alice', scores: { 1: 4 } },
      { name: 'Bob', scores: { 1: 5, 2: 4 } },
      { name: 'Cara', scores: { 1: 4, 2: 4 } },
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
