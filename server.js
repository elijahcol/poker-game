const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_PLAYERS = 9;
const TURN_MS = 60000;
const BLIND_PRESETS = [{ sb: 10, bb: 20 }, { sb: 25, bb: 50 }, { sb: 50, bb: 100 }];

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ---------- Card helpers ----------
const SUITS = ['h', 'd', 'c', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VAL = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

function createDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function rankOf(c) { return c[0]; }
function suitOf(c) { return c[1]; }

// Evaluate a 5-card hand -> {score:[...], name}
function eval5(cards) {
  const vals = cards.map(c => RANK_VAL[rankOf(c)]).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const flush = suits.every(s => s === suits[0]);
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts).map(([v, c]) => ({ v: +v, c })).sort((a, b) => b.c - a.c || b.v - a.v);

  let straightHigh = 0;
  const uniq = [...new Set(vals)].sort((a, b) => b - a);
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (JSON.stringify(uniq) === JSON.stringify([14, 5, 4, 3, 2])) straightHigh = 5; // wheel
  }

  if (flush && straightHigh) return { score: [8, straightHigh], name: straightHigh === 14 ? 'Royal Flush' : 'Straight Flush' };
  if (groups[0].c === 4) return { score: [7, groups[0].v, groups[1].v], name: 'Four of a Kind' };
  if (groups[0].c === 3 && groups[1].c === 2) return { score: [6, groups[0].v, groups[1].v], name: 'Full House' };
  if (flush) return { score: [5, ...vals], name: 'Flush' };
  if (straightHigh) return { score: [4, straightHigh], name: 'Straight' };
  if (groups[0].c === 3) return { score: [3, groups[0].v, ...groups.slice(1).map(g => g.v).sort((a, b) => b - a)], name: 'Three of a Kind' };
  if (groups[0].c === 2 && groups[1].c === 2) {
    const pairs = [groups[0].v, groups[1].v].sort((a, b) => b - a);
    return { score: [2, ...pairs, groups[2].v], name: 'Two Pair' };
  }
  if (groups[0].c === 2) return { score: [1, groups[0].v, ...groups.slice(1).map(g => g.v).sort((a, b) => b - a)], name: 'Pair' };
  return { score: [0, ...vals], name: 'High Card' };
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function evaluate7(cards7) {
  let best = null;
  const n = cards7.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++)
    for (let l = k + 1; l < n; l++) for (let m = l + 1; m < n; m++) {
      const hand = [cards7[i], cards7[j], cards7[k], cards7[l], cards7[m]];
      const e = eval5(hand);
      if (!best || compareScore(e.score, best.score) > 0) best = e;
    }
  return best;
}

// Fair side-pot builder based on total contributed this hand.
// players: [{name, handTotal, folded, seatIndex}]
function buildSidePots(contribs) {
  // contribs: array of {idx, amount, folded, eligible}
  const levels = [...new Set(contribs.filter(c => c.amount > 0).map(c => c.amount))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    let potAmt = 0;
    const eligible = [];
    for (const c of contribs) {
      if (c.amount >= lvl) {
        potAmt += (lvl - prev);
        if (!c.folded) eligible.push(c.idx);
      }
    }
    if (potAmt > 0) pots.push({ amount: potAmt, eligible, level: lvl });
    prev = lvl;
  }
  return pots;
}

// ---------- Game state ----------
const users = new Map();  // socketId -> { name }
const tables = new Map(); // tableId -> table

function makeTableId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function lobbyData() {
  return {
    online: [...users.entries()].map(([id, u]) => ({ id, name: u.name })),
    tables: [...tables.values()].map(t => ({
      id: t.id, name: t.name, count: t.players.length,
      max: MAX_PLAYERS, state: t.state, host: t.players[0] ? t.players[0].name : '',
      sb: t.smallBlind, bb: t.bigBlind
    }))
  };
}
function broadcastLobby() { io.emit('lobbyUpdate', lobbyData()); }

