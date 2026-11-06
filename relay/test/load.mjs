// Load test: many phones in one room.
// node test/load.mjs [phones=200] [seats=16] [hz=20] [seconds=20] [allSteer=0]
// Drivers steer at `hz`; everyone in line taps twice a second. With allSteer=1,
// every phone steers, which is the worst case.
import { createRoom, screen, joinPhone, sleep } from './client.mjs';

const [phones = 200, seats = 16, hz = 20, seconds = 20, allSteer = 0] = process.argv.slice(2).map(Number);
console.log(`Load: ${phones} phones, ${seats} seats, ${hz} Hz steering, ${seconds} s, allSteer=${allSteer}`);

const { body } = await createRoom(seats);
const scr = screen(body.room, body.host);
const roster = await scr.waitFor(m => m.t === 'roster');

const t0 = performance.now();
const clients = [];
for (let i = 0; i < phones; i += 25) {
  const batch = [];
  for (let j = i; j < Math.min(phones, i + 25); j++) batch.push(joinPhone(roster.code, 'LOAD ' + j));
  for (const r of await Promise.all(batch)) {
    if (r.err) throw new Error('join failed: ' + JSON.stringify(r.err));
    clients.push(r);
  }
}
console.log(`joined ${clients.length} phones in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const sentAt = new Map(); // id -> array[256] of send times
const latencies = [];
let received = 0;
let sent = 0;
let taps = 0;
let tapMsgs = 0;
scr.ws.addEventListener('message', e => {
  if (typeof e.data === 'string') {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'taps') { taps += m.n; tapMsgs++; }
    } catch { /* ignore */ }
    return;
  }
  const now = performance.now();
  const d = new Uint8Array(e.data);
  for (let i = 1; i + 4 < d.length + 1; i += 5) {
    const id = (d[i] << 8) | d[i + 1];
    const seq = d[i + 4];
    const times = sentAt.get(id);
    if (times && times[seq]) {
      latencies.push(now - times[seq]);
      times[seq] = 0;
    }
    received++;
  }
});
scr.msgs.length = 0;
scr.bins.length = 0;

const steerers = clients.filter(c => allSteer || c.w.seat !== null);
const tappers = clients.filter(c => !allSteer && c.w.seat === null);
const timers = [];
const interval = 1000 / hz;
for (const c of steerers) {
  const times = new Array(256).fill(0);
  sentAt.set(c.w.id, times);
  let seq = 0;
  // Spread start times so phones don't all send in the same millisecond.
  timers.push(setTimeout(() => {
    timers.push(setInterval(() => {
      seq = (seq + 1) & 255;
      times[seq] = performance.now();
      c.c.ws.send(new Uint8Array([Math.floor(Math.random() * 201), 1, seq]));
      sent++;
    }, interval));
  }, Math.random() * interval));
}
for (const c of tappers) {
  timers.push(setInterval(() => c.c.ws.send(JSON.stringify({ t: 'tap', n: 6 })), 1000));
}

await sleep(seconds * 1000);
for (const t of timers) { clearInterval(t); clearTimeout(t); }
await sleep(500);

latencies.sort((a, b) => a - b);
const pct = p => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1) : 'n/a');
console.log(`steering phones: ${steerers.length}, line phones: ${tappers.length}`);
console.log(`steering sent ${sent} (${(sent / seconds).toFixed(0)}/s), reached screen ${received} (${((received / Math.max(1, sent)) * 100).toFixed(1)}%)`);
console.log(`latency phone -> relay -> screen, ms: p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${latencies.length ? latencies[latencies.length - 1].toFixed(1) : 'n/a'}`);
if (tappers.length) console.log(`taps: ${taps} arrived in ${tapMsgs} messages (${(tapMsgs / seconds).toFixed(1)}/s to the screen)`);
for (const c of clients) c.c.close();
scr.close();
process.exit(0);
