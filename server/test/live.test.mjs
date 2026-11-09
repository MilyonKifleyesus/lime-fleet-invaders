// Fleet Invaders Live checks: the switchboard plus the big screen's room.
// Local: start server/dev.mjs with EVENT_KEY_HASH for 'local-test-key',
// ALLOW_LOCAL=1, CODE_MS=8000 and MIN_TURN_MS=0 (test/run-all.mjs does this).
// Deployed: SCREEN, EVENT_KEY, ORIGIN and PROD=1, which uses the real timings:
// codes last 45 seconds and a driver keeps a seat for at least a minute.
import {
  SCREEN, PHONES, Client, Screen, createRoom, joinPhone, adminUrl, resumeUrl, joinUrl, sleep,
} from './client.mjs';

const PROD = process.env.PROD === '1';
const CODE_WAIT = PROD ? 55000 : 15000;

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
const keepalive = setInterval(() => {
  for (const c of open) if (c.ws && c.ws.readyState === 1) c.send('ping');
}, 10000);

console.log(`Big screen on ${SCREEN}, phones on ${PHONES}${PROD ? ' (real timings)' : ''}`);

await check('health answers', async () => {
  const r = await fetch(SCREEN + '/api/live');
  const b = await r.json();
  assert(r.ok && b.ok, 'status ' + r.status);
  console.log('        bus: ' + b.bus + ', copy ' + b.copy);
});

await check('a room cannot be created without the event key', async () => {
  const r = await createRoom(16, 'wrong-key');
  assert(r.status === 401, 'status ' + r.status);
});

const made = await createRoom(2);
const { room, host } = made.body || {};
let scr = track(new Screen(room, host, 2));
let roster;

await check('the event key creates a room with 2 seats', async () => {
  assert(made.status === 200 && /^[a-z0-9]{12}$/.test(room) && host.length === 32, JSON.stringify(made));
  assert(made.body.seats === 2, 'seats ' + made.body.seats);
});

await check('the big screen connects and gets a join code', async () => {
  roster = await scr.waitFor(m => m.t === 'roster');
  const code = await scr.waitFor(m => m.t === 'code');
  roster.code = code.code;
  assert(/^[A-HJ-NP-Z2-9]{4}$/.test(roster.code), 'code ' + roster.code);
  assert(roster.players.length === 0, 'players');
});

let turn = null;
if (PROD) {
  const r = await createRoom(1);
  const s = track(new Screen(r.body.room, r.body.host, 1));
  const code = (await s.waitFor(m => m.t === 'code')).code;
  const first = await joinPhone(code, 'FIRST');
  track(first.c);
  const second = await joinPhone(code, 'SECOND');
  track(second.c);
  turn = { s, first, second, at: Date.now() };
}

await check('a wrong host key is refused', async () => {
  const bad = track(new Client(adminUrl(room, 'x'.repeat(32))));
  const m = await bad.waitFor(x => x.t === 'err');
  assert(m.why === 'key', m.why);
});

