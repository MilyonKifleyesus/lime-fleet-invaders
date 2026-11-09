// Fleet Invaders Live: joysticks plugged into the big-screen computer.
//
// Each joystick (USB, Bluetooth, 2.4 GHz dongle or arcade stick) gets one of
// eight stick slots the first time someone presses a button on it. The slot
// decides the sticker the stick wears: S1 to S8, each with its own shape and
// colour. The page reads every joystick once a frame and passes steering on.
//
// Browsers only show a joystick after a button press, and only while this
// page is visible, so the game must stay full screen in front.
(function (root) {
  'use strict';

  var SLOTS = 8;
  var DEAD = 0.3; // stick movement smaller than this is ignored (worn sticks drift)
  var LEFT_BUTTONS = [14, 4, 2]; // d-pad left, left bumper, X / square
  var RIGHT_BUTTONS = [15, 5, 1]; // d-pad right, right bumper, B / circle
  var SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'hexagon', 'heart'];

  function pressed(b) {
    if (!b) return false;
    if (typeof b === 'object') return !!b.pressed || b.value > 0.5;
    return b > 0.5;
  }

  // Steering from one joystick, from -1 (left) to 1 (right).
  function steer(gp) {
    var b = gp.buttons || [];
    var x = 0;
    var axes = gp.axes || [];
    if (axes.length) {
      x = Number(axes[0]) || 0;
      if (Math.abs(x) < DEAD) x = 0;
      else x = (x - (x > 0 ? DEAD : -DEAD)) / (1 - DEAD); // full range after the dead zone
    }
    var left = LEFT_BUTTONS.some(function (i) { return pressed(b[i]); });
    var right = RIGHT_BUTTONS.some(function (i) { return pressed(b[i]); });
    if (left !== right) x = left ? -1 : 1;
    return Math.max(-1, Math.min(1, x));
  }

  function Pads(opts) {
    this.opts = opts || {};
    this.slots = new Array(SLOTS).fill(null); // slot -> { index, x, active }
    this.byIndex = new Map(); // joystick number -> slot
    this.held = new Map(); // joystick number -> buttons held at the last read
    this.seen = 0; // joysticks the browser showed at the last read
    this.pads = new Map(); // joystick number -> the last Gamepad object, for rumble
  }

  Pads.SLOTS = SLOTS;
  Pads.SHAPES = SHAPES;
  Pads.steer = steer;

  Pads.prototype.read = function () {
    try {
      if (this.opts.getPads) return this.opts.getPads() || [];
      var nav = root.navigator;
      return nav && nav.getGamepads ? nav.getGamepads() || [] : [];
    } catch (e) {
      return [];
    }
  };

  Pads.prototype.freeSlot = function () {
    for (var i = 0; i < SLOTS; i++) if (!this.slots[i]) return i;
    return -1;
  };

  Pads.prototype.taken = function () {
    var n = 0;
    for (var i = 0; i < SLOTS; i++) if (this.slots[i]) n++;
    return n;
  };

  // Reads every joystick once. Call it from the frame loop.
  Pads.prototype.poll = function (now) {
    var list = this.read();
    var present = new Set();
    var self = this;
    for (var i = 0; i < list.length; i++) {
      var gp = list[i];
      if (!gp || gp.connected === false) continue;
      var idx = gp.index !== undefined ? gp.index : i;
      present.add(idx);
      this.pads.set(idx, gp);
      var buttons = gp.buttons || [];
      var held = this.held.get(idx) || [];
      var down = [];
      var fresh = false;
      for (var j = 0; j < buttons.length; j++) {
        if (pressed(buttons[j])) {
          down.push(j);
          if (held.indexOf(j) < 0) fresh = true;
        }
      }
      this.held.set(idx, down);
      var x = steer(gp);
      var slot = this.byIndex.get(idx);
      if (slot === undefined) {
        // A new press joins. Holding a button from before does not.
        if (!fresh) continue;
        if (this.opts.canJoin && !this.opts.canJoin()) continue;
        var s = this.freeSlot();
        if (s < 0) continue;
        this.byIndex.set(idx, s);
        this.slots[s] = { index: idx, x: 0, active: now };
        if (this.opts.onJoin) this.opts.onJoin(s, gp);
        continue;
      }
      var st = this.slots[slot];
      if (!st) continue;
      var active = fresh || x !== 0;
      if (active) st.active = now;
      st.x = x;
      if (this.opts.onInput) this.opts.onInput(slot, x, active);
    }
    this.seen = present.size;
    this.byIndex.forEach(function (slot, idx) {
      if (present.has(idx)) return;
      self.release(slot);
      self.held.delete(idx);
      if (self.opts.onGone) self.opts.onGone(slot);
    });
    this.pads.forEach(function (gp, idx) { if (!present.has(idx)) self.pads.delete(idx); });
  };

  // Frees a slot. The joystick joins again, as a new player, on its next press.
  Pads.prototype.release = function (slot) {
    var st = this.slots[slot];
    if (!st) return;
    this.slots[slot] = null;
    if (this.byIndex.get(st.index) === slot) this.byIndex.delete(st.index);
  };

  Pads.prototype.releaseAll = function () {
    for (var i = 0; i < SLOTS; i++) this.release(i);
  };

  // A short buzz, on joysticks that can.
  Pads.prototype.rumble = function (slot, ms, strength) {
    var st = this.slots[slot];
    if (!st) return;
    var gp = this.pads.get(st.index);
    var act = gp && gp.vibrationActuator;
    if (!act || !act.playEffect) return;
    try {
      var p = act.playEffect('dual-rumble', {
        duration: ms || 160, strongMagnitude: strength || 0.6, weakMagnitude: (strength || 0.6) * 0.6,
      });
      if (p && p.catch) p.catch(function () { /* not supported */ });
    } catch (e) { /* not supported */ }
  };

  root.FleetPads = Pads;
})(typeof window !== 'undefined' ? window : globalThis);
