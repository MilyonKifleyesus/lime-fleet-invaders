// Checks for public/live/pads.js, which reads joysticks on the big screen.
// Uses pretend joysticks, so it needs no browser and no server.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', '..', 'public', 'live', 'pads.js');
vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
const Pads = globalThis.FleetPads;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  pass  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + ' :: ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A pretend joystick in the browser's Gamepad shape.
function pad(index, opts = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  return {
    index, id: opts.id || 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons,
    press(i, on = true) { buttons[i] = { pressed: on, value: on ? 1 : 0 }; },
    stick(x) { this.axes[0] = x; },
    vibrationActuator: opts.rumble ? { calls: [], playEffect(type, p) { this.calls.push([type, p]); return Promise.resolve('complete'); } } : undefined,
  };
}

function rig(canJoin = () => true) {
  const list = [];
  const ev = { joins: [], inputs: [], gone: [] };
  const p = new Pads({
    getPads: () => list,
    canJoin,
    onJoin: (slot, gp) => ev.joins.push([slot, gp.index]),
    onInput: (slot, x, active) => ev.inputs.push([slot, x, active]),
    onGone: slot => ev.gone.push(slot),
  });
  return { p, list, ev };
}

check('a plugged-in joystick does not join until a button is pressed', () => {
  const { p, list, ev } = rig();
  list[0] = pad(0);
  p.poll(0);
  assert(ev.joins.length === 0, 'joined without a press');
  assert(p.seen === 1, 'seen ' + p.seen);
});

check('the first press joins in slot 1, the next joystick in slot 2', () => {
  const { p, list, ev } = rig();
  list[0] = pad(0); list[1] = pad(1);
  list[0].press(0); p.poll(0);
  list[1].press(3); p.poll(16);
  assert(JSON.stringify(ev.joins) === '[[0,0],[1,1]]', JSON.stringify(ev.joins));
});

check('a button held since before does not join', () => {
  const { p, list, ev } = rig(() => false);
  list[0] = pad(0);
  list[0].press(0); p.poll(0); // joining is off at this moment
  const r = rig();
  r.list[0] = list[0];
  r.p.held = p.held; // same history: the button was already down
  r.p.poll(16);
  assert(r.ev.joins.length === 0, 'a held button joined');
  list[0].press(0, false); r.p.poll(32);
  list[0].press(0); r.p.poll(48);
  assert(r.ev.joins.length === 1, 'a fresh press should join');
});

check('the stick steers with a dead zone and full range', () => {
  const { p, list, ev } = rig();
  list[0] = pad(0);
  list[0].press(0); p.poll(0); list[0].press(0, false);
  list[0].stick(0.2); p.poll(16);
  list[0].stick(-1); p.poll(32);
  list[0].stick(0.65); p.poll(48);
  const xs = ev.inputs.map(i => Math.round(i[1] * 100) / 100);
  assert(xs[0] === 0 && xs[1] === -1 && xs[2] === 0.5, xs.join(','));
  assert(ev.inputs[0][2] === false && ev.inputs[1][2] === true, 'a drifting stick should not count as active');
});

check('the d-pad, bumpers and face buttons steer too', () => {
  for (const [btn, want] of [[14, -1], [15, 1], [4, -1], [5, 1], [2, -1], [1, 1]]) {
    const gp = pad(0);
    gp.press(btn);
    assert(Pads.steer(gp) === want, 'button ' + btn + ' gave ' + Pads.steer(gp));
  }
});

check('arcade sticks that report the stick on axis 0 without a standard layout work', () => {
  const { p, list, ev } = rig();
  const gp = pad(0, { id: 'Generic USB Joystick (Vendor: 0079 Product: 0006)' });
  gp.mapping = '';
  gp.buttons.length = 10;
  gp.axes = [-1, 0];
  list[0] = gp;
  gp.press(2); p.poll(0);
  p.poll(16);
  assert(ev.joins.length === 1 && ev.inputs.at(-1)[1] === -1, JSON.stringify(ev));
});

check('unplugging frees the slot and reports it', () => {
  const { p, list, ev } = rig();
  list[0] = pad(0);
  list[0].press(0); p.poll(0);
  list[0] = null;
  p.poll(16);
  assert(JSON.stringify(ev.gone) === '[0]' && p.taken() === 0 && p.seen === 0, JSON.stringify(ev.gone));
});

check('a released slot needs a new press, and gets the lowest free slot', () => {
  const { p, list, ev } = rig();
  list[0] = pad(0); list[1] = pad(1);
  list[0].press(0); list[1].press(0); p.poll(0);
  p.release(0); // the player walked away
  p.poll(16); // still holding A: no rejoin
  assert(ev.joins.length === 2, 'rejoined while held');
  list[0].press(0, false); p.poll(32);
  list[0].press(0); p.poll(48);
  assert(JSON.stringify(ev.joins.at(-1)) === '[0,0]', JSON.stringify(ev.joins));
});

check('a ninth joystick waits until a slot frees', () => {
  const { p, list, ev } = rig();
  for (let i = 0; i < 9; i++) { list[i] = pad(i); list[i].press(0); }
  p.poll(0);
  assert(ev.joins.length === 8 && p.taken() === 8, 'joins ' + ev.joins.length);
  p.release(4);
  list[8].press(0, false); p.poll(16);
  list[8].press(0); p.poll(32);
  assert(JSON.stringify(ev.joins.at(-1)) === '[4,8]', JSON.stringify(ev.joins.at(-1)));
});

check('joining can be switched off', () => {
  let on = false;
  const { p, list, ev } = rig(() => on);
  list[0] = pad(0);
  list[0].press(0); p.poll(0);
  assert(ev.joins.length === 0, 'joined while off');
  on = true;
  list[0].press(0, false); p.poll(16);
  list[0].press(0); p.poll(32);
  assert(ev.joins.length === 1, 'did not join once on');
});

check('rumble plays on joysticks that can, and is skipped on others', () => {
  const { p, list } = rig();
  list[0] = pad(0, { rumble: true }); list[1] = pad(1);
  list[0].press(0); list[1].press(0); p.poll(0);
  p.rumble(0, 180, 0.7);
  p.rumble(1, 180, 0.7);
  assert(list[0].vibrationActuator.calls.length === 1 && list[0].vibrationActuator.calls[0][0] === 'dual-rumble', 'no rumble');
});

check('a browser that throws when reading joysticks is ignored', () => {
  const p = new Pads({ getPads: () => { throw new Error('blocked'); } });
  p.poll(0);
  assert(p.seen === 0, 'seen');
});

console.log(`\n${passed} of ${passed + failed} joystick reading checks passed`);
process.exit(failed ? 1 : 0);
