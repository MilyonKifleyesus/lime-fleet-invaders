// Joystick checks: stick players plugged into the big-screen computer share
// the room with phones. Runs against the same switchboard as live.test.mjs.
import { Client, Screen, createRoom, joinPhone, adminUrl, sleep } from './client.mjs';

const PROD = process.env.PROD === '1';
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

const made = await createRoom(3);
const { room, host } = made.body;
const scr = new Screen(room, host, 3);
const R = () => scr.room;
const player = id => R().players.get(id);
const roster = await scr.waitFor(m => m.t === 'roster');
const code = (await scr.waitFor(m => m.t === 'code')).code;
const admin = track(new Client(adminUrl(room, host)));
await admin.waitFor(m => m.t === 'roster');

let s1, s2, phoneA, phoneB;

await check('joysticks are on when a room opens', async () => {
  assert(roster.pads === true, JSON.stringify(roster));
});

await check('a joystick press joins with a colour, a generated name and a seat', async () => {
  R().setPads(1);
  s1 = R().addLocal(0);
  assert(typeof s1 === 'number', 'id ' + s1);
  const p = await scr.waitFor(m => m.t === 'p' && m.join && m.p.id === s1);
  assert(p.p.local === 0 && p.p.seat !== null, JSON.stringify(p.p));
  assert(p.p.color === 'amber' && /^AMBER [A-Z]+/.test(p.p.name), p.p.name);
  const a = await admin.waitFor(m => m.t === 'p' && m.p.id === s1);
  assert(a.p.local === 0, 'host sees the stick');
});

await check('the same stick slot cannot join twice', async () => {
  assert(R().addLocal(0) === null, 'second join on slot 0 was allowed');
});

await check('a plugged-in joystick keeps a seat free from phones', async () => {
  R().setPads(2); // a second stick is plugged in but nobody has pressed it yet
  phoneA = await joinPhone(code, 'PHONE A');
  track(phoneA.c);
  assert(!phoneA.err && phoneA.w.seat !== null, 'phone A should drive: ' + JSON.stringify(phoneA.w));
  phoneB = await joinPhone(code, 'PHONE B');
  track(phoneB.c);
  assert(!phoneB.err && phoneB.w.seat === null && phoneB.w.line === 1, 'phone B should wait: ' + JSON.stringify(phoneB.w));
});

await check('the second joystick takes the seat kept for it', async () => {
  s2 = R().addLocal(1);
  const p = await scr.waitFor(m => m.t === 'p' && m.join && m.p.id === s2);
  assert(p.p.seat !== null && p.p.color === 'sky', JSON.stringify(p.p));
  const seats = R().active().filter(x => x.seat !== null).map(x => x.seat).sort();
  assert(seats.join(',') === '0,1,2', 'seats ' + seats.join(','));
});

await check('at the end of a round, stick players keep their seats', async () => {
  scr.send({ t: 'rotate' });
  await scr.waitFor(m => m.t === 'roster');
  assert(player(s1).seat !== null && player(s2).seat !== null, 'a stick lost its seat');
  const seated = R().active().filter(x => x.seat !== null).length;
  assert(seated === 3, 'seated ' + seated);
  // Locally (no minimum turn) phone A made room for phone B; online A keeps it for a minute.
  if (!PROD) assert(player(phoneB.w.id).seat !== null && player(phoneA.w.id).seat === null, 'phones did not rotate');
});

await check('a stick put down for too long frees its seat, and the stick is free again', async () => {
  const waiting = R().line()[0];
  scr.send({ t: 'bench', id: s2 });
  const gone = await scr.waitFor(m => m.t === 'p' && m.p.id === s2 && m.p.removed);
  assert(gone.p.local === 1, JSON.stringify(gone.p));
  // The stick is still plugged in, so its seat stays kept for the next person.
  assert(R().line()[0] === waiting && waiting.seat === null, 'the kept seat went to a phone');
  R().setPads(1); // stick 2 unplugged
  await sleep(200);
  assert(waiting.seat !== null, 'the phone in line should get the seat once the stick is unplugged');
  R().setPads(2);
});

await check('the next press on a freed stick is a new player', async () => {
  const again = R().addLocal(1);
  assert(again !== null && again !== s2, 'new id ' + again);
  const p = await scr.waitFor(m => m.t === 'p' && m.join && m.p.id === again);
  // All 3 seats are taken by now, so the new stick player goes to the front of the line.
  assert(p.p.seat === null && p.p.queued, JSON.stringify(p.p));
  assert(R().line()[0].id === again, 'stick player should be first in line');
  s2 = again;
});

await check('the host can free a stick seat', async () => {
  admin.send({ t: 'kick', id: s1 });
  await scr.waitFor(m => m.t === 'p' && m.p.id === s1 && m.p.removed);
  // The freed seat goes to the stick player at the front of the line.
  const p = await scr.waitFor(m => m.t === 'p' && m.p.id === s2 && m.p.seat !== null);
  assert(p.p.local === 1, JSON.stringify(p.p));
});

await check('the host can turn joysticks off and on', async () => {
  admin.send({ t: 'pads', on: false });
  await scr.waitFor(m => m.t === 'pads' && m.on === false);
  await admin.waitFor(m => m.t === 'pads' && m.on === false);
  assert(player(s2).removed, 'stick player should be sent away');
  assert(R().addLocal(2) === null, 'a stick joined while joysticks were off');
  // With joysticks off, no seat is kept for them.
  const seated = R().active().filter(x => x.seat !== null).length;
  assert(seated === Math.min(3, R().active().length), 'seats kept while joysticks are off: ' + seated);
  admin.send({ t: 'pads', on: true });
  await scr.waitFor(m => m.t === 'pads' && m.on === true);
  assert(R().snapshot().pads === true, 'the room still says joysticks are off');
});

await check('after a reload, stick players are gone and phones stay', async () => {
  const s3 = R().addLocal(3);
  assert(s3 !== null, 'stick 4 joined');
  await scr.waitFor(m => m.t === 'p' && m.p.id === s3);
  scr.close();
  await sleep(300);
  const again = new Screen(room, host, 3);
  const r = await again.waitFor(m => m.t === 'roster');
  assert(!r.players.some(p => p.local !== null && p.local !== undefined), 'a stick player survived the reload');
  assert(r.players.some(p => p.name === 'PHONE A') && r.players.some(p => p.name === 'PHONE B'), 'phones missing');
  again.close();
});

clearInterval(keepalive);
for (const c of open) c.close();
scr.close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length} of ${results.length} joystick checks passed`);
process.exit(failed.length ? 1 : 0);
