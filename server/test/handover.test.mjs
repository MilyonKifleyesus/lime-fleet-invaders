// Checks that play carries on when connections reach their time limit.
// Run against a dev server started with LIVE_TTL_MS=30000 LIVE_TTL_ENFORCE=1:
// every connection is cut after 30 seconds, like Vercel does after 300.
import { Screen, createRoom, joinPhone, sleep, PHONE_WS, ORIGIN } from './client.mjs';

const start = Date.now();
const SECONDS = Number(process.argv[2] || 80);
const { body } = await createRoom(4);
const scr = new Screen(body.room, body.host, 4);
const code = (await scr.waitFor(m => m.t === 'code')).code;
const first = await joinPhone(code, 'HANDOVER');
first.c.close();

// The real phone link, which moves to a fresh connection before the cut.
let welcomes = 0;
const phone = new globalThis.LiveLink({
  url: () => `${PHONE_WS}?room=${body.room}&role=phone&token=${first.w.token}`,
  watch: true,
  wsInit: ORIGIN ? { headers: { Origin: ORIGIN } } : undefined,
  onMessage: m => { if (m.t === 'welcome') { welcomes++; console.log('  phone moved at ' + ((Date.now() - start) / 1000).toFixed(1) + ' s'); } },
});
await sleep(1500);

let last = performance.now();
let worst = 0;
let got = 0;
scr.bins.length = 0;
const onBin = () => {
  for (const b of scr.bins.splice(0)) {
    got++;
    if (b.at - last > 150) console.log("  gap " + Math.round(b.at - last) + " ms at " + ((Date.now() - start) / 1000).toFixed(1) + " s");
    worst = Math.max(worst, b.at - last);
    last = b.at;
  }
};
let seq = 0;

const steer = setInterval(() => {
  seq = (seq + 1) & 255;
  phone.sendRaw(new Uint8Array([100 + (seq % 80), 0, seq]));
  onBin();
}, 50);
let screenDrops = 0;
const watch = setInterval(() => { if (scr.room.link.state !== 'open') screenDrops++; }, 100);
await sleep(SECONDS * 1000);
clearInterval(steer);
clearInterval(watch);
onBin();
const ok = worst < 400 && got > SECONDS * 15 && screenDrops === 0;
console.log(`${SECONDS} s with cuts every 30 s: ${got} steering bundles reached the big screen, `
  + `longest gap ${Math.round(worst)} ms, phone reconnected ${welcomes} times, big screen offline ${screenDrops * 100} ms`);
console.log(ok ? 'PASS handover keeps play going' : 'FAIL handover');
phone.stop();
scr.close();
process.exit(ok ? 0 : 1);
