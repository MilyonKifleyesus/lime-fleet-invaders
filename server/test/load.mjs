// Crowd test: many phones, some driving, the rest tapping in Mission Control.
//   node test/load.mjs [phones] [seats] [hz] [seconds]
// Uses SCREEN / PHONES like the other tests; put them on different copies to
// send everything through Redis.
import { Screen, createRoom, joinPhone, sleep } from './client.mjs';

const [phones = 200, seats = 16, hz = 20, seconds = 20] = process.argv.slice(2).map(Number);
const { body } = await createRoom(seats);
const scr = new Screen(body.room, body.host, seats);
let code = (await scr.waitFor(m => m.t === 'code')).code;
scr.room.opts.onMessage = m => { if (m.t === 'code') code = m.code; };

const list = [];
const t0 = Date.now();
for (let i = 0; i < phones; i += 20) {
  const batch = [];
  for (let j = i; j < Math.min(phones, i + 20); j++) batch.push(joinPhone(code, 'LOAD ' + j));
  for (const r of await Promise.all(batch)) {
    if (r.err) throw new Error('join failed: ' + JSON.stringify(r.err));
    list.push(r);
  }
}
console.log(`${list.length} phones joined in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const drivers = list.filter(p => p.w.seat !== null);
const crowd = list.filter(p => p.w.seat === null);
const sent = new Map();
let sentN = 0;
let gotN = 0;
const delays = [];
scr.room.opts.onBinary = d => {
  const now = performance.now();
  for (let i = 1; i + 5 <= d.length; i += 5) {
    const key = ((d[i] << 8) | d[i + 1]) * 256 + d[i + 5 - 1];
    const at = sent.get(key);
    if (at !== undefined) {
      gotN++;
      delays.push(now - at);
      sent.delete(key);
    }
  }
};
let seq = 0;
const steer = setInterval(() => {
  seq = (seq + 1) & 255;
  const now = performance.now();
  for (const p of drivers) {
    sent.set(p.w.id * 256 + seq, now);
    sentN++;
    p.c.send(new Uint8Array([100 + ((seq * 7) % 100), 1, seq]));
  }
}, 1000 / hz);
let taps = 0;
const tapper = setInterval(() => { for (const p of crowd) p.c.send({ t: 'tap', n: 6 }); }, 1000);
const prevTaps = scr.room.toScreen.bind(scr.room);
scr.room.toScreen = m => { if (m.t === 'taps') taps += m.n; prevTaps(m); };
await sleep(seconds * 1000);
clearInterval(steer);
clearInterval(tapper);
await sleep(800);
delays.sort((x, y) => x - y);
const pct = q => Math.round(delays[Math.floor(delays.length * q)] || 0);
console.log(`${drivers.length} drivers at ${hz} a second, ${crowd.length} tapping, ${seconds} s`);
console.log(`steering delivered ${(100 * gotN / sentN).toFixed(1)}% (${gotN} of ${sentN}); delay typical ${pct(0.5)} ms, 1 in 20 over ${pct(0.95)} ms, worst ${pct(0.999)} ms`);
console.log(`taps counted ${taps} of ${crowd.length * 6 * seconds} sent`);
for (const p of list) p.c.close();
scr.close();
process.exit(gotN / sentN > 0.99 ? 0 : 1);
