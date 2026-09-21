/* ROYALE POKER client */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const BACKEND = (window.BACKEND_URL || '').trim();

if (typeof io === 'undefined') {
  $('connText').textContent = 'backend waking… reload in 30s';
  $('toast').textContent = 'Game server is waking up (free hosting sleeps). Wait ~30s and reload.';
  $('toast').classList.remove('hidden');
  return;
}
const socket = BACKEND ? io(BACKEND, { transports: ['websocket', 'polling'] }) : io();

let myName = '', myId = null, currentTableId = null, lastState = null;
let lastPot = 0, lastChatCount = 0, prevMyTurn = false, audioCtx = null;
let activeTab = 'hist';
const screens = { name: $('screen-name'), lobby: $('screen-lobby'), game: $('screen-game') };

function show(w) { Object.values(screens).forEach(s => s.classList.add('hidden')); screens[w].classList.remove('hidden'); }
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500); }
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
  } catch (e) { /* silent */ }
}

/* ---------- connection ---------- */
socket.on('connect', () => {
  myId = socket.id;
  $('connPill').className = 'pill ok';
  // rejoin after drop
  if (myName) {
    socket.emit('setName', myName, () => {
      socket.emit('getLobby');
      if (currentTableId) socket.emit('joinTable', currentTableId, () => {});
    });
  }
});
socket.on('disconnect', () => { $('connPill').className = 'pill bad'; $('connText').textContent = 'reconnecting…'; });
setInterval(() => {
  if (!socket.connected) return;
  const t0 = performance.now();
  socket.emit('pingCheck', () => { $('connText').textContent = Math.round(performance.now() - t0) + 'ms'; });
}, 5000);

/* ---------- name gate ---------- */
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return toast('Type your alias first');
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  socket.emit('setName', name, res => {
    if (!res.ok) return toast(res.error);
    myName = res.name;
    $('myName').textContent = myName;
    $('avatar').textContent = myName[0].toUpperCase();
    $('avatar').classList.remove('hidden');
    $('balPill').classList.remove('hidden');
    show('lobby');
    socket.emit('getLobby');
  });
};
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

/* ---------- lobby ---------- */
let selSB = 10, selBB = 20;
$('blindsSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#blindsSeg button').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); selSB = +b.dataset.sb; selBB = +b.dataset.bb;
});
socket.on('lobbyUpdate', d => {
  $('onlineCount').textContent = d.online.length;
  $('onlineList').innerHTML = d.online.map(u =>
    `<span class="chip-av"><span class="avatar">${esc(u.name[0] || '?').toUpperCase()}</span>${esc(u.name)}${u.name === myName ? ' (you)' : ''}</span>`
  ).join('') || '<span class="muted">Nobody else here yet — invite friends!</span>';
  $('tableList').innerHTML = d.tables.map(t =>
    `<div class="table-card"><h4>${esc(t.name)}</h4>
     <div class="meta">Blinds ${t.sb}/${t.bb} · ${t.count}/${t.max} players · ${t.state} · host ${esc(t.host)}</div>
     <div class="row"><span class="code">${t.id}</span>
     <button class="btn-gold" onclick="joinTable('${t.id}')">Join Table</button></div></div>`
  ).join('') || '<p class="muted">No tables yet — open one above and share the code.</p>';
});
$('createBtn').onclick = () => {
  socket.emit('createTable', { name: $('tableNameInput').value.trim(), sb: selSB, bb: selBB }, res => {
    if (!res.ok) return toast(res.error);
    enterTable(res.tableId);
  });
};
$('joinCodeBtn').onclick = () => joinTable($('joinCodeInput').value.trim().toUpperCase());
window.joinTable = (id) => {
  if (!id) return;
  socket.emit('joinTable', id, res => {
    if (!res.ok) return toast(res.error);
    if (res.sittingOut) toast('Hand in progress — you’re dealt in next hand');
    enterTable(res.tableId);
  });
};
function enterTable(id) { currentTableId = id; lastPot = 0; lastChatCount = 0; prevMyTurn = false; show('game'); }
$('leaveBtn').onclick = () => { socket.emit('leaveTable'); currentTableId = null; show('lobby'); socket.emit('getLobby'); };
$('copyCodeBtn').onclick = () => {
  if (!currentTableId) return;
  const txt = `Join my poker table! Code: ${currentTableId}`;
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(
    () => toast('Invite copied — send it to friends'),
    () => toast('Table code: ' + currentTableId));
};
$('startBtn').onclick = () => socket.emit('startGame', currentTableId, res => { if (res && !res.ok) toast(res.error); });

