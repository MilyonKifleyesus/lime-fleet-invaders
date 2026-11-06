// Relay checks. Run against `wrangler dev` with the test settings in .dev.vars
// (CODE_MS=8000, MIN_TURN_MS=0) or set RELAY and EVENT_KEY for a deployed relay.
import { BASE, WS_BASE, Client, createRoom, screen, joinPhone, sleep } from './client.mjs';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log('  pass  ' + name);
  } catch (e) {
    results.push([false, name, e.message]);
    console.log('  FAIL  ' + name + ' :: ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const open = [];
const track = c => (open.push(c), c);

console.log('Relay at ' + BASE);

await check('health answers', async () => {
  const r = await fetch(BASE + '/health');
  assert(r.ok, 'status ' + r.status);
});

await check('a room cannot be created without the event key', async () => {
  const r = await createRoom(16, 'wrong-key');
  assert(r.status === 401, 'status ' + r.status);
});

const made = await createRoom(2);
const { room, host } = made.body;
const scr = track(screen(room, host));
let roster;

await check('the event key creates a room with 2 seats', async () => {
  assert(made.status === 200 && /^[a-z0-9]{12}$/.test(room) && host.length === 32, JSON.stringify(made));
  assert(made.body.seats === 2, 'seats ' + made.body.seats);
});

await check('the big screen connects and gets a join code', async () => {
  roster = await scr.waitFor(m => m.t === 'roster');
  assert(/^[A-HJ-NP-Z2-9]{4}$/.test(roster.code), 'code ' + roster.code);
  assert(roster.players.length === 0, 'players');
});

await check('a wrong host key is refused', async () => {
  const bad = track(screen(room, 'x'.repeat(32)));
  const m = await bad.waitFor(x => x.t === 'err');
  assert(m.why === 'key', m.why);
});

await check('a wrong join code is refused', async () => {
  const c = track(new Client(`${WS_BASE}/join?code=ZZZZ`));
  const m = await c.waitFor(x => x.t === 'err');
  assert(m.why === 'code', m.why);
});

let a, b, c3;
await check('first phone gets a colour, a suggested name and seat 1', async () => {
  a = await joinPhone(roster.code, 'PRIYA');
  track(a.c);
  assert(!a.err, JSON.stringify(a.err));
  assert(a.hi.name.startsWith(a.hi.color.toUpperCase() + ' '), 'suggested ' + a.hi.name);
  assert(a.w.seat === 0 && a.w.line === 0 && a.w.token.length === 24, JSON.stringify(a.w));
  const p = await scr.waitFor(m => m.t === 'p' && m.join);
  assert(p.p.name === 'PRIYA' && p.p.seat === 0, JSON.stringify(p));
});

await check('offensive names are refused, including disguised ones', async () => {
  for (const n of ['FUCK', 'f.u.c.k', 'SH1T', 'ass', 'Mer de', 'n​igger', 'FUUUCK']) {
    const r = await joinPhone(roster.code, n);
    track(r.c);
    assert(r.err && r.err.why === 'name', n + ' was allowed');
  }
});

await check('ordinary names pass, and a duplicate gets a number', async () => {
  b = await joinPhone(roster.code, 'PRIYA');
  track(b.c);
  assert(!b.err, JSON.stringify(b.err));
  assert(b.w.name === 'PRIYA 2', b.w.name);
  assert(b.w.seat === 1, 'seat ' + b.w.seat);
});

await check('when seats are full, the next phone waits in line', async () => {
  c3 = await joinPhone(roster.code, 'Émilie');
  track(c3.c);
  assert(!c3.err, JSON.stringify(c3.err));
  assert(c3.w.seat === null && c3.w.line === 1, JSON.stringify(c3.w));
  assert(c3.w.name === 'ÉMILIE', c3.w.name);
});

await check('steering reaches the big screen with the player id', async () => {
  scr.bins.length = 0;
  a.c.send(new Uint8Array([150, 1, 7]));
  const bin = await scr.waitBin(d => d[0] === 1);
  const id = (bin[1] << 8) | bin[2];
  assert(id === a.w.id && bin[3] === 150 && bin[4] === 1 && bin[5] === 7, Array.from(bin).join(','));
});

await check('steering is capped at 40 messages a second per phone', async () => {
  await sleep(1100);
  scr.bins.length = 0;
  for (let i = 0; i < 120; i++) b.c.send(new Uint8Array([100 + (i % 50), 0, i]));
  await sleep(600);
  let n = 0;
  for (const x of scr.bins) n += (x.data.length - 1) / 5;
  assert(n > 0 && n <= 40, 'received ' + n);
});

await check('taps from the line reach the big screen as one total', async () => {
  c3.c.send({ t: 'tap', n: 5 });
  c3.c.send({ t: 'tap', n: 3 });
  const m = await scr.waitFor(x => x.t === 'taps');
  assert(m.n === 8 && m.by === 1, JSON.stringify(m));
});

await check('the big screen can message one phone and all phones', async () => {
  scr.send({ t: 'to', id: a.w.id, m: { t: 'fx', k: 'kill' } });
  const one = await a.c.waitFor(x => x.t === 'fx');
  assert(one.k === 'kill', 'fx');
  scr.send({ t: 'all', m: { t: 'tick', left: 99 } });
  for (const p of [a, b, c3]) await p.c.waitFor(x => x.t === 'tick' && x.left === 99);
});

await check('the app ping gets a pong without waking the room', async () => {
  a.c.send('ping');
  await a.c.waitFor(x => x.raw === 'pong');
});

await check('a dropped phone reconnects to the same seat with its token', async () => {
  a.c.close();
  const off = await scr.waitFor(m => m.t === 'p' && m.p.id === a.w.id && !m.p.connected);
  assert(off.p.seat === 0, 'seat kept');
  const again = track(new Client(`${WS_BASE}/room/${room}/ws?role=phone&token=${a.w.token}`));
  const w = await again.waitFor(m => m.t === 'welcome');
  assert(w.id === a.w.id && w.seat === 0, JSON.stringify(w));
  a.c = again;
});

await check('end of round: drivers make room for the line', async () => {
  scr.send({ t: 'rotate' });
  const s = await c3.c.waitFor(m => m.t === 'seat' && m.seat !== null);
  assert(s.seat === 0 || s.seat === 1, JSON.stringify(s));
  const r = await scr.waitFor(m => m.t === 'roster');
  const seated = r.players.filter(p => p.seat !== null).map(p => p.name).sort();
  assert(seated.length === 2 && seated.includes('ÉMILIE'), seated.join(','));
  const lined = r.players.filter(p => p.queued);
  assert(lined.length === 1, 'one driver went to the back of the line');
});

const admin = track(screen(room, host, 'admin'));
await check('the host panel connects with the host key', async () => {
  const r = await admin.waitFor(m => m.t === 'roster');
  assert(r.players.length === 3, 'players ' + r.players.length);
});

await check('host can hide a name', async () => {
  admin.send({ t: 'hide', id: b.w.id, on: true });
  const n = await b.c.waitFor(m => m.t === 'name');
  assert(n.name === 'DRIVER ' + String(b.w.id).padStart(2, '0'), n.name);
  const p = await scr.waitFor(m => m.t === 'p' && m.p.id === b.w.id && m.p.hidden);
  assert(p.p.name.startsWith('DRIVER'), p.p.name);
});

await check('host can lock the room and new phones are refused', async () => {
  admin.send({ t: 'lock', on: true });
  await scr.waitFor(m => m.t === 'lock' && m.on === true);
  const r = await joinPhone(roster.code, 'LATE');
  track(r.c);
  assert(r.err && r.err.why === 'locked', JSON.stringify(r.err));
  admin.send({ t: 'lock', on: false });
  await scr.waitFor(m => m.t === 'lock' && m.on === false);
});

await check('host can remove a player, whose token then stops working', async () => {
  admin.send({ t: 'kick', id: b.w.id });
  const bye = await b.c.waitFor(m => m.t === 'bye');
  assert(bye.why === 'removed', bye.why);
  const back = track(new Client(`${WS_BASE}/room/${room}/ws?role=phone&token=${b.w.token}`));
  const e = await back.waitFor(m => m.t === 'err');
  assert(e.why === 'token', e.why);
});

await check('host start command reaches the big screen', async () => {
  admin.send({ t: 'cmd', c: 'start' });
  await scr.waitFor(m => m.t === 'cmd' && m.c === 'start');
});

await check('an idle driver is benched and can get back in line', async () => {
  c3.c.msgs.length = 0;
  scr.send({ t: 'bench', id: c3.w.id });
  const s = await c3.c.waitFor(m => m.t === 'seat' && m.why === 'idle');
  assert(s.seat === null && s.line === -1, JSON.stringify(s));
  c3.c.send({ t: 'line' });
  const back = await c3.c.waitFor(m => m.t === 'seat');
  assert(back.seat !== null || back.line >= 1, JSON.stringify(back));
});

await check('a second big screen replaces the first', async () => {
  const second = track(screen(room, host));
  await second.waitFor(m => m.t === 'roster');
  await scr.waitFor(m => m.t === 'replaced');
  const closed = await scr.waitClose();
  assert(closed.code === 4001, 'code ' + closed.code);
});

await check('codes change, the previous code still works, older codes stop', async () => {
  const s2 = track(screen(room, host));
  const first = (await s2.waitFor(m => m.t === 'roster')).code;
  const next = await s2.waitFor(m => m.t === 'code', 15000, 'a new code');
  assert(next.code !== first, 'code did not change');
  const stillOk = await joinPhone(first, 'PREV CODE');
  track(stillOk.c);
  assert(!stillOk.err, 'previous code refused: ' + JSON.stringify(stillOk.err));
  await s2.waitFor(m => m.t === 'code' && m.code !== next.code, 15000, 'a third code');
  const old = await joinPhone(first, 'OLD CODE');
  track(old.c);
  assert(old.err && old.err.why === 'code', 'old code accepted');
});

await check('a page on another website is refused', async () => {
  let c;
  try {
    c = track(new Client(`${WS_BASE}/join?code=ABCD`, { headers: { Origin: 'https://evil.example' } }));
  } catch (e) {
    throw new Error('this Node version cannot set Origin: ' + e.message);
  }
  const m = await c.waitFor(x => x.t === 'err');
  assert(m.why === 'origin', m.why);
});

for (const c of open) c.close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length} of ${results.length} relay checks passed`);
process.exit(failed.length ? 1 : 0);
