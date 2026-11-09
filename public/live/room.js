// Fleet Invaders Live: the event room, kept by the big screen.
//
// Who is playing, which seat each driver has, the line for the next seats,
// names, session tokens and join codes all live here, in the big screen's
// browser. The switchboard at /api/live only passes messages along, and tells
// this room when a phone or host panel connects (open), speaks (text) or goes
// (gone). The room is saved in this browser and, every few seconds, in Redis
// through the switchboard, so a reload or another computer carries on.
//
// The page talks to this room exactly as it used to talk to the old relay:
// it receives roster, p, code, lock, taps, cmd, replaced and err messages and
// binary steering, and it sends to, multi, all, bench and rotate.
(function (root) {
  'use strict';

  var Names = root.FleetNames;
  var HOLD_MS = 45000; // how long a dropped driver keeps their seat
  var LINE_HOLD_MS = 180000; // how long a dropped phone keeps its place in line
  var CHECK_MS = 5000;
  var MAX_PLAYERS = 500;
  var MAX_PENDING = 600;
  var TAP_FLUSH_MS = 250;
  var JOINS_PER_MINUTE_PER_IP = 300; // generous: a whole venue can share one address
  var LOCAL_SAVE_MS = 250;
  var SERVER_SAVE_MS = 3000;
  var ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

  function randomId(length) {
    var bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
  }

  function isLocal(p) {
    return p.local !== undefined && p.local !== null;
  }

  function store() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function Room(opts) {
    this.opts = opts;
    this.codeMs = 45000;
    this.minTurnMs = 60000;
    this.meta = null;
    this.players = new Map();
    this.byToken = new Map();
    this.sockets = new Map(); // player id -> connection id
    this.cids = new Map(); // connection id -> { role: 'pend' | 'phone' | 'admin', pid, color, code }
    this.seen = new Map(); // bundle ids already handled (a handover can deliver one twice)
    this.joinsByIp = new Map();
    this.taps = 0;
    this.tappers = new Set();
    this.tapTimer = null;
    this.out = [];
    this.outTimer = null;
    this.screenQueue = [];
    this.saveTimer = null;
    this.serverSaveTimer = null;
    this.serverSavedAt = 0;
    this.codeTimer = null;
    this.stopped = false;
    this.ready = false;
    this.padCount = 0; // joysticks plugged into this computer
    this.load();
    var self = this;
    // Kept on pace in a background tab too (see LiveLink.every).
    this.checkTimer = root.LiveLink.every(CHECK_MS, function () { self.checkHolds(); self.checkCode(); });
    if (root.addEventListener) root.addEventListener('pagehide', function () { if (!self.stopped) self.saveNow(); });
    this.link = new root.LiveLink({
      url: opts.url,
      watch: true,
      keepOld: true,
      wsInit: opts.wsInit,
      onMessage: function (m) { self.onServer(m); },
      onBinary: function (b) { self.onServerBinary(b); },
      onState: function (s) { if (opts.onState) opts.onState(s); },
    });
  }

  // ---------------------------------------------------------------- saving

  Room.prototype.localKey = function () {
    return 'fleetLiveRoom:' + this.opts.room;
  };

  Room.prototype.load = function () {
    var s = null;
    var ls = store();
    try { s = ls ? JSON.parse(ls.getItem(this.localKey()) || 'null') : null; } catch (e) { s = null; }
    if (s && s.meta && s.meta.room === this.opts.room) this.apply(s);
    else {
      this.meta = {
        room: this.opts.room, seats: this.opts.seats || 16, locked: false, code: null, prev: null, codeEnds: 0,
        nextId: 1, created: Date.now(), taps: 0, v: 0,
      };
    }
  };

  Room.prototype.apply = function (s) {
    this.meta = s.meta;
    this.meta.v = this.meta.v || 0;
    // A code from an earlier session may have expired; ask for a new one.
    this.meta.codeEnds = Math.min(this.meta.codeEnds || 0, Date.now());
    this.players = new Map();
    this.byToken = new Map();
    for (var i = 0; i < (s.players || []).length; i++) {
      var p = s.players[i];
      this.players.set(p.id, p);
      if (p.token && !p.removed) this.byToken.set(p.token, p.id);
    }
    // Joystick players belong to the computer they were plugged into. After a
    // reload, or on another computer, they press a button to join again.
    this.players.forEach(function (p) {
      if (p.local !== undefined && p.local !== null && !p.removed) {
        p.removed = true;
        p.seat = null;
        p.queuedAt = null;
      }
    });
    // Phones stay connected to the switchboard while the big screen reloads,
    // so their connection ids still work.
    this.cids = new Map(s.cids || []);
    this.sockets = new Map();
    var self = this;
    this.cids.forEach(function (info, cid) {
      if (info.role === 'phone') self.sockets.set(info.pid, cid);
    });
  };

  Room.prototype.state = function () {
    return { meta: this.meta, players: Array.from(this.players.values()), cids: Array.from(this.cids.entries()) };
  };

  Room.prototype.changed = function () {
    this.meta.v++;
    var self = this;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(function () {
        self.saveTimer = null;
        var ls = store();
        try { if (ls) ls.setItem(self.localKey(), JSON.stringify(self.state())); } catch (e) { /* storage full or blocked */ }
      }, LOCAL_SAVE_MS);
    }
    if (!this.serverSaveTimer) {
      var wait = Math.max(200, this.serverSavedAt + SERVER_SAVE_MS - Date.now());
      this.serverSaveTimer = setTimeout(function () {
        self.serverSaveTimer = null;
        if (self.link.send({ t: 'save', s: self.state() })) self.serverSavedAt = Date.now();
        else self.changed();
      }, wait);
    }
  };

  // ---------------------------------------------------------------- helpers

  Room.prototype.display = function (p) {
    return p.hidden ? 'DRIVER ' + String(p.id).padStart(2, '0') : p.name;
  };

  Room.prototype.pub = function (p) {
    return {
      id: p.id, name: this.display(p), color: p.color, seat: p.seat, queued: p.queuedAt !== null,
      connected: p.connected, hidden: p.hidden, custom: p.custom, share: p.share, rounds: p.rounds,
      joinedAt: p.joinedAt, removed: p.removed, local: isLocal(p) ? p.local : null,
    };
  };

  Room.prototype.active = function () {
    var out = [];
    this.players.forEach(function (p) { if (!p.removed) out.push(p); });
    return out;
  };

  Room.prototype.line = function () {
    return this.active()
      .filter(function (p) { return p.seat === null && p.queuedAt !== null; })
      .sort(function (a, b) { return a.queuedAt - b.queuedAt; });
  };

  Room.prototype.linePos = function (p) {
    if (p.seat !== null) return 0;
    if (p.queuedAt === null) return -1;
    return this.line().indexOf(p) + 1;
  };

  // A free seat, or null. Each joystick that is plugged in and not yet driving
  // keeps one seat free for itself, so phones never take the last seats.
  Room.prototype.freeSeat = function (forStick) {
    var taken = new Set();
    var sticksDriving = 0;
    this.active().forEach(function (p) {
      if (p.seat === null) return;
      taken.add(p.seat);
      if (isLocal(p)) sticksDriving++;
    });
    if (!forStick) {
      var reserved = this.meta.padsOff ? 0 : Math.max(0, this.padCount - sticksDriving);
      if (taken.size >= this.meta.seats - reserved) return null;
    }
    for (var i = 0; i < this.meta.seats; i++) if (!taken.has(i)) return i;
    return null;
  };

  Room.prototype.pickColor = function () {
    var counts = {};
    Names.COLORS.forEach(function (c) { counts[c] = 0; });
    this.active().forEach(function (p) { if (p.connected || p.seat !== null) counts[p.color]++; });
    var min = Math.min.apply(null, Names.COLORS.map(function (c) { return counts[c]; }));
    var options = Names.COLORS.filter(function (c) { return counts[c] === min; });
    return options[Math.floor(Math.random() * options.length)];
  };

  Room.prototype.uniqueName = function (name) {
    var taken = new Set(this.active().map(function (p) { return p.name; }));
    if (!taken.has(name)) return name;
    for (var i = 2; i < 100; i++) {
      var candidate = (name.length > 13 ? name.slice(0, 13).trim() : name) + ' ' + i;
      if (!taken.has(candidate)) return candidate;
    }
    return name;
  };

  Room.prototype.count = function (role) {
    var n = 0;
    this.cids.forEach(function (info) { if (info.role === role) n++; });
    return n;
  };

  Room.prototype.snapshot = function () {
    var self = this;
    return {
      t: 'roster', room: this.meta.room, seats: this.meta.seats, locked: this.meta.locked,
      pads: !this.meta.padsOff, code: this.meta.code, ends: this.meta.codeEnds, players: this.active().map(function (p) { return self.pub(p); }),
    };
  };

  Room.prototype.welcome = function (p) {
    return {
      t: 'welcome', id: p.id, token: p.token, room: this.meta.room, name: this.display(p),
      color: p.color, seat: p.seat, line: this.linePos(p), share: p.share,
    };
  };

  Room.prototype.ipAllowed = function (ip) {
    var now = Date.now();
    var entry = this.joinsByIp.get(ip);
    if (!entry || now - entry.start > 60000) {
      this.joinsByIp.set(ip, { start: now, n: 1 });
      return true;
    }
    entry.n++;
    return entry.n <= JOINS_PER_MINUTE_PER_IP;
  };

  // ---------------------------------------------------------------- sending

  // To the page that runs the game, in order, never in the middle of a handler.
  Room.prototype.toScreen = function (msg) {
    this.screenQueue.push(msg);
    if (this.screenQueue.length > 1) return;
    var self = this;
    Promise.resolve().then(function () {
      while (self.screenQueue.length) {
        var m = self.screenQueue[0];
        try { if (self.opts.onMessage) self.opts.onMessage(m); } catch (e) { if (root.console) console.error(e); }
        self.screenQueue.shift();
      }
    });
  };

  Room.prototype.sendTo = function (cid, msg) {
    if (cid === undefined || cid === null) return;
    this.out.push([cid, msg]);
    if (this.outTimer) return;
    var self = this;
    // Sent at the end of this task, not on a timer: a background tab can hold
    // timers back for up to a minute, and phones would wait for their welcome.
    this.outTimer = true;
    Promise.resolve().then(function () { if (self.outTimer) self.flushOut(); });
  };

  Room.prototype.flushOut = function () {
    this.outTimer = null;
    if (!this.out.length) return;
    var list = this.out;
    this.out = [];
    this.link.send({ t: 'batch', l: list });
  };

  Room.prototype.closeCid = function (cid, code, why, msg) {
    this.flushOut();
    this.link.send({ t: 'close', c: cid, code: code, why: why, m: msg || null });
  };

  Room.prototype.broadcast = function (who, msg) {
    this.flushOut();
    this.link.send({ t: 'all', r: who, m: msg });
  };

  Room.prototype.toPlayer = function (id, msg) {
    var cid = this.sockets.get(id);
    if (cid !== undefined) this.sendTo(cid, msg);
  };

  Room.prototype.toAdmins = function (msg) {
    if (this.count('admin')) this.broadcast('a', msg);
  };

  Room.prototype.toHosts = function (msg) {
    this.toScreen(msg);
    this.toAdmins(msg);
  };

  Room.prototype.sendLinePositions = function () {
    var self = this;
    this.line().forEach(function (p, i) { self.toPlayer(p.id, { t: 'seat', seat: null, line: i + 1 }); });
  };

  // A seat that frees up mid-round goes straight to the next connected phone in line,
  // then everyone still waiting hears their new place.
  Room.prototype.seatFromLine = function () {
    var self = this;
    var changed = [];
    var line = this.line();
    for (var i = 0; i < line.length; i++) {
      var p = line[i];
      if (!p.connected) continue;
      var seat = this.freeSeat(isLocal(p));
      if (seat === null) continue; // a phone may wait while a stick still fits
      p.seat = seat;
      p.seatedAt = Date.now();
      p.queuedAt = null;
      changed.push(p);
    }
    if (changed.length) {
      this.changed();
      changed.forEach(function (p) {
        self.toPlayer(p.id, { t: 'seat', seat: p.seat, line: 0 });
        self.toHosts({ t: 'p', p: self.pub(p) });
      });
    }
    this.sendLinePositions();
  };

  // ---------------------------------------------------------------- codes

  // A safety net for the code timer, which a background tab can slow down:
  // ask for a new code when the current one is about to run out.
  Room.prototype.checkCode = function () {
    if (!this.ready || this.stopped) return;
    var now = Date.now();
    if (now >= (this.meta.codeEnds || 0) - 1000 && now - (this.codeAskedAt || 0) > 4000) this.requestCode();
  };

  Room.prototype.requestCode = function () {
    clearTimeout(this.codeTimer);
    var self = this;
    this.codeAskedAt = Date.now();
    this.link.send({ t: 'code' });
    // If the answer does not come, ask again.
    this.codeTimer = setTimeout(function () { self.requestCode(); }, 5000);
  };

  Room.prototype.onCode = function (code) {
    clearTimeout(this.codeTimer);
    var self = this;
    // Timed on this computer's clock, which the page uses for the countdown.
    var ends = Date.now() + this.codeMs;
    this.meta.prev = this.meta.code;
    this.meta.code = code;
    this.meta.codeEnds = ends;
    this.changed();
    this.toHosts({ t: 'code', code: code, ends: ends });
    this.codeTimer = setTimeout(function () { self.requestCode(); }, Math.max(1000, this.codeMs - 300));
  };

  // ---------------------------------------------------------------- from the switchboard

  Room.prototype.onServer = function (m) {
    if (this.stopped) return;
    switch (m.t) {
      case 'ready': return this.onReady(m);
      case 'up': return this.onUp(m);
      case 'code': return this.onCode(m.code);
      case 'replaced':
        this.stop();
        this.toScreen({ t: 'replaced' });
        return;
      case 'err':
        if (m.why === 'key' || m.why === 'room') this.stop();
        this.toScreen({ t: 'err', why: m.why });
        return;
      default:
    }
  };

  Room.prototype.onReady = function (m) {
    this.codeMs = m.codeMs || this.codeMs;
    this.minTurnMs = m.minTurnMs !== undefined ? m.minTurnMs : this.minTurnMs;
    var s = m.state;
    if (!this.ready && s && s.meta && s.meta.room === this.meta.room && (s.meta.v || 0) > (this.meta.v || 0)) {
      this.apply(s);
    }
    if (!this.ready && this.meta.v === 0 && m.seats) this.meta.seats = m.seats;
    this.ready = true;
    this.toHosts(this.snapshot());
    if (!this.meta.code || Date.now() >= this.meta.codeEnds - 500) this.requestCode();
    else {
      var self = this;
      clearTimeout(this.codeTimer);
      this.codeTimer = setTimeout(function () { self.requestCode(); }, this.meta.codeEnds - 300 - Date.now());
    }
    this.changed();
  };

  Room.prototype.onUp = function (m) {
    if (m.n) {
      if (this.seen.has(m.n)) return;
      var now = Date.now();
      this.seen.set(m.n, now);
      if (this.seen.size > 2000) {
        var self = this;
        this.seen.forEach(function (at, key) { if (now - at > 15000) self.seen.delete(key); });
      }
    }
    for (var i = 0; i < m.l.length; i++) {
      var e = m.l[i];
      try {
        if (e[0] === 'o') this.onOpen(e[1], e[2], e[3] || {}, e[4]);
        else if (e[0] === 'm') this.onText(e[1], e[2]);
        else if (e[0] === 'g') this.onGone(e[1]);
      } catch (err) {
        if (root.console) console.error(err);
      }
    }
  };

  // Steering from the switchboard: [1, (connection id 6 bytes, x, buttons, seq)*].
  // The page gets [1, (player id 2 bytes, x, buttons, seq)*].
  Room.prototype.onServerBinary = function (d) {
    if (d[0] !== 1 || !this.opts.onBinary) return;
    var out = [1];
    for (var i = 1; i + 9 <= d.length; i += 9) {
      var cid = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) * 0x1000000 + ((d[i + 3] << 16) | (d[i + 4] << 8) | d[i + 5]);
      var info = this.cids.get(cid);
      if (!info || info.role !== 'phone') continue;
      out.push(info.pid >> 8, info.pid & 255, d[i + 6], d[i + 7], d[i + 8]);
    }
    if (out.length > 1) this.opts.onBinary(new Uint8Array(out));
  };

  Room.prototype.refuse = function (cid, why) {
    this.closeCid(cid, 4000, why, { t: 'err', why: why });
  };

  Room.prototype.onOpen = function (cid, role, q, ip) {
    if (role === 'admin') {
      this.cids.set(cid, { role: 'admin' });
      this.changed();
      this.sendTo(cid, this.snapshot());
      return;
    }
    if (q.token) {
      // A phone coming back with its session token.
      var pid = this.byToken.get(q.token);
      var p = pid ? this.players.get(pid) : null;
      if (!p || p.removed) return this.refuse(cid, 'token');
      var old = this.sockets.get(pid);
      this.sockets.set(pid, cid);
      this.cids.set(cid, { role: 'phone', pid: pid });
      p.connected = true;
      p.lastSeen = Date.now();
      this.changed();
      // Welcome the new connection first, then close the old one, so the
      // phone moves over without a gap.
      this.sendTo(cid, this.welcome(p));
      if (old !== undefined && old !== cid) {
        this.cids.delete(old);
        this.closeCid(old, 4002, 'replaced');
      }
      this.toHosts({ t: 'p', p: this.pub(p) });
      return;
    }
    // A new phone with a join code.
    var code = q.code;
    if (!code || (code !== this.meta.code && code !== this.meta.prev)) return this.refuse(cid, 'code');
    if (this.meta.locked) return this.refuse(cid, 'locked');
    if (this.active().length >= MAX_PLAYERS || this.count('pend') >= MAX_PENDING) return this.refuse(cid, 'full');
    if (!this.ipAllowed(ip || 'local')) return this.refuse(cid, 'slow');
    var color = this.pickColor();
    this.cids.set(cid, { role: 'pend', color: color });
    this.sendTo(cid, { t: 'hi', color: color, name: Names.suggestName(color), code: code });
  };

  Room.prototype.onGone = function (cid) {
    var info = this.cids.get(cid);
    if (!info) return;
    this.cids.delete(cid);
    if (info.role === 'phone' && this.sockets.get(info.pid) === cid) {
      this.sockets.delete(info.pid);
      var p = this.players.get(info.pid);
      if (p && !p.removed) {
        p.connected = false;
        p.lastSeen = Date.now();
        this.toHosts({ t: 'p', p: this.pub(p) });
      }
    }
    this.changed();
  };

  Room.prototype.onText = function (cid, text) {
    var info = this.cids.get(cid);
    if (!info || typeof text !== 'string' || text.length > 2048) return;
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (info.role === 'pend') {
      if (m.t === 'join') this.join(cid, info, m);
    } else if (info.role === 'phone') {
      this.fromPhone(cid, info, m);
    } else if (info.role === 'admin') {
      this.fromAdmin(m);
    }
  };

  Room.prototype.join = function (cid, info, m) {
    if (this.meta.locked) {
      this.sendTo(cid, { t: 'err', why: 'locked' });
      return;
    }
    var name = Names.cleanName(m.name);
    var problem = Names.nameProblem(name);
    if (problem) {
      this.sendTo(cid, { t: 'err', why: 'name', detail: problem });
      return;
    }
    var now = Date.now();
    var id = this.meta.nextId++;
    var p = {
      id: id, token: randomId(24), name: this.uniqueName(name), custom: !!m.custom, share: !!m.share,
      color: Names.COLORS.indexOf(m.color) >= 0 ? m.color : info.color, seat: null, seatedAt: null, queuedAt: null,
      hidden: false, removed: false, joinedAt: now, lastSeen: now, connected: true, rounds: 0,
    };
    var seat = this.freeSeat();
    if (seat !== null) {
      p.seat = seat;
      p.seatedAt = now;
    } else {
      p.queuedAt = now;
    }
    this.players.set(id, p);
    this.byToken.set(p.token, id);
    this.sockets.set(id, cid);
    this.cids.set(cid, { role: 'phone', pid: id });
    this.changed();
    this.sendTo(cid, this.welcome(p));
    this.toHosts({ t: 'p', p: this.pub(p), join: true });
  };

  Room.prototype.fromPhone = function (cid, info, m) {
    var p = this.players.get(info.pid);
    if (!p || p.removed) return;
    var self = this;
    if (m.t === 'tap') {
      var n = Math.min(20, Math.max(1, Number.parseInt(m.n, 10) || 1));
      this.taps += n;
      this.tappers.add(p.id);
      if (!this.tapTimer) this.tapTimer = setTimeout(function () { self.flushTaps(); }, TAP_FLUSH_MS);
    } else if (m.t === 'line') {
      if (p.seat === null && p.queuedAt === null) {
        var seat = this.freeSeat();
        if (seat !== null) {
          p.seat = seat;
          p.seatedAt = Date.now();
        } else {
          p.queuedAt = Date.now();
        }
        this.changed();
        this.toPlayer(p.id, { t: 'seat', seat: p.seat, line: this.linePos(p) });
        this.toHosts({ t: 'p', p: this.pub(p) });
      }
    } else if (m.t === 'leave') {
      p.removed = true;
      p.seat = null;
      p.queuedAt = null;
      this.byToken.delete(p.token);
      this.sockets.delete(p.id);
      this.cids.delete(cid);
      this.changed();
      this.toHosts({ t: 'p', p: this.pub(p) });
      this.seatFromLine();
      this.closeCid(cid, 1000, 'left');
    }
  };

  Room.prototype.flushTaps = function () {
    this.tapTimer = null;
    if (!this.taps) return;
    this.meta.taps = (this.meta.taps || 0) + this.taps;
    this.toScreen({ t: 'taps', n: this.taps, by: this.tappers.size });
    this.taps = 0;
    this.tappers.clear();
  };

  Room.prototype.fromAdmin = function (m) {
    var p = m.id !== undefined ? this.players.get(Number(m.id)) : null;
    if (m.t === 'kick' && p && !p.removed) {
      p.removed = true;
      p.seat = null;
      p.queuedAt = null;
      this.byToken.delete(p.token);
      var cid = this.sockets.get(p.id);
      this.sockets.delete(p.id);
      if (cid !== undefined) {
        this.cids.delete(cid);
        this.sendTo(cid, { t: 'bye', why: 'removed' });
        this.closeCid(cid, 4003, 'removed');
      }
      this.changed();
      this.toHosts({ t: 'p', p: this.pub(p) });
      this.seatFromLine();
    } else if (m.t === 'hide' && p && !p.removed) {
      p.hidden = !!m.on;
      this.changed();
      this.toPlayer(p.id, { t: 'name', name: this.display(p) });
      this.toHosts({ t: 'p', p: this.pub(p) });
    } else if (m.t === 'lock') {
      this.meta.locked = !!m.on;
      this.changed();
      this.toHosts({ t: 'lock', on: this.meta.locked });
    } else if (m.t === 'cmd' && (m.c === 'start' || m.c === 'end')) {
      this.toScreen({ t: 'cmd', c: m.c });
    } else if (m.t === 'pads') {
      // Joysticks on or off. Off sends every stick player away, for a phones-only round.
      this.meta.padsOff = !m.on;
      if (this.meta.padsOff) {
        var self = this;
        this.active().filter(isLocal).forEach(function (s) { self.removeLocal(s.id, true); });
      }
      this.changed();
      this.toHosts({ t: 'pads', on: !this.meta.padsOff });
      this.seatFromLine();
    }
  };

  // ---------------------------------------------------------------- joysticks

  // How many joysticks are plugged in; each one keeps a seat free for itself.
  Room.prototype.setPads = function (n) {
    n = Math.max(0, Math.min(8, Number(n) || 0));
    if (n === this.padCount) return;
    this.padCount = n;
    if (this.ready) this.seatFromLine();
  };

  // Someone pressed a button on joystick slot 0-7. Returns the new player's id,
  // or null when joysticks are off or the room is full.
  Room.prototype.addLocal = function (slot) {
    if (this.stopped || !this.meta || this.meta.padsOff) return null;
    slot = Number(slot);
    if (!(slot >= 0 && slot < 8)) return null;
    if (this.active().length >= MAX_PLAYERS) return null;
    var busy = this.active().some(function (p) { return p.local === slot; });
    if (busy) return null;
    var now = Date.now();
    var color = Names.COLORS[slot % Names.COLORS.length];
    var id = this.meta.nextId++;
    var p = {
      id: id, token: null, name: this.uniqueName(Names.suggestName(color)), custom: false, share: false,
      color: color, seat: null, seatedAt: null, queuedAt: null, hidden: false, removed: false,
      joinedAt: now, lastSeen: now, connected: true, rounds: 0, local: slot,
    };
    var seat = this.freeSeat(true);
    if (seat !== null) {
      p.seat = seat;
      p.seatedAt = now;
    } else {
      p.queuedAt = 1 + slot; // a full room: sticks go to the front of the line
    }
    this.players.set(id, p);
    this.changed();
    this.toHosts({ t: 'p', p: this.pub(p), join: true });
    return id;
  };

  // A stick player is gone: put down for too long, unplugged, or sent away by
  // the host. The next press on that stick is a new player.
  Room.prototype.removeLocal = function (id, quiet) {
    var p = this.players.get(Number(id));
    if (!p || p.removed || !isLocal(p)) return false;
    p.removed = true;
    p.seat = null;
    p.queuedAt = null;
    p.connected = false;
    this.changed();
    this.toHosts({ t: 'p', p: this.pub(p) });
    if (!quiet) this.seatFromLine();
    return true;
  };

  // Free seats and places in line held by phones that never came back.
  Room.prototype.checkHolds = function () {
    if (!this.ready) return;
    var now = Date.now();
    var self = this;
    var changed = [];
    this.active().forEach(function (p) {
      if (p.connected) return;
      if (p.seat !== null && now - p.lastSeen > HOLD_MS) {
        p.seat = null;
        p.queuedAt = null;
        changed.push(p);
      } else if (p.queuedAt !== null && now - p.lastSeen > LINE_HOLD_MS) {
        p.queuedAt = null;
        changed.push(p);
      }
    });
    if (changed.length) {
      this.changed();
      changed.forEach(function (p) { self.toHosts({ t: 'p', p: self.pub(p) }); });
      this.seatFromLine();
    }
  };

  // ---------------------------------------------------------------- from the page

  Room.prototype.send = function (m) {
    if (this.stopped || !m) return false;
    var self = this;
    if (m.t === 'to') {
      this.toPlayer(Number(m.id), m.m);
    } else if (m.t === 'multi' && Array.isArray(m.m)) {
      m.m.forEach(function (pair) { if (Array.isArray(pair)) self.toPlayer(Number(pair[0]), pair[1]); });
    } else if (m.t === 'all') {
      this.broadcast('pa', m.m);
    } else if (m.t === 'bench') {
      // A driver who stopped steering gives up the seat.
      var p = this.players.get(Number(m.id));
      if (p && isLocal(p)) {
        this.removeLocal(p.id);
      } else if (p && p.seat !== null) {
        p.seat = null;
        p.queuedAt = null;
        this.changed();
        this.toPlayer(p.id, { t: 'seat', seat: null, line: -1, why: 'idle' });
        this.toHosts({ t: 'p', p: this.pub(p) });
        this.seatFromLine();
      }
    } else if (m.t === 'rotate') {
      this.rotateSeats();
    }
    return true;
  };

  // At the end of a round, drivers who have had a turn make room for the line.
  Room.prototype.rotateSeats = function () {
    var now = Date.now();
    var self = this;
    var drivers = this.active().filter(function (p) { return p.seat !== null; });
    drivers.forEach(function (d) { d.rounds++; });
    var line = this.line().filter(function (p) { return p.connected || now - p.lastSeen < HOLD_MS; });
    var changed = new Set(drivers);
    // A driver who sat down in the last minute of a round keeps the seat.
    // Stick players keep theirs until they put the stick down.
    var leaving = drivers
      .filter(function (d) { return !isLocal(d) && now - (d.seatedAt || 0) > self.minTurnMs; })
      .sort(function (a, b) { return (a.seatedAt || 0) - (b.seatedAt || 0); });
    var next = 0;
    for (var i = 0; i < line.length; i++) {
      var p = line[i];
      var seat = this.freeSeat(isLocal(p));
      if (seat !== null) {
        // a free seat
      } else if (next < leaving.length) {
        var out = leaving[next++];
        seat = out.seat;
        out.seat = null;
        out.queuedAt = now + next; // back of the line, in order
        changed.add(out);
      } else {
        break;
      }
      if (seat === null) break;
      p.seat = seat;
      p.seatedAt = now;
      p.queuedAt = null;
      changed.add(p);
    }
    this.changed();
    changed.forEach(function (p) { self.toPlayer(p.id, { t: 'seat', seat: p.seat, line: self.linePos(p) }); });
    this.sendLinePositions();
    this.toHosts(this.snapshot());
  };

  Room.prototype.nudge = function () {
    this.link.nudge();
  };

  // Saves everything now: before a reload, a close or a stop.
  Room.prototype.saveNow = function () {
    clearTimeout(this.saveTimer);
    clearTimeout(this.serverSaveTimer);
    this.saveTimer = null;
    this.serverSaveTimer = null;
    var ls = store();
    try { if (ls) ls.setItem(this.localKey(), JSON.stringify(this.state())); } catch (e) { /* storage blocked */ }
    if (this.ready && this.link.send({ t: 'save', s: this.state(), now: true })) this.serverSavedAt = Date.now();
  };

  Room.prototype.stop = function () {
    if (!this.stopped && this.meta) this.saveNow();
    this.stopped = true;
    this.checkTimer.stop();
    clearTimeout(this.codeTimer);
    clearTimeout(this.serverSaveTimer);
    this.link.stop();
  };

  root.LiveRoom = Room;
})(typeof window !== 'undefined' ? window : globalThis);