/* ---------- seats (radial, hero at bottom) ---------- */
const SLOTS = [[50, 93], [13, 82], [4, 52], [12, 19], [33, 5], [67, 5], [88, 19], [96, 52], [87, 82]];
function suitSym(s) { return { h: '♥', d: '♦', c: '♣', s: '♠' }[s] || s; }
function cardHTML(c, small) {
  if (!c || c === '??') return `<div class="cardback${small ? ' small' : ''}"></div>`;
  const red = (c[1] === 'h' || c[1] === 'd') ? ' red' : '';
  return `<div class="pcard${red}${small ? ' small' : ''}"><span>${c[0]}</span><span>${suitSym(c[1])}</span></div>`;
}
function renderSeats(st) {
  const max = st.maxPlayers || 9;
  const meIdx = Math.max(0, st.players.findIndex(p => p.isMe));
  const order = st.players.map((_, i) => st.players[(meIdx + i) % st.players.length]);
  let html = '';
  for (let s = 0; s < Math.min(max, 9); s++) {
    const [x, y] = SLOTS[s];
    const p = order[s];
    if (!p) {
      html += `<div class="seat empty" style="left:${x}%;top:${y}%"><div class="plus">+</div><div class="muted small">Open seat<br>share the code</div></div>`;
      continue;
    }
    let tag = '';
    if (p.sittingOut) tag = '<span class="tag">dealt in next hand</span>';
    else if (p.folded) tag = '<span class="tag">folded</span>';
    else if (p.allIn) tag = '<span class="tag allin">all-in</span>';
    else if (p.isTurn) tag = '<span class="tag turn">acting…</span>';
    else if (st.state === 'showdown' && p.handName) tag = `<span class="tag">${esc(p.handName)}</span>`;
    html += `<div class="seat${p.isTurn ? ' turn' : ''}${p.isMe ? ' me' : ''}${p.folded ? ' folded' : ''}${p.sittingOut ? ' out' : ''}" style="left:${x}%;top:${y}%">
      ${p.isDealer ? '<div class="dealer-btn">D</div>' : ''}
      <div class="who"><span class="avatar">${esc((p.name[0] || '?')).toUpperCase()}</span><span class="nm">${esc(p.name)}${p.isMe ? ' (you)' : ''}</span></div>
      <div class="seat-cards">${(p.cards || []).map(c => cardHTML(c, true)).join('')}</div>
      <div class="stack">◉ ${fmt(p.chips)}</div>
      <div class="betline">bet ${fmt(p.bet)}</div>
      ${tag}
    </div>`;
  }
  $('seats').innerHTML = html;
}