function tableView(table, forSocketId) {
  const me = table.players.find(p => p.socketId === forSocketId);
  return {
    id: table.id, name: table.name, state: table.state,
    community: table.community, street: table.street,
    pot: totalPot(table), sidePots: table.showdownPots || [],
    currentBet: table.currentBet, minRaise: table.minRaise,
    blinds: { sb: table.smallBlind, bb: table.bigBlind },
    toCall: me ? Math.max(0, table.currentBet - me.bet) : 0,
    turnSocketId: table.turnSocketId, turnDeadline: table.turnDeadline || null,
    dealerSocketId: table.players[table.dealerIdx] ? table.players[table.dealerIdx].socketId : null,
    winnersInfo: table.winnersInfo || null,
    message: table.message || '',
    history: (table.history || []).slice(-30),
    chat: (table.chat || []).slice(-50),
    maxPlayers: MAX_PLAYERS,
    players: table.players.map((p, i) => ({
      socketId: p.socketId, name: p.name, chips: p.chips, bet: p.bet,
      folded: p.folded, allIn: p.allIn, acted: p.acted, sittingOut: !!p.sittingOut,
      isTurn: p.socketId === table.turnSocketId,
      isDealer: i === table.dealerIdx,
      isMe: p.socketId === forSocketId,
      cards: p.socketId === forSocketId ? p.cards : (table.state === 'showdown' && !p.folded ? p.cards : (p.cards.length ? ['??', '??'] : [])),
      handName: (table.state === 'showdown' && !p.folded && p.handName) ? p.handName : null
    }))
  };
}
function emitTable(table) {
  // append new messages to hand history
  if (table.message && table.message !== table._lastMsg) {
    table.history = table.history || [];
    table.history.push(table.message);
    if (table.history.length > 100) table.history = table.history.slice(-100);
    table._lastMsg = table.message;
  }
  for (const p of table.players) {
    io.to(p.socketId).emit('tableUpdate', tableView(table, p.socketId));
  }
  // also spectators in room
  const room = io.sockets.adapter.rooms.get(table.id);
  if (room) for (const sid of room) {
    if (!table.players.find(p => p.socketId === sid)) {
      io.to(sid).emit('tableUpdate', tableView(table, sid));
    }
  }
}
function totalPot(table) {
  return table.players.reduce((s, p) => s + p.handTotal, 0) + (table.deadMoney || 0);
}

function nextActiveIndex(table, fromIdx) {
  const n = table.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIdx + step) % n;
    const p = table.players[i];
    if (!p.folded && !p.allIn) return i;
  }
  return -1;
}
function countActive(table) { return table.players.filter(p => !p.folded && !p.allIn).length; }
function countUnfolded(table) { return table.players.filter(p => !p.folded).length; }

function startHand(table) {
  const SB = table.smallBlind || SMALL_BLIND;
  const BB = table.bigBlind || BIG_BLIND;
  // rebuy broke players; seat waiting players
  for (const p of table.players) {
    if (p.chips < BB) { p.chips = START_CHIPS; p.rebought = true; }
    p.cards = []; p.bet = 0; p.handTotal = 0; p.folded = false; p.allIn = false; p.acted = false; p.handName = null; p.sittingOut = false;
  }
  table.deadMoney = 0;
  const seated = table.players.filter(p => !p.sittingOut);
  if (seated.length < 2) { table.message = 'Need at least 2 players to start.'; emitTable(table); return; }

  table.state = 'playing';
  table.deck = createDeck();
  table.community = [];
  table.street = 'preflop';
  table.currentBet = BB;
  table.minRaise = BB;
  table.winnersInfo = null;
  table.showdownPots = [];

  // rotate dealer (first hand: 0)
  if (table.handCount == null) table.handCount = 0; else { table.dealerIdx = (table.dealerIdx + 1) % table.players.length; }
  table.handCount++;

  const n = table.players.length;
  const dealer = table.dealerIdx;
  let sbIdx, bbIdx;
  if (n === 2) { sbIdx = dealer; bbIdx = (dealer + 1) % n; }
  else { sbIdx = (dealer + 1) % n; bbIdx = (dealer + 2) % n; }

  const post = (idx, amt) => {
    const p = table.players[idx];
    const pay = Math.min(p.chips, amt);
    p.chips -= pay; p.bet += pay; p.handTotal += pay;
    if (p.chips === 0) p.allIn = true;
  };
  post(sbIdx, SB);
  post(bbIdx, BB);

  // deal
  for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) table.players[i].cards.push(table.deck.pop());

  // action starts after BB, except everyone all-in edge
  table.players.forEach(p => p.acted = false);
  // blinds count as acted? BB can check if no raise: mark SB acted=false, BB acted=false but BB already matched currentBet. Standard: UTG acts first. Mark blinds as not acted except if all-in.
  const bb = table.players[bbIdx];
  if (bb.bet === table.currentBet && !bb.allIn) bb.acted = false;

  table.turnIdx = nextActiveIndex(table, bbIdx);
  table.turnSocketId = table.turnIdx >= 0 ? table.players[table.turnIdx].socketId : null;
  table.message = `Hand #${table.handCount} — ${table.players[sbIdx].name} posts SB ${SB}, ${table.players[bbIdx].name} posts BB ${BB}`;

  if (table.turnIdx === -1) return finishBettingRound(table); // everyone all-in from blinds (rare)
  emitTable(table);
  startTurnTimer(table);
}

