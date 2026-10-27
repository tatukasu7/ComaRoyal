// 駒ロワ 対戦サーバー
// - public/ の静的ファイルを配信
// - /ws でWebSocket。部屋の管理と対局の進行はすべてサーバーが持つ(手は他の参加者に見えない)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadEngine } = require('./engine-loader');

const PORT = +process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TURN_MS = +process.env.TURN_MS || 45000;      // 1手の制限時間
const AUTO_MS = +process.env.AUTO_MS || 700;        // 人間が誰も指していない時の自動進行間隔
const ROOM_IDLE_MS = 10 * 60 * 1000;                // 全員いなくなった部屋を消すまで
const MAX_MSG_BYTES = 4096;
const SEATS = 8;

const E = loadEngine();
const rooms = new Map();      // code -> room
const tokens = new Map();     // token -> {room, memberId}

// ---------- 小物 ----------
const clean = (t, n = 12) => String(t ?? '').replace(/[<>&"'`\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const newId = () => crypto.randomBytes(6).toString('base64url');
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const RULE_KEYS = ['pawn', 'pass', 'final', 'promo', 'throne'];
function cleanRules(r) {
  const out = {};
  for (const k of RULE_KEYS) out[k] = r && r[k] !== undefined ? !!r[k] : true;
  out.ai = r && ['easy', 'normal', 'hard'].includes(r.ai) ? r.ai : 'normal';
  return out;
}
function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- 部屋 ----------
function createRoom(rules) {
  const room = {
    code: newCode(), members: new Map(), order: [], hostId: null,
    phase: 'lobby', rules: cleanRules(rules), state: null,
    acts: {}, seats: Array(SEATS).fill(null), deadline: 0, timer: null, autoTimer: null, idleSince: 0,
  };
  rooms.set(room.code, room);
  return room;
}
const connectedMembers = room => [...room.members.values()].filter(m => m.ws);
function ensureHost(room) {
  const h = room.members.get(room.hostId);
  if (h && h.ws) return;
  const next = room.order.map(id => room.members.get(id)).find(m => m && m.ws);
  if (next) room.hostId = next.id;
}
function roomView(room, m) {
  return {
    type: 'room', code: room.code, you: m.id, hostId: room.hostId, phase: room.phase, rules: room.rules,
    members: room.order.map(id => room.members.get(id)).filter(Boolean)
      .map(x => ({ id: x.id, nick: x.nick, connected: !!x.ws, seat: room.seats.indexOf(x.id) })),
  };
}
function broadcastRoom(room) {
  for (const m of room.members.values()) send(m.ws, roomView(room, m));
}

// 対局の状態を、各参加者ごとに(自分の席だけ付けて)送る。他人の提出内容は送らない
function stateView(room) {
  E.use(room.state);
  const S = room.state, fr = E.snap(), prev = S.rec.frames[S.rec.frames.length - 2];
  return {
    type: 'state', g: S.g, t: S.turn, lvl: S.lvl, holes: S.holes, nh: S.nextHole, p: fr.p, l: fr.l,
    rules: S.rules, nm: S.players.map(p => p.name), human: room.seats.map(Boolean),
    sub: Object.keys(room.acts).map(Number), dl: Math.max(0, room.deadline - Date.now()),
    over: !!S.over, pa: (prev && prev.a) || null, log: S.log.slice(-60),
  };
}
function broadcastState(room) {
  if (!room.state) return;
  const base = stateView(room);
  for (const m of room.members.values()) send(m.ws, { ...base, you: room.seats.indexOf(m.id) });
}
function buildRecord(room) {
  E.use(room.state);
  const S = room.state, w = E.alive()[0];
  return {
    v: 1, id: S.rec.id, date: new Date().toISOString(), rules: { ...S.rules }, online: true,
    names: S.players.map(p => p.name), humans: room.seats.map(Boolean),
    winner: w ? w.id : null, frames: S.rec.frames, log: S.log,
  };
}

function startGame(room, rules) {
  clearTimeout(room.timer); clearTimeout(room.autoTimer);
  if (rules) room.rules = cleanRules(rules);
  const present = room.order.map(id => room.members.get(id)).filter(m => m && m.ws).slice(0, SEATS);
  room.seats = Array(SEATS).fill(null);
  present.forEach((m, i) => { room.seats[i] = m.id; });
  const humans = room.seats.map(id => (id ? { name: room.members.get(id).nick } : null));
  E.newGame(humans, room.rules);
  room.state = E.state();
  room.state.online = true;
  room.state.log.push({ t: 0, m: `オンライン対戦。人間${present.length}人・CPU${SEATS - present.length}体` });
  room.phase = 'play';
  room.acts = {};
  armTurn(room);
  broadcastRoom(room);
  broadcastState(room);
}
function armTurn(room) {
  clearTimeout(room.timer); clearTimeout(room.autoTimer);
  if (room.phase !== 'play') return;
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => resolveTurn(room), TURN_MS + 50);
  maybeResolve(room);
}
function waitingSeats(room) {
  const S = room.state;
  return S.players.filter(p => p.alive && !p.cpu).map(p => p.id);
}
function maybeResolve(room) {
  if (room.phase !== 'play') return;
  const need = waitingSeats(room);
  if (!need.length) { clearTimeout(room.autoTimer); room.autoTimer = setTimeout(() => resolveTurn(room), AUTO_MS); return; }
  if (need.every(i => room.acts[i])) resolveTurn(room);
}
function resolveTurn(room) {
  if (room.phase !== 'play') return;
  clearTimeout(room.timer); clearTimeout(room.autoTimer);
  const acts = room.acts; room.acts = {};
  E.use(room.state);
  E.step(acts);
  if (room.state.over) {
    room.phase = 'over';
    broadcastState(room);
    broadcastRoom(room);
    const rec = buildRecord(room);
    for (const m of room.members.values()) send(m.ws, { type: 'record', game: rec, you: room.seats.indexOf(m.id) });
    return;
  }
  broadcastState(room);
  armTurn(room);
}
// 席の持ち主がいるかどうかで、CPU代打ちを切り替える
function syncSeatControl(room) {
  if (!room.state || room.phase !== 'play') return;
  const S = room.state;
  room.seats.forEach((id, i) => {
    if (!id) return;
    const m = room.members.get(id), p = S.players[i];
    const shouldCpu = !m || !m.ws;
    if (p.cpu !== shouldCpu) {
      p.cpu = shouldCpu;
      S.log.push({ t: S.turn, m: shouldCpu ? `${p.name}が切断。CPUが代わりに指す` : `${p.name}が戻ってきた` });
      if (shouldCpu) delete room.acts[i];
    }
  });
}

function joinRoom(ws, room, nick, existing) {
  let m = existing;
  if (!m) {
    if (room.members.size >= 16) return send(ws, { type: 'error', msg: 'この部屋は満員です。' });
    m = { id: newId(), token: newId() + newId(), nick, ws: null };
    room.members.set(m.id, m);
    room.order.push(m.id);
    tokens.set(m.token, { code: room.code, memberId: m.id });
  }
  if (m.ws && m.ws !== ws) { send(m.ws, { type: 'kicked', msg: '別の画面から同じ席に入りました。' }); m.ws.close(); }
  m.ws = ws;
  if (nick) m.nick = nick;
  ws.member = { room: room.code, id: m.id };
  room.idleSince = 0;
  if (!room.hostId) room.hostId = m.id;
  ensureHost(room);
  send(ws, { type: 'welcome', token: m.token, code: room.code });
  syncSeatControl(room);
  broadcastRoom(room);
  if (room.state) broadcastState(room);
  if (room.phase === 'over' && room.state) send(ws, { type: 'record', game: buildRecord(room), you: room.seats.indexOf(m.id) });
}
function leaveRoom(ws, permanent) {
  const ref = ws.member; if (!ref) return;
  ws.member = null;
  const room = rooms.get(ref.room); if (!room) return;
  const m = room.members.get(ref.id); if (!m) return;
  if (m.ws === ws) m.ws = null;
  if (permanent) {
    if (room.seats.indexOf(m.id) < 0 || room.phase !== 'play') {
      room.members.delete(m.id); room.order = room.order.filter(x => x !== m.id); tokens.delete(m.token);
    }
  }
  ensureHost(room);
  syncSeatControl(room);
  if (!connectedMembers(room).length) room.idleSince = Date.now();
  broadcastRoom(room);
  if (room.state) { broadcastState(room); maybeResolve(room); }
}

// ---------- メッセージ処理 ----------
function handle(ws, msg) {
  const ref = ws.member, room = ref && rooms.get(ref.room), me = room && room.members.get(ref.id);
  const isHost = room && room.hostId === ref.id;
  switch (msg.type) {
    case 'hello': {   // 再接続
      const tk = tokens.get(String(msg.token || ''));
      const r = tk && rooms.get(tk.code), m = r && r.members.get(tk.memberId);
      if (m) joinRoom(ws, r, null, m); else send(ws, { type: 'noroom' });
      return;
    }
    case 'create': {
      if (room) leaveRoom(ws, true);
      const r = createRoom(msg.rules);
      joinRoom(ws, r, clean(msg.nick) || 'プレイヤー');
      return;
    }
    case 'join': {
      const code = String(msg.code || '').toLowerCase();
      const r = rooms.get(code);
      if (!r) return send(ws, { type: 'error', msg: 'その部屋コードは見つかりません。' });
      if (room) leaveRoom(ws, true);
      joinRoom(ws, r, clean(msg.nick) || 'プレイヤー');
      return;
    }
  }
  if (!room || !me) return send(ws, { type: 'error', msg: '部屋に入っていません。' });
  switch (msg.type) {
    case 'leave': leaveRoom(ws, true); send(ws, { type: 'left' }); return;
    case 'nick': me.nick = clean(msg.nick) || me.nick; broadcastRoom(room); return;
    case 'rules': if (isHost && room.phase !== 'play') { room.rules = cleanRules(msg.rules); broadcastRoom(room); } return;
    case 'start': if (isHost && room.phase !== 'play') startGame(room, msg.rules); return;
    case 'move': {
      if (room.phase !== 'play') return;
      const S = room.state, seat = room.seats.indexOf(me.id);
      if (seat < 0 || msg.g !== S.g || msg.t !== S.turn) return;
      const p = S.players[seat];
      if (!p.alive || p.cpu) return;
      E.use(S);
      const a = E.unpackAct(msg.a);
      if (!a) return;
      room.acts[seat] = a;          // 合法性はstep内のlegalActで確認される
      broadcastState(room);
      maybeResolve(room);
      return;
    }
    case 'promo': {
      if (room.phase !== 'play') return;
      const S = room.state, seat = room.seats.indexOf(me.id);
      if (seat < 0 || msg.g !== S.g) return;
      const p = S.players[seat];
      if (p.alive && p.canPromo && !p.promoted) { E.use(S); E.promote(p); broadcastState(room); }
      return;
    }
  }
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`ok rooms=${rooms.size}`); }
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p.startsWith('/r/')) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
wss.on('connection', ws => {
  ws.member = null;
  let bucket = 20, last = Date.now();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    const now = Date.now();
    bucket = Math.min(20, bucket + (now - last) / 100); last = now;   // 10件/秒まで
    if (bucket < 1) return;
    bucket--;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('handle error', e); }
  });
  ws.on('close', () => leaveRoom(ws, false));
});

// 死活確認と空き部屋の掃除
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.idleSince && now - room.idleSince > ROOM_IDLE_MS) {
      clearTimeout(room.timer); clearTimeout(room.autoTimer);
      for (const m of room.members.values()) tokens.delete(m.token);
      rooms.delete(code);
    }
  }
}, 30000);

server.listen(PORT, () => console.log(`駒ロワ server listening on :${PORT}`));
