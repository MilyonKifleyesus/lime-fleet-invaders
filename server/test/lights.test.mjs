// Checks for public/live/lights.js: the bytes sent to PlayStation and Switch
// pads, and matching each approved pad to the stick that just joined.
// Uses pretend WebHID devices, so it needs no browser and no hardware.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', '..', 'public', 'live', 'lights.js');
vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
const Lights = globalThis.FleetLights;

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  pass  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + ' :: ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A pretend WebHID device.
function device(productId, vendorId = 0x054c) {
  const listeners = [];
  return {
    vendorId, productId, productName: 'Pretend ' + productId.toString(16), opened: false, sent: [],
    open() { this.opened = true; return Promise.resolve(); },
    sendReport(id, data) { this.sent.push([id, Array.from(data)]); return Promise.resolve(); },
    addEventListener(type, fn) { if (type === 'inputreport') listeners.push(fn); },
    input(reportId, bytes) { const data = new DataView(new Uint8Array(bytes).buffer); for (const f of listeners) f({ reportId, data }); },
  };
}
function hid(devs) {
  return {
    requestDevice: () => Promise.resolve(devs),
    getDevices: () => Promise.resolve([]),
    addEventListener() {},
  };
}
let clock = 1000;
const now = () => clock;

// A DualSense USB input report (64 bytes): nothing pressed, or cross pressed.
function ds5Input(press) {
  const b = new Array(63).fill(0);
  b[7] = press ? 0x28 : 0x08; // cross is bit 5 of the high nibble; d-pad 8 = centred
  return b;
}

await check('the CRC matches the standard check value', () => {
  const v = Lights.crc32(new TextEncoder().encode('123456789'));
  assert(v === 0xcbf43926, v.toString(16));
});

await check('DualSense by cable: colour, player lights and trigger go in the right bytes', async () => {
  const d = device(0x0ce6);
  const L = new Lights({ hid: hid([d]), now });
  await L.connect();
  d.input(0x01, ds5Input(false));
  clock += 10; d.input(0x01, ds5Input(true));
  assert(L.claim(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 2), 'not claimed');
  clock += 100;
  L.set(1, '#56B4E9', 2, 'blaster');
  const [id, data] = d.sent.at(-1);
  assert(id === 0x02 && data.length === 47, 'report ' + id + ' / ' + data.length);
  assert(data[1] === 0x14, 'light bar and player light flags');
  assert(data[44] === 0x56 && data[45] === 0xb4 && data[46] === 0xe9, 'rgb ' + data.slice(44, 47));
  assert(data[43] === 0x0a, 'player 2 lights ' + data[43]);
  assert(data[10] === 0x02 && data[0] === 0x0c, 'trigger mode ' + data[10]);
});

await check('DualSense over Bluetooth: report 0x31 with a valid CRC', async () => {
  const d = device(0x0ce6);
  const L = new Lights({ hid: hid([d]), now });
  await L.connect();
  const bt = new Array(77).fill(0); bt[8] = 0x08; d.input(0x31, bt); // Bluetooth input report
  clock += 10; bt[8] = 0x28; d.input(0x31, bt);
  L.claim(0, 'Vendor: 054c Product: 0ce6');
  clock += 100;
  L.set(0, '#E69F00', 1, 'off');
  const [id, data] = d.sent.at(-1);
  assert(id === 0x31 && data.length === 77, 'report ' + id + ' / ' + data.length);
  const body = [0xa2, 0x31, ...data.slice(0, 73)];
  const crc = Lights.crc32(Uint8Array.from(body));
  const got = data[73] | (data[74] << 8) | (data[75] << 16) | (data[76] * 0x1000000);
  assert(crc === got >>> 0, 'crc ' + crc.toString(16) + ' vs ' + (got >>> 0).toString(16));
  assert(data[46] === 0xe6 && data[47] === 0x9f && data[48] === 0x00, 'rgb at offset 2 + 44');
});

await check('DualShock 4: light bar only, rumble left to the browser', async () => {
  const d = device(0x09cc);
  const L = new Lights({ hid: hid([d]), now });
  await L.connect();
  assert(L.claim(3, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', 1), 'the only pad of its model');
  clock += 100;
  L.set(3, '#009E73', 4, 'off');
  const [id, data] = d.sent.at(-1);
  assert(id === 0x05 && data.length === 31, 'report ' + id);
  assert(data[0] === 0x02 && data[3] === 0 && data[4] === 0, 'flags must not touch the motors');
  assert(data[5] === 0x00 && data[6] === 0x9e && data[7] === 0x73, 'rgb ' + data.slice(5, 8));
});

await check('Switch Pro: player lights through sub-command 0x30', async () => {
  const d = device(0x2009, 0x057e);
  const L = new Lights({ hid: hid([d]), now });
  await L.connect();
  const sw = new Array(48).fill(0); d.input(0x30, sw); clock += 10; sw[2] = 0x01; d.input(0x30, sw);
  assert(L.claim(2, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 2), 'matched by press');
  clock += 100;
  L.set(2, '#F0E442', 3, 'off');
  const [id, data] = d.sent.at(-1);
  assert(id === 0x01 && data[9] === 0x30 && data[10] === 0x07, 'sub-command ' + data[9] + ' lights ' + data[10]);
});

await check('two identical pads: the one whose button just went down gets the stick', async () => {
  const a = device(0x0ce6), b = device(0x0ce6);
  const L = new Lights({ hid: hid([a, b]), now });
  await L.connect();
  a.input(0x01, ds5Input(false)); b.input(0x01, ds5Input(false));
  clock += 2000;
  b.input(0x01, ds5Input(true)); // the player presses on pad b
  assert(L.claim(5, 'Vendor: 054c Product: 0ce6'), 'not claimed');
  assert(L.devs.find(x => x.dev === b).slot === 5 && L.devs.find(x => x.dev === a).slot === null, 'wrong pad');
  clock += 2000;
  assert(!L.claim(6, 'Vendor: 054c Product: 0ce6', 2), 'claimed pad a with no matching press');
});

await check('changes are rate-limited, and freeing a stick dims its pad', async () => {
  const d = device(0x0ce6);
  const L = new Lights({ hid: hid([d]), now });
  await L.connect();
  L.claim(0, 'Vendor: 054c Product: 0ce6', 1);
  clock += 100;
  const n0 = d.sent.length;
  L.set(0, '#ff0000', 1, 'off');
  L.set(0, '#00ff00', 1, 'off'); // within 50 ms: held back
  assert(d.sent.length === n0 + 1, 'sent ' + (d.sent.length - n0));
  L.release(0);
  const last = d.sent.at(-1)[1];
  assert(last[43] === 0 && last[44] < 60, 'not dimmed');
});

await check('a browser without WebHID: lights are simply off', async () => {
  const L = new Lights({ hid: null });
  assert(!L.supported && (await L.connect()) === 0 && (await L.start()) === 0, 'should be off');
  L.set(0, '#ffffff', 1, 'off');
});

console.log(`\n${passed} of ${passed + failed} lights checks passed`);
process.exit(failed ? 1 : 0);