let timers = new Map();
function clearTimer(tableId) { if (timers.has(tableId)) { clearTimeout(timers.get(tableId)); timers.delete(tableId); } }
function startTurnTimer(table) {
  clearTimer(table.id);
  table.turnDeadline = Date.now() + TURN_MS;
  // auto-fold/check safety
  const t = setTimeout(() => {
    const idx = table.turnIdx;
    if (idx < 0 || table.state !== 'playing') return;
    const p = table.players[idx];
    if (!p || p.folded || p.allIn) return;
    if (p.bet < table.currentBet) doFold(table, idx, true);
    else doCheck(table, idx, true);
  }, TURN_MS);
  timers.set(table.id, t);
}

function bettingRoundComplete(table) {
  const active = table.players.filter(p => !p.folded && !p.allIn);
  if (active.length === 0) return true;
  return active.every(p => p.acted && p.bet === table.currentBet);
}

function advanceAfterAction(table) {
  if (countUnfolded(table) === 1) return awardToLastStanding(table);
  if (bettingRoundComplete(table)) return finishBettingRound(table);
  table.turnIdx = nextActiveIndex(table, table.turnIdx);
  table.turnSocketId = table.players[table.turnIdx].socketId;
  emitTable(table);
  startTurnTimer(table);
}

function moveBetsToPotStreet(table) {
  // bets stay in handTotal for side-pot math; just reset per-street bet
  table.players.forEach(p => { p.bet = 0; p.acted = false; });
  table.currentBet = 0;
  table.minRaise = table.bigBlind || BIG_BLIND;
  table.turnSocketId = null;
  table.turnDeadline = null;
}

function finishBettingRound(table) {
  clearTimer(table.id);
  if (countUnfolded(table) === 1) return awardToLastStanding(table);

  // if everyone all-in (or only 1 active left) deal out board then showdown
  const activeCount = countActive(table);
  moveBetsToPotStreet(table);

  if (activeCount <= 1) {
    // fast-forward board
    while (table.community.length < 5) table.community.push(table.deck.pop());
    return doShowdown(table);
  }

  if (table.street === 'preflop') {
    table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
    table.street = 'flop';
  } else if (table.street === 'flop') {
    table.community.push(table.deck.pop());
    table.street = 'turn';
  } else if (table.street === 'turn') {
    table.community.push(table.deck.pop());
    table.street = 'river';
  } else if (table.street === 'river') {
    return doShowdown(table);
  }

  // first to act = first active after dealer
  table.turnIdx = nextActiveIndex(table, table.dealerIdx);
  table.turnSocketId = table.players[table.turnIdx].socketId;
  table.message = `Dealt ${table.street}. Pot: ${totalPot(table)}`;
  emitTable(table);
  startTurnTimer(table);
}

function awardToLastStanding(table) {
  clearTimer(table.id);
  table.turnDeadline = null;
  const winner = table.players.find(p => !p.folded);
  const pot = totalPot(table);
  winner.chips += pot;
  table.deadMoney = 0;
  table.state = 'showdown';
  table.turnSocketId = null;
  table.winnersInfo = { text: `${winner.name} wins ${pot} (everyone else folded)`, winners: [{ name: winner.name, amount: pot, hand: '—' }] };
  table.message = table.winnersInfo.text;
  emitTable(table);
  scheduleNextHand(table);
}

