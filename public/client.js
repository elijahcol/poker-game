const BACKEND = (window.BACKEND_URL || '').trim();
const socket = BACKEND ? io(BACKEND, { transports: ['websocket', 'polling'] }) : io();
let myName = '';
let currentTableId = null;
let lastState = null;

const $ = id => document.getElementById(id);
const screens = { name: $('screen-name'), lobby: $('screen-lobby'), game: $('screen-game') };
function show(which) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[which].classList.remove('hidden');
}

function suitSymbol(s) { return { h: '♥', d: '♦', c: '♣', s: '♠' }[s] || s; }
function cardHTML(c) {
  if (!c || c === '??') return `<div class="cardback">🂠</div>`;
  const r = c[0], s = c[1];
  const red = (s === 'h' || s === 'd') ? 'red' : '';
  return `<div class="pcard ${red}"><span>${r}</span><span>${suitSymbol(s)}</span></div>`;
}

// --- name ---
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return alert('Type your name first');
  socket.emit('setName', name, res => {
    if (!res.ok) return alert(res.error);
    myName = res.name;
    $('myName').textContent = myName;
    show('lobby');
    socket.emit('getLobby');
  });
};
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

// --- lobby ---
socket.on('lobbyUpdate', data => {
  $('onlineCount').textContent = data.online.length;
  $('onlineList').innerHTML = data.online.map(u => `<li>${escapeHtml(u.name)}${u.name === myName ? ' (you)' : ''}</li>`).join('') || '<li><i>Nobody else online yet</i></li>';
  $('tableList').innerHTML = data.tables.map(t =>
    `<li><strong>${escapeHtml(t.name)}</strong> <span class="code">${t.id}</span> — ${t.count}/${t.max} · ${t.state} · host ${escapeHtml(t.host)}
     <button onclick="joinTable('${t.id}')">Join</button></li>`
  ).join('') || '<li><i>No tables yet — create one!</i></li>';
});

$('createBtn').onclick = () => {
  socket.emit('createTable', $('tableNameInput').value.trim(), res => {
    if (!res.ok) return alert(res.error);
    enterTable(res.tableId);
  });
};
$('joinCodeBtn').onclick = () => joinTable($('joinCodeInput').value.trim().toUpperCase());
window.joinTable = (id) => {
  if (!id) return;
  socket.emit('joinTable', id, res => {
    if (!res.ok) return alert(res.error);
    enterTable(res.tableId);
  });
};

function enterTable(id) {
  currentTableId = id;
  show('game');
}

$('leaveBtn').onclick = () => {
  socket.emit('leaveTable');
  currentTableId = null;
  show('lobby');
  socket.emit('getLobby');
};
$('startBtn').onclick = () => {
  socket.emit('startGame', currentTableId, res => { if (res && !res.ok) alert(res.error); });
};

// --- game state ---
socket.on('tableUpdate', state => {
  lastState = state;
  currentTableId = state.id;
  $('gameTitle').textContent = state.name;
  $('gameCode').textContent = 'CODE: ' + state.id + ' — invite up to 3 friends with this code';
  $('gameMsg').textContent = state.message || '';
  $('streetLabel').textContent = state.street || 'waiting';
  $('potVal').textContent = state.pot;
  $('community').innerHTML = state.community.length
    ? state.community.map(cardHTML).join('')
    : '<i>— no cards yet —</i>';

  $('winnersBox').innerHTML = state.winnersInfo
    ? `<div class="winners">🏆 ${escapeHtml(state.winnersInfo.text)}</div>` : '';

  const me = state.players.find(p => p.isMe);
  $('seats').innerHTML = state.players.map(p => `
    <div class="seat ${p.isTurn ? 'turn' : ''} ${p.isMe ? 'me' : ''} ${p.folded ? 'folded' : ''}">
      <div class="seat-name">${p.isDealer ? '🎲 ' : ''}${escapeHtml(p.name)} ${p.isMe ? '(you)' : ''}</div>
      <div class="seat-cards">${(p.cards || []).map(cardHTML).join('')}</div>
      <div>Chips: <strong>${p.chips}</strong> · Bet: ${p.bet} ${p.allIn ? '· ALL-IN' : ''} ${p.folded ? '· FOLDED' : ''}</div>
      ${p.handName ? `<div class="handname">${escapeHtml(p.handName)}</div>` : ''}
      ${p.isTurn ? '<div class="turnbadge">👉 acting…</div>' : ''}
    </div>`).join('');

  // enable/disable actions
  const myTurn = me && state.turnSocketId && me.socketId === state.turnSocketId;
  document.querySelectorAll('#actions button').forEach(b => b.disabled = !myTurn);
  $('raiseAmt').disabled = !myTurn;
  if (me) {
    const minTo = state.currentBet + 20;
    $('raiseAmt').placeholder = `raise to (min ${Math.max(minTo, 40)})`;
  }
});

document.querySelectorAll('#actions button').forEach(b => {
  b.onclick = () => {
    if (!currentTableId) return;
    const act = b.dataset.act;
    socket.emit('playerAction', { tableId: currentTableId, type: act, amount: Number($('raiseAmt').value) });
  };
});

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
