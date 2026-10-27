// サーバー結合テスト: 実際にサーバーを起動し、2人で部屋を作って1局指し切る。
// 途中で1人が切断→再接続し、席が戻ることも確かめる。
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), TURN_MS: '3000', AUTO_MS: '20' }, stdio: ['ignore', 'pipe', 'inherit'],
});
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const c = { name, msgs: [], state: null, room: null, token: null, record: null };
  c.open = () => new Promise((res, rej) => {
    c.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    c.ws.on('open', res); c.ws.on('error', rej);
    c.ws.on('message', d => {
      const m = JSON.parse(d); c.msgs.push(m);
      if (m.type === 'welcome') c.token = m.token;
      if (m.type === 'room') c.room = m;
      if (m.type === 'state') c.state = m;
      if (m.type === 'record') c.record = m.game;
    });
  });
  c.send = m => c.ws.send(JSON.stringify(m));
  return c;
}
async function until(fn, ms = 5000, what = '') {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) fail('timeout: ' + what); await wait(20); }
}

(async () => {
  await new Promise(r => srv.stdout.once('data', r));
  const a = client('A'), b = client('B');
  await a.open(); await b.open();
  a.send({ type: 'create', nick: 'たろう', rules: { ai: 'normal' } });
  await until(() => a.room, 3000, 'room');
  b.send({ type: 'join', code: a.room.code, nick: '<b>じろう</b>' });
  await until(() => b.room && a.room.members.length === 2, 3000, 'join');
  if (b.room.members.some(m => /[<>]/.test(m.nick))) fail('nick not sanitized');
  b.send({ type: 'start' });                       // ホストではないので無視されるはず
  await wait(200);
  if (a.state) fail('non-host could start');
  a.send({ type: 'start' });
  await until(() => a.state && b.state, 3000, 'start');
  if (a.state.you !== 0 || b.state.you !== 1) fail('seat assignment');

  let reconnected = false, turns = 0;
  while (!(a.state && a.state.over)) {
    for (const c of [a, b]) {
      const s = c.state; if (!s || s.over) continue;
      const me = s.p[s.you];
      if (!me || !me[5] || s.sub.includes(s.you)) continue;
      c.send({ type: 'move', g: s.g, t: s.t, a: ['w'] });
    }
    // 他人の提出内容が漏れていないか
    for (const m of [...a.msgs, ...b.msgs]) if (m.type === 'state' && (m.acts || m.moves)) fail('moves leaked');
    if (!reconnected && a.state.t === 4) {
      b.ws.close(); await until(() => a.state.log.some(e => /切断/.test(e.m)), 3000, 'disconnect log');
      const b2 = client('B2'); await b2.open(); b2.send({ type: 'hello', token: b.token });
      await until(() => b2.state, 3000, 'reconnect');
      if (b2.state.you !== 1) fail('seat not restored');
      Object.assign(b, { ws: b2.ws, msgs: b2.msgs }); b2.ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') b.state = m; if (m.type === 'record') b.record = m.game; });
      reconnected = true;
    }
    const t0 = a.state.t;
    await until(() => a.state.t !== t0 || a.state.over, 6000, 'turn advance');
    if (++turns > 80) fail('game too long');
  }
  await until(() => a.record && b.record, 3000, 'record');
  if (!Array.isArray(a.record.frames) || a.record.frames.length < 2) fail('record frames');
  console.log(`server OK: ${a.state.t - 1}手で終局 / 再接続 ${reconnected ? 'OK' : '未実施'} / 記録 ${a.record.frames.length}フレーム`);
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack || e));