function doShowdown(table) {
  clearTimer(table.id);
  table.turnDeadline = null;
  table.state = 'showdown';
  table.turnSocketId = null;

  const contribs = table.players.map((p, idx) => ({ idx, amount: p.handTotal, folded: p.folded }));
  const pots = buildSidePots(contribs);
  // orphaned chips from players who left mid-hand go to the main pot
  if (table.deadMoney > 0 && pots.length > 0) pots[0].amount += table.deadMoney;
  table.deadMoney = 0;

  // evaluate unfolded players
  const evals = new Map();
  for (let i = 0; i < table.players.length; i++) {
    const p = table.players[i];
    if (p.folded) continue;
    const best = evaluate7([...p.cards, ...table.community]);
    evals.set(i, best);
    p.handName = best.name;
  }

  const winners = [];
  let detailParts = [];
  table.showdownPots = pots;
  for (let pi = 0; pi < pots.length; pi++) {
    const pot = pots[pi];
    if (pot.eligible.length === 0) continue;
    let bestScore = null;
    let potWinners = [];
    for (const idx of pot.eligible) {
      const e = evals.get(idx);
      if (!e) continue;
      if (!bestScore || compareScore(e.score, bestScore) > 0) { bestScore = e.score; potWinners = [idx]; }
      else if (compareScore(e.score, bestScore) === 0) potWinners.push(idx);
    }
    // fair split: floor divide, remainder chips go one-by-one starting left of dealer
    const share = Math.floor(pot.amount / potWinners.length);
    let rem = pot.amount % potWinners.length;
    // order winners by seat distance from dealer for remainder fairness
    const ordered = [...potWinners].sort((a, b) => {
      const da = (a - table.dealerIdx + table.players.length) % table.players.length;
      const db = (b - table.dealerIdx + table.players.length) % table.players.length;
      return da - db;
    });
    for (const idx of ordered) {
      let amt = share + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
      table.players[idx].chips += amt;
      const e = evals.get(idx);
      winners.push({ name: table.players[idx].name, amount: amt, hand: e.name });
    }
    const label = pots.length > 1 ? `Side pot ${pi + 1} (${pot.amount})` : `Pot (${pot.amount})`;
    detailParts.push(`${label}: ${ordered.map(i => table.players[i].name + ' [' + evals.get(i).name + ']').join(' & ')}`);
  }

  const total = pots.reduce((s, p) => s + p.amount, 0);
  table.winnersInfo = { text: `Showdown — Pot ${total}. ` + detailParts.join(' | '), winners, pots };
  table.message = table.winnersInfo.text;
  emitTable(table);
  scheduleNextHand(table);
}

function scheduleNextHand(table) {
  setTimeout(() => {
    // remove broke/spectating? keep all, rebuy handled in startHand
    if (table.players.length >= 2 && [...tables.values()].includes(table)) {
      // only auto-continue if at least 2 players still at table
      startHand(table);
    } else {
      table.state = 'waiting';
      emitTable(table);
    }
  }, 9000);
}

