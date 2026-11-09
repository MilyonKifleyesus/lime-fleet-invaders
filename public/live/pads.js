// Fleet Invaders Live: joysticks plugged into the big-screen computer.
//
// Each joystick (USB, Bluetooth, 2.4 GHz dongle or arcade stick) gets one of
// eight stick slots the first time someone presses a button on it. The slot
// decides the sticker the stick wears: S1 to S8, each with its own shape and
// colour. The page reads every joystick once a frame and passes steering,
// moves (dash, shield, charge) and vibration on.
//
// Browsers only show a joystick after a button press, and only while this
// page is visible, so the game must stay full screen in front.
(function (root) {
  'use strict';

  var SLOTS = 8;
  var DEAD = 0.3; // stick movement smaller than this is ignored (worn sticks drift)
  var GRACE_MS = 10000; // an unplugged stick keeps its seat this long
  var LEFT_BUTTONS = [14, 4]; // d-pad left, left bumper
  var RIGHT_BUTTONS = [15, 5]; // d-pad right, right bumper
  var DASH_BUTTONS = [0]; // A / cross
  var SHIELD_BUTTONS = [1]; // B / circle
  var CHARGE_BUTTONS = [7, 2]; // right trigger, X / square
  var SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star', 'cross', 'hexagon', 'heart'];
  var MAP_KEY = 'fleetPadMap';

  // Moves, as bits. Phones send the same bits in their steering message.
  var MOVE = { DASH: 2, SHIELD: 4, CHARGE: 8 };

  // Button names by brand, for the screen.
  var LABELS = {
    xbox: { name: 'Xbox', dash: 'A', shield: 'B', charge: 'RT' },
    ps: { name: 'PlayStation', dash: '✕', shield: '○', charge: 'R2' },
    switch: { name: 'Switch', dash: 'B', shield: 'A', charge: 'ZR' },
    arcade: { name: 'Arcade stick', dash: '1', shield: '2', charge: '3' },
    generic: { name: 'Controller', dash: '1', shield: '2', charge: 'RT' },
  };

  // Vibration patterns: [milliseconds, heavy motor, light motor, trigger].
  // prio: a pattern does not cut off a stronger one that is still playing.
  var PATTERNS = {
    join: { prio: 3, s: [[80, 0.6, 0.3, 0], [60, 0, 0, 0], [140, 0.9, 0.5, 0]] },
    fire: { prio: 0, trig: true, s: [[30, 0, 0.15, 0.55]] },
    kill: { prio: 1, s: [[35, 0, 0.35, 0]] },
    hit: { prio: 4, s: [[150, 1, 0.6, 0], [120, 0.3, 0.1, 0]] },
    low: { prio: 1, s: [[90, 0, 0.5, 0], [160, 0, 0, 0], [90, 0, 0.35, 0]] },
    wreck: { prio: 5, s: [[200, 1, 1, 0], [200, 0.7, 0.6, 0], [200, 0.4, 0.3, 0], [200, 0.2, 0.1, 0]] },
    back: { prio: 3, s: [[70, 0.2, 0.2, 0], [60, 0, 0, 0], [70, 0.5, 0.4, 0], [60, 0, 0, 0], [110, 0.9, 0.6, 0]] },
    power: { prio: 2, s: [[40, 0, 0.3, 0], [30, 0, 0.6, 0], [40, 0, 0.9, 0], [30, 0, 0.6, 0], [40, 0, 0.3, 0]] },
    wave: { prio: 2, s: [[60, 0.4, 0.3, 0], [70, 0, 0, 0], [60, 0.4, 0.3, 0], [70, 0, 0, 0], [120, 0.7, 0.5, 0]] },
    boss: { prio: 3, s: [[300, 0.5, 0, 0], [100, 0.2, 0, 0], [300, 0.7, 0, 0], [100, 0.2, 0, 0], [400, 1, 0.2, 0]] },
    count: { prio: 2, s: [[60, 0.3, 0.2, 0]] },
    go: { prio: 3, s: [[180, 0.8, 0.6, 0]] },
    idle: { prio: 2, s: [[120, 0.4, 0.2, 0], [200, 0, 0, 0], [120, 0.4, 0.2, 0]] },
    win: { prio: 3, s: [[80, 0.3, 0.6, 0], [40, 0, 0, 0], [80, 0.6, 0.3, 0], [40, 0, 0, 0], [80, 0.3, 0.6, 0], [40, 0, 0, 0], [220, 0.9, 0.9, 0]] },
    end: { prio: 2, s: [[160, 0.4, 0.3, 0]] },
    dash: { prio: 2, s: [[70, 0.2, 0.8, 0]] },
    shield: { prio: 2, s: [[60, 0, 0.6, 0], [40, 0, 0, 0], [120, 0.3, 0.5, 0]] },
    charged: { prio: 1, trig: true, s: [[40, 0, 0.4, 0.8]] },
    bigshot: { prio: 3, trig: true, s: [[120, 1, 0.4, 1]] },
    test: { prio: 5, s: [[200, 1, 0, 0], [100, 0, 0, 0], [200, 0, 1, 0]] },
  };

  function pressed(b) {
    if (!b) return false;
    if (typeof b === 'object') return !!b.pressed || b.value > 0.5;
    return b > 0.5;
  }
  function anyPressed(buttons, list) {
    for (var i = 0; i < list.length; i++) if (pressed(buttons[list[i]])) return true;
    return false;
  }

  // Which kind of controller this is, from the name the browser gives it.
  function brand(gp) {
    var id = String((gp && gp.id) || '').toLowerCase();
    if (/054c|dualsense|dualshock|playstation|wireless controller \(standard/.test(id)) return 'ps';
    if (/057e|nintendo|pro controller|joy-con/.test(id)) return 'switch';
    if (/xbox|xinput|045e|x-box/.test(id)) return 'xbox';
    if (gp && gp.mapping !== 'standard') return 'arcade';
    return 'generic';
  }
  // Windows reads at most 4 Xbox-style (XInput) pads.
  function isXInput(gp) {
    return /xinput/i.test(String((gp && gp.id) || ''));
  }

  function loadMaps() {
    try { return JSON.parse(root.localStorage.getItem(MAP_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveMaps(m) {
    try { root.localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch (e) { /* storage blocked */ }
  }

  // Reads a direction or a button from a saved arcade-stick layout.
  function readMapped(gp, part) {
    if (!part) return 0;
    if (part.type === 'axis') {
      var v = Number((gp.axes || [])[part.i]) || 0;
      return v * part.sign > 0.5 ? 1 : 0;
    }
    return pressed((gp.buttons || [])[part.i]) ? 1 : 0;
  }

  // Steering from one joystick, from -1 (left) to 1 (right).
  function steer(gp, map) {
    var b = gp.buttons || [];
    if (map && map.left && map.right) {
      var l = readMapped(gp, map.left), r = readMapped(gp, map.right);
      return l === r ? 0 : l ? -1 : 1;
    }
    var x = 0;
    var axes = gp.axes || [];
    if (axes.length) {
      x = Number(axes[0]) || 0;
      if (Math.abs(x) < DEAD) x = 0;
      else x = (x - (x > 0 ? DEAD : -DEAD)) / (1 - DEAD); // full range after the dead zone
    }
    var left = anyPressed(b, LEFT_BUTTONS);
    var right = anyPressed(b, RIGHT_BUTTONS);
    if (left !== right) x = left ? -1 : 1;
    return Math.max(-1, Math.min(1, x));
  }

  // Moves held right now, as MOVE bits.
  function moves(gp, map) {
    var b = gp.buttons || [];
    var m = 0;
    if (map && (map.dash || map.shield || map.charge)) {
      if (readMapped(gp, map.dash)) m |= MOVE.DASH;
      if (readMapped(gp, map.shield)) m |= MOVE.SHIELD;
      if (readMapped(gp, map.charge)) m |= MOVE.CHARGE;
      return m;
    }
    if (anyPressed(b, DASH_BUTTONS)) m |= MOVE.DASH;
    if (anyPressed(b, SHIELD_BUTTONS)) m |= MOVE.SHIELD;
    if (anyPressed(b, CHARGE_BUTTONS) || (b[7] && b[7].value > 0.3)) m |= MOVE.CHARGE;
    return m;
  }

  function Pads(opts) {
    this.opts = opts || {};
    this.graceMs = this.opts.graceMs || GRACE_MS;
    this.slots = new Array(SLOTS).fill(null); // slot -> { index, x, moves, active, grace }
    this.byIndex = new Map(); // joystick number -> slot
    this.held = new Map(); // joystick number -> buttons held at the last read
    this.seen = 0; // joysticks the browser showed at the last read
    this.pads = new Map(); // joystick number -> the last Gamepad object
    this.maps = loadMaps(); // saved arcade-stick layouts, by controller name
    this.fx = new Array(SLOTS).fill(null); // slot -> the vibration playing
  }

  Pads.SLOTS = SLOTS;
  Pads.SHAPES = SHAPES;
  Pads.MOVE = MOVE;
  Pads.LABELS = LABELS;
  Pads.PATTERNS = PATTERNS;
  Pads.steer = steer;
  Pads.moves = moves;
  Pads.brand = brand;
  Pads.isXInput = isXInput;

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

  // The slot waiting longest for its unplugged stick, or -1.
  Pads.prototype.graceSlot = function () {
    var best = -1;
    for (var i = 0; i < SLOTS; i++) {
      var st = this.slots[i];
      if (st && st.grace && (best < 0 || st.grace < this.slots[best].grace)) best = i;
    }
    return best;
  };

  Pads.prototype.mapFor = function (gp) {
    return gp && this.maps[gp.id] ? this.maps[gp.id] : null;
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
      var map = this.mapFor(gp);
      if (map && !fresh) {
        // Arcade boards that steer with buttons: a new push also counts.
        fresh = ['left', 'right'].some(function (k) {
          var p = map[k];
          return p && p.type === 'axis' && readMapped(gp, p) && !(self.held.get('a' + idx + k));
        });
      }
      if (map) ['left', 'right'].forEach(function (k) { self.held.set('a' + idx + k, readMapped(gp, map[k])); });
      this.held.set(idx, down);
      var x = steer(gp, map);
      var mv = moves(gp, map);
      var slot = this.byIndex.get(idx);
      if (slot === undefined) {
        // A new press joins. Holding a button from before does not.
        if (!fresh) continue;
        if (this.opts.canJoin && !this.opts.canJoin()) continue;
        // A stick plugged back in takes back the seat that was waiting for it.
        var g = this.graceSlot();
        if (g >= 0) {
          var gs = this.slots[g];
          gs.index = idx;
          gs.grace = 0;
          gs.active = now;
          gs.moves = 0;
          gs.mask = mv; // a button held while plugging back in is not a move
          this.byIndex.set(idx, g);
          if (this.opts.onResume) this.opts.onResume(g, gp);
          continue;
        }
        var s = this.freeSlot();
        if (s < 0) continue;
        this.byIndex.set(idx, s);
        // The press that joins is not also a move: it is ignored until let go.
        this.slots[s] = { index: idx, x: 0, moves: 0, mask: mv, active: now, grace: 0 };
        if (this.opts.onJoin) this.opts.onJoin(s, gp);
        continue;
      }
      var st = this.slots[slot];
      if (!st) continue;
      var active = fresh || x !== 0;
      if (active) st.active = now;
      st.x = x;
      if (st.mask) { st.mask &= mv; mv &= ~st.mask; }
      st.moves = mv;
      if (this.opts.onInput) this.opts.onInput(slot, x, active, mv);
    }
    this.seen = present.size;
    this.byIndex.forEach(function (slot, idx) {
      if (present.has(idx)) return;
      self.byIndex.delete(idx);
      self.held.delete(idx);
      var st = self.slots[slot];
      if (!st) return;
      // Unplugged: keep the seat for a few seconds in case it was an accident.
      st.index = null;
      st.grace = now + self.graceMs;
      st.x = 0;
      st.moves = 0;
      self.stop(slot);
      if (self.opts.onPause) self.opts.onPause(slot);
    });
    for (var k = 0; k < SLOTS; k++) {
      var w = this.slots[k];
      if (w && w.grace && now >= w.grace) {
        this.slots[k] = null;
        if (this.opts.onGone) this.opts.onGone(k);
      }
    }
    this.pads.forEach(function (p, idx) { if (!present.has(idx)) self.pads.delete(idx); });
  };

  // Frees a slot. The joystick joins again, as a new player, on its next press.
  Pads.prototype.release = function (slot) {
    var st = this.slots[slot];
    if (!st) return;
    this.stop(slot);
    this.slots[slot] = null;
    if (st.index !== null && this.byIndex.get(st.index) === slot) this.byIndex.delete(st.index);
  };

  Pads.prototype.releaseAll = function () {
    for (var i = 0; i < SLOTS; i++) this.release(i);
  };

  Pads.prototype.gamepad = function (slot) {
    var st = this.slots[slot];
    return st && st.index !== null ? this.pads.get(st.index) || null : null;
  };

  Pads.prototype.brandOf = function (slot) {
    return brand(this.gamepad(slot));
  };

  Pads.prototype.labelsOf = function (slot) {
    return LABELS[this.brandOf(slot)] || LABELS.generic;
  };

  // ---------------------------------------------------------------- vibration

  function actuatorOf(gp) {
    var act = gp && gp.vibrationActuator;
    return act && act.playEffect ? act : null;
  }
  function canTrigger(act) {
    return !!(act && act.effects && act.effects.indexOf && act.effects.indexOf('trigger-rumble') >= 0);
  }

  // Plays a pattern by name on one stick. side: -1 hit from the left, 1 from
  // the right (the heavy motor sits on the left, the light one on the right).
  Pads.prototype.play = function (slot, name, side) {
    var p = PATTERNS[name];
    var gp = this.gamepad(slot);
    var act = actuatorOf(gp);
    if (!p || !act) return false;
    if (p.trig && !canTrigger(act)) return false; // trigger-only patterns need impulse triggers
    var cur = this.fx[slot];
    var now = Date.now();
    if (cur && cur.until > now && cur.prio > p.prio) return false;
    this.stop(slot, true);
    var timers = [];
    var t = 0;
    var self = this;
    p.s.forEach(function (sg) {
      var strong = sg[1], weak = sg[2];
      if (side < 0) { strong = Math.min(1, strong * 1.15); weak *= 0.55; }
      else if (side > 0) { weak = Math.min(1, weak + strong * 0.5); strong *= 0.55; }
      if (strong || weak || sg[3]) {
        timers.push(setTimeout(function () { self.effect(act, sg[0], strong, weak, sg[3]); }, t));
      }
      t += sg[0];
    });
    this.fx[slot] = { timers: timers, until: now + t, prio: p.prio, act: act };
    return true;
  };

  Pads.prototype.effect = function (act, ms, strong, weak, trig) {
    try {
      var r;
      if (trig && canTrigger(act)) {
        r = act.playEffect('trigger-rumble', {
          duration: ms, strongMagnitude: strong, weakMagnitude: weak, leftTrigger: 0, rightTrigger: trig,
        });
      } else {
        r = act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak });
      }
      if (r && r.catch) r.catch(function () { /* not supported or page hidden */ });
    } catch (e) { /* not supported */ }
  };

  Pads.prototype.stop = function (slot, keepMotor) {
    var cur = this.fx[slot];
    if (!cur) return;
    cur.timers.forEach(clearTimeout);
    this.fx[slot] = null;
    if (!keepMotor && cur.act && cur.act.reset) {
      try { var r = cur.act.reset(); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ }
    }
  };

  // Kept for older callers: a short buzz.
  Pads.prototype.rumble = function (slot) {
    return this.play(slot, 'join');
  };

  // ---------------------------------------------------------------- arcade stick setup

  // Saves a layout for every controller with this name.
  Pads.prototype.saveMap = function (id, map) {
    if (map) this.maps[id] = map;
    else delete this.maps[id];
    saveMaps(this.maps);
  };

  // What a controller is doing now, for the setup steps: the strongest axis
  // push, or a newly pressed button, compared with a resting snapshot.
  Pads.snapshot = function (gp) {
    return {
      axes: (gp.axes || []).map(Number),
      buttons: (gp.buttons || []).map(function (b) { return pressed(b); }),
    };
  };
  Pads.detect = function (gp, rest) {
    var axes = gp.axes || [];
    var best = null;
    for (var i = 0; i < axes.length; i++) {
      var d = (Number(axes[i]) || 0) - ((rest && rest.axes[i]) || 0);
      if (Math.abs(d) > 0.6 && (!best || Math.abs(d) > best.mag)) best = { type: 'axis', i: i, sign: d > 0 ? 1 : -1, mag: Math.abs(d) };
    }
    if (best) return { type: 'axis', i: best.i, sign: best.sign };
    var buttons = gp.buttons || [];
    for (var j = 0; j < buttons.length; j++) {
      if (pressed(buttons[j]) && !(rest && rest.buttons[j])) return { type: 'btn', i: j };
    }
    return null;
  };

  root.FleetPads = Pads;
})(typeof window !== 'undefined' ? window : globalThis);
