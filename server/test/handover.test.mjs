// Checks that play carries on when connections reach their time limit.
// Locally, run against a dev server started with LIVE_TTL_MS=30000
// LIVE_TTL_ENFORCE=1 (every connection is cut after 30 seconds). Against
// Vercel, run for more than 300 seconds to cross the real limit.
//   node test/handover.test.mjs [seconds]
import { Screen, createRoom, joinPhone, sleep, PHONE_WS, ORIGIN } from './client.mjs';

const start = Date.now();
const at = () => ((Date.now() - start) / 1000).toFixed(1) + ' s';
const SECONDS = Number(process.argv[2] || 80);
const { body } = await createRoom(4);
const scr = new Screen(body.room, body.host, 4);
const code = (await scr.waitFor(m => m.t === 'code')).code;
const first = await joinPhone(code, 'HANDOVER');
first.c.close();

// The real phone link, which moves to a fresh connection before the cut.
const phone = new globalThis.LiveLink({
  url: () => `${PHONE_WS}?room=${body.room}&role=phone&token=${first.w.token}`,
  watch: true,
  wsInit: ORIGIN ? { headers: { Origin: ORIGIN } } : undefined,
  onMessage: () => {},
});
// Log every move to a new connection, for the phone and the big screen.
let phoneMoves = 0;
let screenMoves = 0;
let lastPhoneWs = null;
let lastScreenWs = null;
await sleep(1500);
lastPhoneWs = phone.ws;
lastScreenWs = scr.room.link.ws;

let last = performance.now();
let worst = 0;
let sent = 0;
let got = 0;
scr.bins.length = 0;
const onBin = () => {
  for (const b of scr.bins.splice(0)) {
    got += (b.data.length - 1) / 5;
    if (b.at - last > 150) console.log('  gap ' + Math.round(b.at - last) + ' ms at ' + at());
    worst = Math.max(worst, b.at - last);
    last = b.at;
  }
};
let seq = 0;
const steer = setInterval(() => {
  seq = (seq + 1) & 255;
  if (phone.sendRaw(new Uint8Array([100 + (seq % 80), 0, seq]))) sent++;
  onBin();
  if (phone.ws !== lastPhoneWs) { phoneMoves++; lastPhoneWs = phone.ws; console.log('  phone moved to a new connection at ' + at()); }
  if (scr.room.link.ws !== lastScreenWs) { screenMoves++; lastScreenWs = scr.room.link.ws; console.log('  big screen moved to a new connection at ' + at()); }
}, 50);
let screenDrops = 0;
const watch = setInterval(() => { if (scr.room.link.state !== 'open') screenDrops++; }, 100);
await sleep(SECONDS * 1000);
clearInterval(steer);
clearInterval(watch);
await sleep(500);
onBin();
const share = got / Math.max(1, sent);
const ok = worst < 1000 && share > 0.98 && screenDrops <= 5;
console.log(`${SECONDS} s: ${got} of ${sent} steering moves reached the big screen (${(share * 100).toFixed(1)}%), `
  + `longest gap ${Math.round(worst)} ms; phone moved ${phoneMoves} times, big screen moved ${screenMoves} times, `
  + `big screen offline ${screenDrops * 100} ms`);
console.log(ok ? 'PASS handover keeps play going' : 'FAIL handover');
phone.stop();
scr.close();
process.exit(ok ? 0 : 1);