// ---------- Player actions ----------
function doFold(table, idx, auto = false) {
  table.players[idx].folded = true;
  table.players[idx].acted = true;
  table.message = `${table.players[idx].name} folds${auto ? ' (timeout)' : ''}`;
  advanceAfterAction(table);
}
function doCheck(table, idx, auto = false) {
  const p = table.players[idx];
  if (p.bet < table.currentBet) return; // can't check
  p.acted = true;
  table.message = `${p.name} checks${auto ? ' (timeout)' : ''}`;
  advanceAfterAction(table);
}
function doCall(table, idx) {
  const p = table.players[idx];
  const need = Math.min(table.currentBet - p.bet, p.chips);
  p.chips -= need; p.bet += need; p.handTotal += need;
  if (p.chips === 0) p.allIn = true;
  p.acted = true;
  table.message = `${p.name} calls ${need}`;
  advanceAfterAction(table);
}
function doRaise(table, idx, amount) {
  const p = table.players[idx];
  // amount = total bet this street to raise TO
  const toBet = Math.max(amount, table.currentBet + table.minRaise);
  const need = Math.min(toBet - p.bet, p.chips);
  const newBet = p.bet + need;
  if (newBet <= table.currentBet) return doCall(table, idx); // not a real raise
  p.chips -= need; p.bet = newBet; p.handTotal += need;
  if (p.chips === 0) p.allIn = true;
  const raiseSize = newBet - table.currentBet;
  if (raiseSize >= table.minRaise) table.minRaise = raiseSize;
  table.currentBet = newBet;
  // other active players must act again
  table.players.forEach((q, i) => { if (i !== idx && !q.folded && !q.allIn) q.acted = false; });
  p.acted = true;
  table.message = `${p.name} raises to ${newBet}`;
  advanceAfterAction(table);
}
function doAllIn(table, idx) {
  const p = table.players[idx];
  const need = p.chips;
  p.bet += need; p.handTotal += need; p.chips = 0; p.allIn = true; p.acted = true;
  if (p.bet > table.currentBet) {
    const raiseSize = p.bet - table.currentBet;
    if (raiseSize >= table.minRaise) {
      table.minRaise = raiseSize;
      table.players.forEach((q, i) => { if (i !== idx && !q.folded && !q.allIn) q.acted = false; });
    }
    table.currentBet = Math.max(table.currentBet, p.bet);
  }
  table.message = `${p.name} is ALL-IN (${p.bet})`;
  advanceAfterAction(table);
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.on('setName', (name, cb) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return cb && cb({ ok: false, error: 'Enter a name' });
    users.set(socket.id, { name });
    cb && cb({ ok: true, name });
    broadcastLobby();
  });

  socket.on('createTable', (opts, cb) => {
    const user = users.get(socket.id);
    if (!user) return cb && cb({ ok: false, error: 'Set your name first' });
    leaveAllTables(socket);
    // accept string name (legacy) or { name, sb, bb }
    let tableName = `${user.name}'s game`, sb = SMALL_BLIND, bb = BIG_BLIND;
    if (typeof opts === 'string') tableName = opts || tableName;
    else if (opts && typeof opts === 'object') {
      tableName = String(opts.name || tableName).slice(0, 30);
      const preset = BLIND_PRESETS.find(p => p.sb === +opts.sb && p.bb === +opts.bb);
      if (preset) { sb = preset.sb; bb = preset.bb; }
    }
    const id = makeTableId();
    const table = {
      id, name: tableName || 'Poker Table', smallBlind: sb, bigBlind: bb,
      players: [{ socketId: socket.id, name: user.name, chips: START_CHIPS, bet: 0, handTotal: 0, cards: [], folded: false, allIn: false, acted: false, sittingOut: false }],
      state: 'waiting', deck: [], community: [], currentBet: 0, minRaise: bb, deadMoney: 0,
      dealerIdx: 0, turnIdx: -1, turnSocketId: null, turnDeadline: null, street: '', handCount: 0,
      history: [], chat: [], message: `Welcome to ${tableName} — blinds ${sb}/${bb}. Waiting for players… (2–9 to start)`
    };
    tables.set(id, table);
    socket.join(id);
    cb && cb({ ok: true, tableId: id });
    emitTable(table);
    broadcastLobby();
  });

  socket.on('joinTable', (tableId, cb) => {
    const user = users.get(socket.id);
    if (!user) return cb && cb({ ok: false, error: 'Set your name first' });
    const table = tables.get(String(tableId || '').toUpperCase());
    if (!table) return cb && cb({ ok: false, error: 'Table not found' });
    if (table.players.find(p => p.socketId === socket.id)) { socket.join(table.id); return cb && cb({ ok: true, tableId: table.id }); }
    if (table.players.length >= MAX_PLAYERS) return cb && cb({ ok: false, error: `Table is full (${MAX_PLAYERS} max)` });
    leaveAllTables(socket);
    if (table.state === 'playing') {
      // join as waiting for next hand — dealt in automatically
      table.players.push({ socketId: socket.id, name: user.name, chips: START_CHIPS, bet: 0, handTotal: 0, cards: [], folded: true, allIn: false, acted: true, sittingOut: true });
      socket.join(table.id);
      table.message = `${user.name} joined — dealt in next hand. (${table.players.length}/${MAX_PLAYERS})`;
      cb && cb({ ok: true, tableId: table.id, sittingOut: true });
    } else {
      table.players.push({ socketId: socket.id, name: user.name, chips: START_CHIPS, bet: 0, handTotal: 0, cards: [], folded: false, allIn: false, acted: false, sittingOut: false });
      socket.join(table.id);
      table.message = `${user.name} joined. (${table.players.length}/${MAX_PLAYERS})`;
      cb && cb({ ok: true, tableId: table.id });
    }
    emitTable(table);
    broadcastLobby();
  });

  socket.on('chat', ({ tableId, text }) => {
    const user = users.get(socket.id);
    const table = tables.get(String(tableId || '').toUpperCase());
    if (!user || !table) return;
    if (!table.players.find(p => p.socketId === socket.id)) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    table.chat = table.chat || [];
    table.chat.push({ name: user.name, text, ts: Date.now() });
    if (table.chat.length > 50) table.chat = table.chat.slice(-50);
    emitTable(table);
  });

  socket.on('leaveTable', () => {
    leaveAllTables(socket);
    broadcastLobby();
  });

  socket.on('startGame', (tableId, cb) => {
    const table = tables.get(String(tableId || '').toUpperCase());
    if (!table) return cb && cb({ ok: false, error: 'Table not found' });
    if (!table.players.length || table.players[0].socketId !== socket.id) return cb && cb({ ok: false, error: 'Only host can start' });
    if (table.state === 'playing') return cb && cb({ ok: false, error: 'Hand already in progress' });
    if (table.players.length < 2) return cb && cb({ ok: false, error: 'Need at least 2 players' });
    cb && cb({ ok: true });
    startHand(table);
  });

  socket.on('playerAction', ({ tableId, type, amount }) => {
    const table = tables.get(String(tableId || '').toUpperCase());
    if (!table || table.state !== 'playing') return;
    const idx = table.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1 || table.players[idx].socketId !== table.turnSocketId) return;
    const p = table.players[idx];
    if (p.folded || p.allIn) return;
    clearTimer(table.id);
    try {
      if (type === 'fold') doFold(table, idx);
      else if (type === 'check') {
        if (p.bet < table.currentBet) doCall(table, idx); else doCheck(table, idx);
      }
      else if (type === 'call') doCall(table, idx);
      else if (type === 'raise') doRaise(table, idx, Number(amount) || 0);
      else if (type === 'allin') doAllIn(table, idx);
    } catch (e) { emitTable(table); startTurnTimer(table); }
  });

  socket.on('getLobby', () => socket.emit('lobbyUpdate', lobbyData()));

  socket.on('pingCheck', (cb) => { if (typeof cb === 'function') cb(Date.now()); });

  socket.on('disconnect', () => {
    users.delete(socket.id);
    // remove from tables; keep their bets in the pot (dead money)
    for (const [id, table] of tables) {
      const idx = table.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const wasTurn = table.turnSocketId === socket.id;
        const [gone] = table.players.splice(idx, 1);
        if (table.state === 'playing' && gone && gone.handTotal > 0) table.deadMoney = (table.deadMoney || 0) + gone.handTotal;
        if (table.players.length === 0) { tables.delete(id); clearTimer(id); continue; }
        if (table.dealerIdx >= table.players.length) table.dealerIdx = 0;
        if (table.state === 'playing') {
          if (countUnfolded(table) === 1) awardToLastStanding(table);
          else if (wasTurn) { table.turnIdx = (idx - 1 + table.players.length) % table.players.length; advanceAfterAction(table); }
          else emitTable(table);
        } else {
          table.message = `${gone ? gone.name : 'Player'} left.`;
          emitTable(table);
        }
      }
    }
    broadcastLobby();
  });
});

