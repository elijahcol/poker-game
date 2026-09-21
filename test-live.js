// Full multiplayer integration test (run: node test-live.js)
const { io } = require('socket.io-client');
const PORT = 3456;
const { server } = require('./server.js');

const results = [];
function check(cond, label) {
  results.push([cond ? 'ok' : 'FAIL', label]);
  if (!cond) console.log('FAIL -', label); else console.log('ok   -', label);
}
function connect(name) {
  return new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${PORT}`);
    const st = { socket: s, name, table: null };
    s.on('tableUpdate', (t) => { st.table = t; });
    s.on('connect', () => s.emit('setName', name, () => resolve(st)));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(250); }
  return false;
}
function autopilot(st) {
  // small delay per action so the test can observe each street
  let busy = false;
  st.socket.on('tableUpdate', (t) => {
    if (busy || st.paused || t.state !== 'playing' || !t.turnSocketId) return;
    const me = t.players.find(p => p.isMe);
    if (me && t.turnSocketId === me.socketId && !me.folded && !me.allIn && !me.sittingOut) {
      busy = true;
      setTimeout(() => {
        st.socket.emit('playerAction', { tableId: t.id, type: 'call' });
        busy = false;
      }, 120);
    }
  });
}

(async () => {
  await new Promise(res => server.listen(PORT, res));
  const names = ['Alice', 'Bob', 'Cara', 'Dan', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy'];
  const players = [];
  for (const n of names) players.push(await connect(n));
  players.forEach(autopilot);
  const [A, B, C, D] = players;

  // create with blinds preset object
  const created = await new Promise(res => A.socket.emit('createTable', { name: 'Velvet Test', sb: 25, bb: 50 }, res));
  check(created.ok && created.tableId, 'table created with blinds preset');
  const tid = created.tableId;
  check(A.table && A.table.blinds.sb === 25 && A.table.blinds.bb === 50, 'blinds 25/50 applied');

  for (const p of players.slice(1)) {
    const r = await new Promise(res => p.socket.emit('joinTable', tid, res));
    check(r.ok, `${p.name} joined (9-max)`);
  }
  // 10th rejected
  const Z = await connect('Zed');
  const r10 = await new Promise(res => Z.socket.emit('joinTable', tid, res));
  check(!r10.ok && /full/i.test(r10.error), '10th player rejected (9 max)');

  // non-host start rejected
  const rNH = await new Promise(res => B.socket.emit('startGame', tid, res));
  check(!rNH.ok, 'non-host start rejected');

  A.socket.emit('startGame', tid, () => {});
  check(await waitFor(() => A.table && A.table.state === 'playing', 5000), 'hand started');
  check(await waitFor(() => A.table && A.table.community.length === 0 && A.table.street === 'preflop', 5000), 'preflop, no community');
  const meA = A.table.players.find(p => p.isMe);
  check(meA.cards.length === 2 && !meA.cards.includes('??'), 'own cards visible');
  check(A.table.players.filter(p => !p.isMe).every(p => p.cards.every(c => c === '??')), 'opponent cards hidden');
  check(typeof A.table.minRaise === 'number' && typeof A.table.toCall === 'number', 'minRaise + toCall sent');
  check(typeof A.table.turnDeadline === 'number', 'turn deadline sent');

  const START_TOTAL = 9 * 1000;
  const consBefore = A.table.players.reduce((s, p) => s + p.chips, 0) + A.table.pot;
  check(consBefore === START_TOTAL, `9000 chips in play (got ${consBefore})`);

  check(await waitFor(() => A.table.state === 'showdown', 60000, 'showdown'), 'full 9-player hand reached showdown');
  check(A.table.community.length === 5, 'river dealt');
  check(A.table.winnersInfo && A.table.winnersInfo.winners.length > 0, 'winners declared');
  const paid = A.table.winnersInfo.winners.reduce((s, w) => s + w.amount, 0);
  check(paid === A.table.pot, `all pot paid (${paid}/${A.table.pot})`);
  check((A.table.history || []).length > 3, 'hand history recorded');
  const consAfter = A.table.players.reduce((s, p) => s + p.chips, 0);
  check(consAfter === START_TOTAL, `chips conserved (${consAfter})`);
  check(B.table.winnersInfo.text === A.table.winnersInfo.text, 'all clients agree');

  // chat round-trip
  A.socket.emit('chat', { tableId: tid, text: 'gl all' });
  check(await waitFor(() => B.table.chat && B.table.chat.some(m => m.text === 'gl all'), 5000), 'chat delivered');

  // auto next hand
  check(await waitFor(() => A.table.state === 'playing', 15000), 'auto-dealt next hand');

  // out-of-turn ignored: freeze all autopilots (game stalls mid-street), fire an
  // off-turn all-in, verify turn doesn't move and that player's chips don't move
  players.forEach(p => { p.paused = true; });
  await sleep(400);
  const turnId = A.table.turnSocketId;
  const offTurn = players.find(p => p.socket.id !== turnId);
  const snap = () => { const p = A.table.players.find(x => x.name === offTurn.name); return p.chips + '/' + p.bet + '/' + p.allIn; };
  const chipsBeforeOT = snap();
  offTurn.socket.emit('playerAction', { tableId: tid, type: 'allin' });
  await sleep(500);
  const okOT = A.table.turnSocketId === turnId && snap() === chipsBeforeOT;
  players.forEach(p => { p.paused = false; });
  check(okOT, 'out-of-turn action ignored safely');

  // fresh table: mid-hand joiner gets dealt in next hand
  const t2 = await new Promise(res => A.socket.emit('createTable', { name: 'Q', sb: 10, bb: 20 }, res));
  const tid2 = t2.tableId;
  const rB2 = await new Promise(res => B.socket.emit('joinTable', tid2, res));
  check(rB2.ok, 'B joined fresh table');
  A.socket.emit('startGame', tid2, () => {});
  check(await waitFor(() => A.table && A.table.id === tid2 && A.table.state === 'playing', 5000), 'fresh table started');
  const G2 = await connect('Gus2');
  const rG = await new Promise(res => G2.socket.emit('joinTable', tid2, res));
  if (!(rG.ok && rG.sittingOut)) console.log('  [debug] G2 join response:', JSON.stringify(rG));
  check(rG.ok && rG.sittingOut, 'fresh table: mid-hand join queued');
  check(await waitFor(() => A.table.state === 'showdown', 60000), 'fresh table showdown');
  check(await waitFor(() => A.table.state === 'playing', 15000), 'next hand playing');
  const gusMe = G2.table && G2.table.players.find(p => p.isMe);
  check(gusMe && !gusMe.sittingOut && gusMe.cards.length === 2 && gusMe.cards[0] !== '??', 'joiner dealt in next hand');

  // disconnect mid-hand: leaver's bets stay in the pot (dead money), hand completes
  const t3 = await new Promise(res => A.socket.emit('createTable', { name: 'DC', sb: 10, bb: 20 }, res));
  const tid3 = t3.tableId;
  await new Promise(res => B.socket.emit('joinTable', tid3, res));
  const C3 = await connect('Cara3');
  await new Promise(res => C3.socket.emit('joinTable', tid3, res));
  A.socket.emit('startGame', tid3, () => {});
  await waitFor(() => A.table && A.table.id === tid3 && A.table.state === 'playing', 5000);
  const cara = A.table.players.find(p => p.name === 'Cara3');
  const caraChips = cara.chips; // unbets chips leave with her; her bets stay as dead money
  const potBeforeDC = A.table.pot;
  C3.socket.disconnect(); // leaves mid-hand
  await sleep(800);
  const remain = A.table.players.reduce((s, p) => s + p.chips, 0) + A.table.pot;
  check(A.table.pot >= potBeforeDC, `leaver bets stay in pot (was ${potBeforeDC}, now ${A.table.pot})`);
  check(remain === 3000 - caraChips, `no chips created/destroyed (${remain} = 3000 - ${caraChips})`);
  check(await waitFor(() => A.table.state === 'showdown', 60000), 'short-handed hand completes to showdown');

  const fails = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\nLIVE TESTS: ${results.length - fails} passed, ${fails} failed`);
  [...players, Z, G2, C3].forEach(p => { try { p.socket.disconnect(); } catch (e) {} });
  server.close(() => process.exit(fails ? 1 : 0));
  setTimeout(() => process.exit(fails ? 1 : 0), 2000);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(2); });
