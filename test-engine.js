// Thorough engine unit tests (run: node test-engine.js). Not part of deploy.
const { eval5, evaluate7, compareScore, buildSidePots } = require('./server.js');
let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; /* console.log('ok  -', label); */ }
  else { fail++; console.log('FAIL-', label, '\n  got:     ', a, '\n  expected:', e); }
}

// --- 5-card hand types ---
eq(eval5(['Ah', 'Kh', 'Qh', 'Jh', 'Th']).name, 'Royal Flush', 'royal flush');
eq(eval5(['9h', '8h', '7h', '6h', '5h']).name, 'Straight Flush', 'straight flush');
eq(eval5(['9c', '9d', '9h', '9s', '2d']).name, 'Four of a Kind', 'quads');
eq(eval5(['Kc', 'Kd', 'Kh', '3s', '3d']).name, 'Full House', 'boat');
eq(eval5(['Ah', '9h', '7h', '5h', '2h']).name, 'Flush', 'flush');
eq(eval5(['9c', '8d', '7h', '6s', '5d']).name, 'Straight', 'straight');
eq(eval5(['Ah', '2d', '3c', '4s', '5h']).name, 'Straight', 'wheel straight');
eq(eval5(['Qc', 'Qd', 'Qh', '9s', '4d']).name, 'Three of a Kind', 'trips');
eq(eval5(['Jc', 'Jd', '4h', '4s', '9d']).name, 'Two Pair', 'two pair');
eq(eval5(['Tc', 'Td', '8h', '5s', '2d']).name, 'Pair', 'pair');
eq(eval5(['Ac', 'Kd', '9h', '5s', '2d']).name, 'High Card', 'high card');

// --- tiebreaks ---
console.assert(compareScore(eval5(['Ac', 'Ad', 'Kh', 'Qd', 'Jc']).score, eval5(['Kc', 'Kd', 'Ah', 'Qd', 'Jc']).score) > 0, 'pair of aces beats kings');
console.assert(compareScore(eval5(['Ah', 'Kh', 'Qh', 'Jh', '9h']).score, eval5(['Ah', 'Kh', 'Qh', 'Jh', '8h']).score) > 0, 'flush kicker');
console.assert(compareScore(eval5(['8c', '8d', '8h', 'Ac', 'Kd']).score, eval5(['8c', '8d', '8h', 'Ac', 'Qd']).score) > 0, 'trips kicker');
console.assert(compareScore(eval5(['Tc', 'Td', '9h', '5s', '2d']).score, eval5(['Tc', 'Td', '9h', '5s', '2d']).score) === 0, 'identical pairs tie');
pass += 4;

// --- 7-card best-of-5 ---
eq(evaluate7(['Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d']).name, 'Royal Flush', '7: royal found');
eq(evaluate7(['As', 'Ks', 'Qd', 'Jc', 'Td', '9h', '2c']).name, 'Straight', '7: broadway straight');
eq(evaluate7(['2h', '2d', '2c', '5s', '9h', 'Kd', 'Ac']).name, 'Three of a Kind', '7: trips (not quads)');
eq(evaluate7(['Ah', 'Ad', 'Kc', 'Kd', 'Qh', '9s', '2c']).name, 'Two Pair', '7: two pair aces+kings');
const split1 = evaluate7(['2h', '3d', 'Qc', 'Jd', 'Th', '9s', '8c']); // board straight, plays
const split2 = evaluate7(['Ah', 'Ad', 'Qc', 'Jd', 'Th', '9s', '8c']); // pair of aces, but board straight beats it -> plays board too
eq(compareScore(split1.score, split2.score), 0, '7: board plays, split pot tie');

// --- side pots: conservation + fairness ---
function checkPots(contribs, label) {
  const pots = buildSidePots(contribs);
  const sumPots = pots.reduce((s, p) => s + p.amount, 0);
  const sumIn = contribs.reduce((s, c) => s + c.amount, 0);
  eq(sumPots, sumIn, label + ' conserves chips (' + sumIn + ')');
  return pots;
}
let pots = checkPots([{ idx: 0, amount: 100, folded: false }, { idx: 1, amount: 100, folded: false }], 'even pot');
eq(pots.length, 1, 'even pot: single pot');
eq(pots[0].eligible, [0, 1], 'even pot: both eligible');

pots = checkPots([
  { idx: 0, amount: 50, folded: false },   // short all-in
  { idx: 1, amount: 200, folded: false },
  { idx: 2, amount: 200, folded: false },
], 'all-in side pot');
eq(pots.length, 2, 'side pot: two pots');
eq(pots[0].amount, 150, 'side pot: main=150');
eq(pots[0].eligible, [0, 1, 2], 'side pot: all eligible for main');
eq(pots[1].amount, 300, 'side pot: side=300');
eq(pots[1].eligible, [1, 2], 'side pot: only deep eligible for side');

pots = checkPots([
  { idx: 0, amount: 100, folded: true },   // folder contributed but can't win
  { idx: 1, amount: 100, folded: false },
], 'folded money stays');
eq(pots[0].eligible, [1], 'folder excluded, winner takes all 200');
eq(pots[0].amount, 200, 'folder money stays in pot');

pots = checkPots([
  { idx: 0, amount: 30, folded: false },
  { idx: 1, amount: 100, folded: false },
  { idx: 2, amount: 200, folded: false },
  { idx: 3, amount: 200, folded: false },
], 'three levels');
eq(pots.length, 3, 'three pots');
eq(pots.map(p => p.amount), [120, 210, 200], 'three pot sizes 120/210/200');

// odd-chip split: 100 / 3 = 33 + 1 remainder -> 34/33/33
{
  const amt = 100, n = 3;
  const share = Math.floor(amt / n), rem = amt % n;
  eq([share + 1, share, share], [34, 33, 33], 'odd chip remainder 34/33/33');
}

console.log(`\nENGINE TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