function removeFromTable(table, socket, silent) {
  const idx = table.players.findIndex(p => p.socketId === socket.id);
  if (idx === -1) return false;
  const wasTurn = table.turnSocketId === socket.id;
  socket.leave(table.id);
  const [gone] = table.players.splice(idx, 1);
  if (table.state === 'playing' && gone && gone.handTotal > 0) table.deadMoney = (table.deadMoney || 0) + gone.handTotal;
  if (table.players.length === 0) { tables.delete(table.id); clearTimer(table.id); return true; }
  if (table.dealerIdx >= table.players.length) table.dealerIdx = 0;
  if (!silent) {
    table.message = `${gone ? gone.name : 'Player'} left.`;
    if (table.state === 'playing') {
      if (countUnfolded(table) === 1) awardToLastStanding(table);
      else if (wasTurn && table.players.length) {
        table.turnIdx = (idx - 1 + table.players.length) % table.players.length;
        advanceAfterAction(table);
      }
      else emitTable(table);
    }
    else emitTable(table);
  }
  return true;
}

function leaveAllTables(socket) {
  for (const [id, table] of [...tables]) {
    removeFromTable(table, socket);
  }
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`Poker server running on port ${PORT}`));
}
module.exports = { app, server, eval5, evaluate7, compareScore, buildSidePots, createDeck };
