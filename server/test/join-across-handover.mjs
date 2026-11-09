// Checks that phones can still join and come back after the big screen moves
// to a new connection (Vercel ends every connection after 5 minutes).
// Every 15 s a new phone joins with the current code and the first phone
// reconnects with its token. Locally, run against a server started with
// LIVE_TTL_MS=30000 LIVE_TTL_ENFORCE=1; online, run for over 300 seconds.
//   node test/join-across-handover.mjs [seconds]
import { Client, Screen, createRoom, joinPhone, resumeUrl, sleep } from './client.mjs';

const SECONDS = Number(process.argv[2] || 90);
const start = Date.now();
const at = () => ((Date.now() - start) / 1000).toFixed(1) + ' s';
const { body } = await createRoom(16);
const scr = new Screen(body.room, body.host, 16);
let code = (await scr.waitFor(m => m.t === 'code')).code;
const first = await joinPhone(code, 'FIRST');
if (first.err) throw new Error('first join failed ' + JSON.stringify(first.err));
first.c.close();
let lastWs = scr.room.link.ws;
let moves = 0;
let fails = 0;
let tries = 0;
const watch = setInterval(() => {
  if (scr.room.link.ws !== lastWs) { moves++; lastWs = scr.room.link.ws; console.log('  big screen moved to a new connection at ' + at()); }
}, 200);

async function attempt(i) {
  code = scr.room.meta.code || code;
  tries++;
  const t0 = Date.now();
  const p = await joinPhone(code, 'P' + i).catch(e => ({ err: { why: e.message } }));
  const joinMs = Date.now() - t0;
  if (p.c) p.c.close();
  const t1 = Date.now();
  const back = new Client(resumeUrl(body.room, first.w.token));
  let resumed = null;
  try { resumed = await back.waitFor(m => m.t === 'welcome' || m.t === 'err', 8000, 'welcome'); } catch (e) { resumed = { t: 'timeout' }; }
  const resumeMs = Date.now() - t1;
  back.close();
  const ok = !p.err && resumed && resumed.t === 'welcome';
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${at()}: new phone ${p.err ? 'failed (' + p.err.why + ')' : 'joined in ' + joinMs + ' ms'}, `
    + `returning phone ${resumed && resumed.t === 'welcome' ? 'back in ' + resumeMs + ' ms' : 'failed (' + (resumed && (resumed.why || resumed.t)) + ')'}`);
}

let i = 0;
while (Date.now() - start < SECONDS * 1000) {
  await attempt(++i);
  await sleep(15000);
}
clearInterval(watch);
const ok = fails === 0 && moves > 0;
console.log(`${SECONDS} s: ${tries - fails} of ${tries} join rounds worked; big screen moved ${moves} times`);
console.log(ok ? 'PASS phones join across big-screen handovers' : moves ? 'FAIL some joins failed' : 'FAIL no handover happened (run longer)');
scr.close();
process.exit(ok ? 0 : 1);
