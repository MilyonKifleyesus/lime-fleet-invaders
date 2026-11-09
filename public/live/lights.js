// Fleet Invaders Live: controller lights and push-back triggers.
//
// PlayStation 5 pads (DualSense): light bar colour, player number lights and
// adaptive triggers. PlayStation 4 pads: light bar colour. Switch Pro: player
// number lights. Xbox lights can't be set from a web page.
//
// This uses WebHID (Chrome and Edge). The host approves each controller once,
// from the joystick check screen (J on the big screen); the browser remembers
// it, so later the lights connect by themselves.
//
// A light only follows a stick once it knows which pad is which: when someone
// presses a button to join, the pad whose own buttons went down at that moment
// is the one.
(function (root) {
  'use strict';

  var SONY = 0x054c, NINTENDO = 0x057e;
  var KINDS = {
    0x0ce6: 'ds5', 0x0df2: 'ds5', // DualSense, DualSense Edge
    0x05c4: 'ds4', 0x09cc: 'ds4', 0x0ba0: 'ds4', // DualShock 4 (both versions, USB dongle)
    0x2009: 'switch', // Switch Pro
  };
  var FILTERS = [
    { vendorId: SONY, productId: 0x0ce6 }, { vendorId: SONY, productId: 0x0df2 },
    { vendorId: SONY, productId: 0x05c4 }, { vendorId: SONY, productId: 0x09cc }, { vendorId: SONY, productId: 0x0ba0 },
    { vendorId: NINTENDO, productId: 0x2009 },
  ];
  var SEND_MS = 50; // at most 20 reports a second per controller
  var MATCH_MS = 400; // a join press and the pad's own press must be this close

  // Player number lights. DualSense has 5 under the touch pad; Switch has 4.
  var DS5_PLAYER = [0, 0x04, 0x0a, 0x15, 0x1b, 0x1f, 0x11, 0x0e, 0x1b];
  var SWITCH_PLAYER = [0, 0x01, 0x03, 0x07, 0x0f, 0x09, 0x0a, 0x0b, 0x05];

  // Trigger feel on the DualSense right trigger: mode byte, then settings.
  // Needs testing on real pads; 'off' always returns it to normal.
  var TRIGGERS = {
    off: [0x00],
    blaster: [0x02, 0x40, 0xa0, 0xff], // a firm section part-way down, like a trigger break
    charge: function (n) { return [0x01, 0x10, Math.round(60 + 195 * Math.max(0, Math.min(1, n)))]; }, // stiffer as it charges
    loose: [0x00],
  };

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // Bluetooth reports end with a CRC of [0xA2, report id, data...].
  function signBt(reportId, data) {
    var all = new Uint8Array(data.length - 4 + 2);
    all[0] = 0xa2;
    all[1] = reportId;
    all.set(data.subarray(0, data.length - 4), 2);
    var c = crc32(all);
    var n = data.length;
    data[n - 4] = c & 0xff;
    data[n - 3] = (c >>> 8) & 0xff;
    data[n - 2] = (c >>> 16) & 0xff;
    data[n - 1] = (c >>> 24) & 0xff;
    return data;
  }

  function hex(c) {
    var m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return [0, 0, 0];
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // ---------------------------------------------------------------- reports

  // DualSense output report, without the report id (47 bytes common part).
  function ds5Common(st, first) {
    var d = new Uint8Array(47);
    d[0] = 0x04 | 0x08; // right and left trigger effects
    d[1] = 0x04 | 0x10; // light bar colour, player number lights
    var trig = st.trigger || TRIGGERS.off;
    for (var i = 0; i < trig.length && i < 11; i++) d[10 + i] = trig[i]; // right trigger
    d[21] = 0x00; // left trigger: normal
    if (first) {
      d[38] = 0x02; // light bar setup: stop the pad's own blue glow once
      d[41] = 0x02;
    }
    d[42] = 0x00; // player lights at full brightness
    d[43] = DS5_PLAYER[st.player || 0] || 0;
    d[44] = st.rgb[0]; d[45] = st.rgb[1]; d[46] = st.rgb[2];
    return d;
  }
  function ds5Report(dev, st, first) {
    var common = ds5Common(st, first);
    if (!dev.bt) return { id: 0x02, data: common };
    var d = new Uint8Array(77);
    dev.seq = (dev.seq + 1) & 15;
    d[0] = dev.seq << 4;
    d[1] = 0x10;
    d.set(common, 2);
    return { id: 0x31, data: signBt(0x31, d) };
  }

  // DualShock 4: colour only (rumble stays with the browser).
  function ds4Report(dev, st) {
    var common = new Uint8Array(9);
    common[0] = 0x02; // light bar only
    common[5] = st.rgb[0]; common[6] = st.rgb[1]; common[7] = st.rgb[2];
    if (!dev.bt) {
      var u = new Uint8Array(31);
      u.set(common, 0);
      return { id: 0x05, data: u };
    }
    var d = new Uint8Array(77);
    d[0] = 0xc0; // CRC and HID
    d[1] = 0x00;
    d.set(common, 2);
    return { id: 0x11, data: signBt(0x11, d) };
  }

  // Switch Pro: player lights through sub-command 0x30.
  function switchReport(dev, st) {
    var d = new Uint8Array(48);
    dev.seq = (dev.seq + 1) & 15;
    d[0] = dev.seq;
    d.set([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40], 1); // neutral rumble
    d[9] = 0x30;
    d[10] = SWITCH_PLAYER[st.player || 0] || 0;
    return { id: 0x01, data: d };
  }

  // Did this input report show a button held down? (offsets per pad and link)
  function buttonsDown(dev, reportId, data) {
    var v = function (i) { return i < data.byteLength ? data.getUint8(i) : 0; };
    if (dev.kind === 'ds5') {
      if (reportId === 0x31) dev.bt = true;
      else if (reportId === 0x01 && data.byteLength >= 60) dev.bt = false;
      var o = reportId === 0x31 ? 8 : 7;
      if (reportId === 0x01 && data.byteLength < 60) o = 4; // Bluetooth simple report
      return (v(o) >> 4) !== 0 || (v(o) & 0x0f) !== 8 || v(o + 1) !== 0 || (v(o + 2) & 0x03) !== 0;
    }
    if (dev.kind === 'ds4') {
      if (reportId === 0x11) dev.bt = true;
      else if (reportId === 0x01 && data.byteLength >= 60) dev.bt = false;
      var p = reportId === 0x11 ? 6 : 4;
      return (v(p) >> 4) !== 0 || (v(p) & 0x0f) !== 8 || v(p + 1) !== 0 || (v(p + 2) & 0x03) !== 0;
    }
    if (dev.kind === 'switch') {
      if (reportId === 0x30) return v(2) !== 0 || (v(3) & 0xfe) !== 0 || v(4) !== 0;
      if (reportId === 0x3f) return v(0) !== 0 || v(1) !== 0 || (v(2) & 0x0f) !== 8;
    }
    return false;
  }

  // ---------------------------------------------------------------- the manager

  function Lights(opts) {
    this.opts = opts || {};
    this.hid = this.opts.hid || (root.navigator && root.navigator.hid) || null;
    this.supported = !!(this.hid && this.hid.requestDevice);
    this.devs = []; // { dev, kind, bt, slot, pressAt, down, st, sent, sentAt, seq, first }
    this.now = this.opts.now || function () { return (root.performance || Date).now(); };
  }

  Lights.KINDS = KINDS;
  Lights.crc32 = crc32;
  Lights.TRIGGERS = TRIGGERS;
  Lights.reports = { ds5: ds5Report, ds4: ds4Report, switch: switchReport };

  // Opens controllers approved before. Call once at start.
  Lights.prototype.start = function () {
    if (!this.supported) return Promise.resolve(0);
    var self = this;
    if (this.hid.addEventListener) {
      this.hid.addEventListener('disconnect', function (e) { self.forget(e.device); });
      this.hid.addEventListener('connect', function (e) { self.add(e.device); });
    }
    return this.hid.getDevices().then(function (list) {
      return Promise.all(list.map(function (d) { return self.add(d); }));
    }).then(function () { return self.devs.length; }).catch(function () { return 0; });
  };

  // Asks the host to approve controllers. Must run from a click.
  Lights.prototype.connect = function () {
    if (!this.supported) return Promise.resolve(0);
    var self = this;
    return this.hid.requestDevice({ filters: FILTERS }).then(function (list) {
      return Promise.all((list || []).map(function (d) { return self.add(d); }));
    }).then(function () { return self.devs.length; });
  };

  Lights.prototype.add = function (dev) {
    var kind = dev && dev.vendorId && KINDS[dev.productId];
    if (!kind || this.devs.some(function (x) { return x.dev === dev; })) return Promise.resolve();
    var rec = {
      dev: dev, kind: kind, bt: false, slot: null, pressAt: 0, down: false,
      st: { rgb: [0, 0, 0], player: 0, trigger: TRIGGERS.off }, sent: '', sentAt: 0, seq: 0, first: true,
    };
    var self = this;
    var opened = dev.opened ? Promise.resolve() : dev.open();
    return opened.then(function () {
      self.devs.push(rec);
      dev.addEventListener('inputreport', function (e) {
        var down = buttonsDown(rec, e.reportId, e.data);
        if (down && !rec.down) rec.pressAt = self.now();
        rec.down = down;
      });
      self.idle(rec);
    }).catch(function () { /* in use or refused */ });
  };

  Lights.prototype.forget = function (dev) {
    this.devs = this.devs.filter(function (x) { return x.dev !== dev; });
  };

  // A stick just joined in this slot: find which approved pad it is.
  // sameKind: how many joysticks of this model the browser sees right now.
  Lights.prototype.claim = function (slot, gamepadId, sameKind) {
    var t = this.now();
    var m = /vendor:\s*([0-9a-f]{4}).*product:\s*([0-9a-f]{4})/i.exec(String(gamepadId || ''));
    var want = m ? parseInt(m[2], 16) : null;
    var free = this.devs.filter(function (x) {
      return x.slot === null && (want === null || x.dev.productId === want || KINDS[want] === x.kind);
    });
    if (!free.length) return false;
    var recent = free.filter(function (x) { return t - x.pressAt < MATCH_MS; })
      .sort(function (a, b) { return b.pressAt - a.pressAt; });
    // Without a matching press, only guess when this is the one pad of its model.
    var pick = recent[0] || (free.length === 1 && sameKind === 1 ? free[0] : null);
    if (!pick) return false;
    this.release(slot);
    pick.slot = slot;
    return true;
  };

  Lights.prototype.release = function (slot) {
    var self = this;
    this.devs.forEach(function (x) { if (x.slot === slot) { x.slot = null; self.idle(x); } });
  };

  Lights.prototype.has = function (slot) {
    return this.devs.some(function (x) { return x.slot === slot; });
  };

  // A pad with no player: a soft white, no player lights, triggers normal.
  Lights.prototype.idle = function (rec) {
    rec.st = { rgb: [40, 46, 36], player: 0, trigger: TRIGGERS.off };
    this.flush(rec, true);
  };

  // Sets what one stick's pad shows. color: '#rrggbb'; player: 1-8;
  // trigger: 'off' | 'blaster' | 'loose' | ['charge', 0..1]
  Lights.prototype.set = function (slot, color, player, trigger) {
    for (var i = 0; i < this.devs.length; i++) {
      var x = this.devs[i];
      if (x.slot !== slot) continue;
      var trig = TRIGGERS.off;
      if (Array.isArray(trigger)) trig = TRIGGERS.charge(trigger[1]);
      else if (trigger && TRIGGERS[trigger]) trig = TRIGGERS[trigger];
      x.st = { rgb: hex(color), player: player || 0, trigger: trig };
      this.flush(x, false);
    }
  };

  Lights.prototype.flush = function (rec, force) {
    var key = rec.st.rgb.join(',') + '|' + rec.st.player + '|' + rec.st.trigger.join(',');
    var t = this.now();
    if (!force && (key === rec.sent || t - rec.sentAt < SEND_MS)) return;
    var build = Lights.reports[rec.kind];
    if (!build) return;
    var r = build(rec, rec.st, rec.first);
    if (rec.kind === 'ds4' || rec.kind === 'switch') {
      if (rec.kind === 'switch' && rec.sent.split('|')[1] === String(rec.st.player) && !force) { rec.sent = key; return; }
    }
    rec.first = false;
    rec.sent = key;
    rec.sentAt = t;
    try {
      var p = rec.dev.sendReport(r.id, r.data);
      if (p && p.catch) p.catch(function () { /* unplugged */ });
    } catch (e) { /* unplugged */ }
  };

  Lights.prototype.list = function () {
    return this.devs.map(function (x) {
      return { kind: x.kind, name: x.dev.productName || x.kind, slot: x.slot, bt: x.bt };
    });
  };

  root.FleetLights = Lights;
})(typeof window !== 'undefined' ? window : globalThis);