/* ---------- table updates ---------- */
socket.on('tableUpdate', st => {
  lastState = st; currentTableId = st.id;
  $('gameTitle').textContent = st.name;
  $('gameBlinds').textContent = `Blinds ${st.blinds.sb}/${st.blinds.bb}`;
  $('gameCode').textContent = 'CODE ' + st.id;
  $('gameMsg').textContent = st.message || '';
  $('streetLabel').textContent = st.street || 'lobby';
  if (st.pot !== lastPot) { lastPot = st.pot; const pl = $('potLine'); pl.classList.remove('bump'); void pl.offsetWidth; pl.classList.add('bump'); }
  $('potVal').textContent = fmt(st.pot);
  $('community').innerHTML = st.community.length ? st.community.map(c => cardHTML(c, false)).join('') : '';
  $('winnersBox').innerHTML = st.winnersInfo ? `<div class="winners">🏆 ${esc(st.winnersInfo.text)}</div>` : '';
  renderSeats(st);

  const me = st.players.find(p => p.isMe);
  if (me) $('balVal').textContent = fmt(me.chips);
  const myTurn = !!(me && st.turnSocketId && me.socketId === st.turnSocketId && st.state === 'playing');
  if (myTurn && !prevMyTurn) beep();
  prevMyTurn = myTurn;
  $('turnLabel').textContent = st.state !== 'playing' ? (st.state === 'showdown' ? 'Hand over — next deals soon' : 'Waiting to start')
    : myTurn ? '⚡ Your move' : 'Waiting for ' + ((st.players.find(p => p.socketId === st.turnSocketId) || {}).name || '…');

  // host start button
  const isHost = st.players.length && st.players[0].isMe;
  $('startBtn').classList.toggle('hidden', !(isHost && st.state !== 'playing'));

  // HUD enablement
  const toCall = st.toCall || 0;
  const canAct = myTurn && me && !me.sittingOut;
  $('btnFold').disabled = !canAct;
  $('btnCheckCall').disabled = !canAct;
  $('btnCheckCall').textContent = toCall > 0 ? `CALL ${fmt(Math.min(toCall, me ? me.chips : 0))}` : 'CHECK';
  $('btnAllin').disabled = !canAct;
  // raise range: raise TO total this street
  const minTo = st.currentBet + st.minRaise;
  const maxTo = me ? me.bet + me.chips : 0;
  const slider = $('raiseSlider');
  const canRaise = canAct && me.chips > toCall && maxTo > minTo;
  slider.disabled = !canRaise; $('btnRaise').disabled = !canRaise;
  document.querySelectorAll('.quick button').forEach(b => b.disabled = !canRaise);
  if (canRaise) {
    slider.min = minTo; slider.max = maxTo; slider.step = 10;
    if (+slider.value < minTo || +slider.value > maxTo) slider.value = minTo;
    slider._minTo = minTo; slider._maxTo = maxTo; slider._pot = st.pot; slider._cb = st.currentBet;
    $('raiseVal').textContent = fmt(slider.value);
  }

  // history + chat
  const hb = $('historyBox');
  hb.innerHTML = (st.history || []).map(h => `<div class="hrow">${esc(h)}</div>`).join('') || '<div class="muted">No hands yet.</div>';
  hb.scrollTop = hb.scrollHeight;
  const cb = $('chatBox');
  const chats = st.chat || [];
  cb.innerHTML = chats.map(m => `<div class="crow"><span class="cn">${esc(m.name)}:</span> <span class="ct">${esc(m.text)}</span></div>`).join('') || '<div class="muted">Say gl hf.</div>';
  if (chats.length > lastChatCount && activeTab !== 'chat' && lastChatCount > 0) {
    const badge = $('chatBadge'); badge.textContent = chats.length - lastChatCount; badge.classList.remove('hidden');
  }
  if (activeTab === 'chat') cb.scrollTop = cb.scrollHeight;
  lastChatCount = chats.length;
});

// turn countdown
setInterval(() => {
  const el = $('timer');
  if (!lastState || !lastState.turnDeadline || lastState.state !== 'playing') { el.textContent = ''; return; }
  const s = Math.max(0, Math.ceil((lastState.turnDeadline - Date.now()) / 1000));
  el.textContent = '⏱ ' + s + 's';
  el.classList.toggle('low', s <= 10);
}, 250);

/* ---------- HUD actions ---------- */
function act(type, amount) {
  if (!currentTableId) return;
  socket.emit('playerAction', { tableId: currentTableId, type, amount });
}
$('btnFold').onclick = () => act('fold');
$('btnCheckCall').onclick = () => {
  const toCall = (lastState && lastState.toCall) || 0;
  act(toCall > 0 ? 'call' : 'check');
};
$('btnAllin').onclick = () => act('allin');
$('btnRaise').onclick = () => act('raise', Number($('raiseSlider').value));
$('raiseSlider').addEventListener('input', e => { $('raiseVal').textContent = fmt(e.target.value); });
document.querySelectorAll('.quick button').forEach(b => {
  b.onclick = () => {
    const s = $('raiseSlider');
    const minTo = s._minTo || 40, maxTo = s._maxTo || 40, pot = s._pot || 0, cb = s._cb || 0;
    let v = minTo;
    if (b.dataset.q === 'half') v = cb + Math.ceil(pot / 2);
    else if (b.dataset.q === 'pot') v = cb + pot;
    else if (b.dataset.q === 'max') v = maxTo;
    s.value = Math.min(maxTo, Math.max(minTo, v));
    $('raiseVal').textContent = fmt(s.value);
  };
});

/* ---------- side tabs + chat ---------- */
function setTab(t) {
  activeTab = t;
  $('tabHist').classList.toggle('on', t === 'hist');
  $('tabChat').classList.toggle('on', t === 'chat');
  $('historyBox').classList.toggle('hidden', t !== 'hist');
  $('chatBox').classList.toggle('hidden', t !== 'chat');
  if (t === 'chat') { $('chatBadge').classList.add('hidden'); const cb = $('chatBox'); cb.scrollTop = cb.scrollHeight; }
}
$('tabHist').onclick = () => setTab('hist');
$('tabChat').onclick = () => setTab('chat');
function sendChat() {
  const v = $('chatInput').value.trim();
  if (!v || !currentTableId) return;
  socket.emit('chat', { tableId: currentTableId, text: v });
  $('chatInput').value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

})();