await check('a wrong join code is refused', async () => {
  const c = track(new Client(joinUrl('ZZZZ')));
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
  await sleep(800);
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

await check('the app ping gets a pong', async () => {
  a.c.send('ping');
  await a.c.waitFor(x => x.raw === 'pong');
});

await check('a dropped phone reconnects to the same seat with its token', async () => {
  a.c.close();
  const off = await scr.waitFor(m => m.t === 'p' && m.p.id === a.w.id && !m.p.connected);
  assert(off.p.seat === 0, 'seat kept');
  const again = track(new Client(resumeUrl(room, a.w.token)));
  const w = await again.waitFor(m => m.t === 'welcome');
  assert(w.id === a.w.id && w.seat === 0, JSON.stringify(w));
  a.c = again;
});

await check('a phone that opens a second connection moves over without losing its seat', async () => {
  const second = track(new Client(resumeUrl(room, a.w.token)));
  const w = await second.waitFor(m => m.t === 'welcome');
  assert(w.id === a.w.id && w.seat === 0, JSON.stringify(w));
  const closed = await a.c.waitClose();
  assert(closed.code === 4002, 'old connection closed with ' + closed.code);
  scr.bins.length = 0;
  second.send(new Uint8Array([60, 0, 9]));
  const bin = await scr.waitBin(d => d[0] === 1);
  assert(((bin[1] << 8) | bin[2]) === a.w.id && bin[3] === 60, Array.from(bin).join(','));
  a.c = second;
});

await check(PROD ? 'end of round: drivers who just sat down keep their seats' : 'end of round: drivers make room for the line', async () => {
  scr.send({ t: 'rotate' });
  if (PROD) {
    const r = await scr.waitFor(m => m.t === 'roster');
    const seated = r.players.filter(p => p.seat !== null).map(p => p.name).sort();
    assert(seated.join(',') === 'PRIYA,PRIYA 2', seated.join(','));
    assert(r.players.filter(p => p.queued).length === 1, 'ÉMILIE should still be in line');
    return;
  }
  const s = await c3.c.waitFor(m => m.t === 'seat' && m.seat !== null);
  assert(s.seat === 0 || s.seat === 1, JSON.stringify(s));
  const r = await scr.waitFor(m => m.t === 'roster');
  const seated = r.players.filter(p => p.seat !== null).map(p => p.name).sort();
  assert(seated.length === 2 && seated.includes('ÉMILIE'), seated.join(','));
  assert(r.players.filter(p => p.queued).length === 1, 'one driver went to the back of the line');
});

const admin = track(new Client(adminUrl(room, host)));
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
  await admin.waitFor(m => m.t === 'p' && m.p.id === b.w.id && m.p.hidden);
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
  const back = track(new Client(resumeUrl(room, b.w.token)));
  const e = await back.waitFor(m => m.t === 'err');
  assert(e.why === 'token', e.why);
});

await check('a seat freed mid-round goes straight to the next phone in line', async () => {
  const next = PROD ? c3 : a;
  const s = await next.c.waitFor(m => m.t === 'seat' && m.seat !== null);
  assert(s.line === 0, JSON.stringify(s));
  await scr.waitFor(m => m.t === 'p' && m.p.id === next.w.id && m.p.seat !== null);
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

await check('a big screen that reloads picks up the same room and players', async () => {
  scr.close();
  await sleep(300);
  const again = track(new Screen(room, host, 2));
  const r = await again.waitFor(m => m.t === 'roster');
  const names = r.players.map(p => p.name).sort().join(',');
  assert(names.includes('PRIYA') && names.includes('ÉMILIE'), names);
  again.send({ t: 'to', id: a.w.id, m: { t: 'fx', k: 'hit' } });
  const fx = await a.c.waitFor(x => x.t === 'fx' && x.k === 'hit');
  assert(fx, 'phone still reachable');
  scr = again;
});

await check('a second big screen replaces the first', async () => {
  const second = track(new Screen(room, host, 2));
  await second.waitFor(m => m.t === 'roster');
  await scr.waitFor(m => m.t === 'replaced');
  scr = second;
});

await check('codes change, the previous code still works, older codes stop', async () => {
  const first = (await scr.waitFor(m => m.t === 'code', CODE_WAIT, 'a code')).code;
  const next = await scr.waitFor(m => m.t === 'code', CODE_WAIT, 'a new code');
  assert(next.code !== first, 'code did not change');
  const stillOk = await joinPhone(first, 'PREV CODE');
  track(stillOk.c);
  assert(!stillOk.err, 'previous code refused: ' + JSON.stringify(stillOk.err));
  await scr.waitFor(m => m.t === 'code' && m.code !== next.code, CODE_WAIT, 'a third code');
  const old = await joinPhone(first, 'OLD CODE');
  track(old.c);
  assert(old.err && old.err.why === 'code', 'old code accepted');
});

await check('a page on another website is refused', async () => {
  const c = track(new Client(joinUrl('ABCD'), { headers: { Origin: 'https://evil.example' } }));
  const m = await c.waitFor(x => x.t === 'err');
  assert(m.why === 'origin', m.why);
});

if (turn) {
  await check('after a minute at the wheel, a driver makes room for the line', async () => {
    const wait = 61000 - (Date.now() - turn.at);
    if (wait > 0) await sleep(wait);
    turn.s.send({ t: 'rotate' });
    await turn.second.c.waitFor(m => m.t === 'seat' && m.seat === 0, 5000, 'SECOND seated');
    await turn.first.c.waitFor(m => m.t === 'seat' && m.seat === null && m.line === 1, 5000, 'FIRST in line');
  });
}

clearInterval(keepalive);
for (const c of open) c.close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length} of ${results.length} live checks passed`);
process.exit(failed.length ? 1 : 0);
