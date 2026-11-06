// Fleet Invaders Live relay.
//
// The big screen runs the game. Phones send steering here, and this relay
// passes it on. One Durable Object holds one event room: who is playing,
// which seat each driver has, the line for the next seats, and the join code
// that changes every 45 seconds. A second, single Durable Object maps the
// current join codes to rooms.

import { DurableObject } from 'cloudflare:workers';
import { cleanName, nameProblem, suggestName, COLORS } from './names.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_MS = 45_000; // how long a join code is shown
const HOLD_MS = 45_000; // how long a dropped driver keeps their seat
const LINE_HOLD_MS = 180_000; // how long a dropped phone keeps its place in line
const TICK_MS = 15_000;
const ROOM_IDLE_MS = 10 * 60_000; // a room with no big screen for this long has ended
const MAX_PLAYERS = 500;
const MAX_PENDING = 600;
const DEFAULT_SEATS = 16;
const MAX_SEATS = 32;
const FLUSH_MS = 16; // steering is batched to the big screen about 60 times a second
const TAP_FLUSH_MS = 250;
const JOINS_PER_MINUTE_PER_IP = 300; // generous: a whole venue can share one address
const INPUTS_PER_SECOND = 40;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function randomId(length, alphabet = ID_ALPHABET) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function sameSecret(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// Sends one error message over a WebSocket, then closes it, so the page can
// explain what went wrong instead of showing a bare connection failure.
function socketError(why) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ t: 'err', why }));
  server.close(4000, why);
  return new Response(null, { status: 101, webSocket: client });
}

function originAllowed(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin && list.includes(origin)) return true;
  if (env.ALLOW_LOCAL === '1') {
    if (!origin) return true; // test scripts
    try {
      const host = new URL(origin).hostname;
      return host === 'localhost' || host === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return false;
}

function withCors(response, origin, allowed) {
  if (allowed && origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'content-type, x-event-key');
    response.headers.set('Access-Control-Max-Age', '600');
  }
  return response;
}

const codesStub = env => env.CODES.get(env.CODES.idFromName('codes'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = originAllowed(origin, env);
    const isSocket = request.headers.get('Upgrade') === 'websocket';

    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin, allowed);

    if (url.pathname === '/health') return withCors(json({ ok: true }), origin, allowed);

    // The big screen creates a room. Only someone with the event key can.
    if (url.pathname === '/rooms' && request.method === 'POST') {
      if (!allowed) return json({ error: 'origin' }, 403);
      const key = request.headers.get('X-Event-Key') || '';
      if (!env.EVENT_KEY || !sameSecret(key, env.EVENT_KEY)) {
        return withCors(json({ error: 'key' }, 401), origin, allowed);
      }
      let seats = DEFAULT_SEATS;
      try {
        const body = await request.json();
        const n = Number.parseInt(body && body.seats, 10);
        if (Number.isFinite(n)) seats = Math.min(MAX_SEATS, Math.max(1, n));
      } catch {
        // no body: keep the default
      }
      const room = randomId(12);
      const host = randomId(32);
      await env.ROOM.get(env.ROOM.idFromName(room)).init(room, host, seats);
      return withCors(json({ room, host, seats }), origin, allowed);
    }

    // A phone that scanned or typed a join code.
    if (url.pathname === '/join') {
      if (!isSocket) return json({ error: 'websocket only' }, 426);
      if (!allowed) return socketError('origin');
      const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const room = code.length === 4 ? await codesStub(env).resolve(code) : null;
      if (!room) return socketError('code');
      const target = new URL('https://room/ws');
      target.searchParams.set('role', 'phone');
      target.searchParams.set('code', code);
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(target, request));
    }

    // Reconnecting phones, the big screen and the host panel.
    const match = url.pathname.match(/^\/room\/([a-z0-9]{12})\/ws$/);
    if (match) {
      if (!isSocket) return json({ error: 'websocket only' }, 426);
      if (!allowed) return socketError('origin');
      const target = new URL('https://room/ws');
      for (const k of ['role', 'key', 'token']) {
        const v = url.searchParams.get(k);
        if (v) target.searchParams.set(k, v);
      }
      return env.ROOM.get(env.ROOM.idFromName(match[1])).fetch(new Request(target, request));
    }

    return json({ error: 'not found' }, 404);
  },
};

// Maps live join codes to rooms. One instance for everything.
export class Codes extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('create table if not exists codes (code text primary key, room text not null, exp integer not null)');
  }

  claim(code, room, exp) {
    const now = Date.now();
    this.sql.exec('delete from codes where exp < ?', now);
    const taken = this.sql.exec('select room from codes where code = ?', code).toArray()[0];
    if (taken && taken.room !== room) return false;
    this.sql.exec('insert or replace into codes (code, room, exp) values (?, ?, ?)', code, room, exp);
    return true;
  }

  resolve(code) {
    const row = this.sql.exec('select room, exp from codes where code = ?', code).toArray()[0];
    if (!row || row.exp < Date.now()) return null;
    return row.room;
  }
}

// One event room.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.meta = null;
    this.players = new Map();
    this.byToken = new Map();
    this.sockets = new Map(); // player id -> socket
    this.inputs = [];
    this.flushTimer = null;
    this.taps = 0;
    this.tappers = new Set();
    this.tapTimer = null;
    this.joinsByIp = new Map();
    this.inputRate = new WeakMap();
    // Tests shorten these; real events use the defaults.
    this.codeMs = Number(env.CODE_MS) || CODE_MS;
    this.minTurnMs = env.MIN_TURN_MS !== undefined ? Number(env.MIN_TURN_MS) : 60_000;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get('meta')) || null;
      const stored = await ctx.storage.list({ prefix: 'p:' });
      for (const p of stored.values()) {
        p.connected = false;
        this.players.set(p.id, p);
        if (p.token && !p.removed) this.byToken.set(p.token, p.id);
      }
      // After a wake-up, sockets survive but memory does not.
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.role === 'phone' && this.players.has(a.pid)) {
          this.sockets.set(a.pid, ws);
          this.players.get(a.pid).connected = true;
        }
      }
    });
  }

  // ---------------------------------------------------------------- setup

  async init(room, host, seats) {
    if (this.meta) throw new Error('room exists');
    this.meta = {
      room, host, seats, locked: false, code: null, prev: null, codeEnds: 0,
      nextId: 1, created: Date.now(), screenSeen: Date.now(), taps: 0,
    };
    await this.ctx.storage.put('meta', this.meta);
    return true;
  }

  // ---------------------------------------------------------------- helpers

  display(p) {
    return p.hidden ? 'DRIVER ' + String(p.id).padStart(2, '0') : p.name;
  }

  pub(p) {
    return {
      id: p.id, name: this.display(p), color: p.color, seat: p.seat, queued: p.queuedAt !== null,
      connected: p.connected, hidden: p.hidden, custom: p.custom, share: p.share, rounds: p.rounds,
      joinedAt: p.joinedAt, removed: p.removed,
    };
  }

  active() {
    return [...this.players.values()].filter(p => !p.removed);
  }

  line() {
    return this.active().filter(p => p.seat === null && p.queuedAt !== null).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  linePos(p) {
    if (p.seat !== null) return 0;
    if (p.queuedAt === null) return -1;
    return this.line().indexOf(p) + 1;
  }

  freeSeat() {
    const taken = new Set(this.active().filter(p => p.seat !== null).map(p => p.seat));
    for (let i = 0; i < this.meta.seats; i++) if (!taken.has(i)) return i;
    return null;
  }

  pickColor() {
    const counts = Object.fromEntries(COLORS.map(c => [c, 0]));
    for (const p of this.active()) if (p.connected || p.seat !== null) counts[p.color]++;
    const min = Math.min(...Object.values(counts));
    const options = COLORS.filter(c => counts[c] === min);
    return options[Math.floor(Math.random() * options.length)];
  }

  uniqueName(name) {
    const taken = new Set(this.active().map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = (name.length > 13 ? name.slice(0, 13).trim() : name) + ' ' + i;
      if (!taken.has(candidate)) return candidate;
    }
    return name;
  }

  screens() {
    return this.ctx.getWebSockets('screen');
  }

  send(ws, msg) {
    try {
      ws.send(typeof msg === 'string' || msg instanceof Uint8Array ? msg : JSON.stringify(msg));
    } catch {
      // the socket is closing
    }
  }

  toScreen(msg) {
    for (const ws of this.screens()) this.send(ws, msg);
  }

  toAdmins(msg) {
    for (const ws of this.ctx.getWebSockets('admin')) this.send(ws, msg);
  }

  toHosts(msg) {
    const text = JSON.stringify(msg);
    this.toScreen(text);
    this.toAdmins(text);
  }

  toPlayer(id, msg) {
    const ws = this.sockets.get(id);
    if (ws) this.send(ws, msg);
  }

  snapshot() {
    return {
      t: 'roster', room: this.meta.room, seats: this.meta.seats, locked: this.meta.locked,
      code: this.meta.code, ends: this.meta.codeEnds, players: this.active().map(p => this.pub(p)),
    };
  }

  welcome(p) {
    return {
      t: 'welcome', id: p.id, token: p.token, room: this.meta.room, name: this.display(p),
      color: p.color, seat: p.seat, line: this.linePos(p), share: p.share,
    };
  }

  async savePlayers(list) {
    const entries = {};
    for (const p of list) entries['p:' + p.id] = p;
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = {};
      for (const k of keys.slice(i, i + 100)) chunk[k] = entries[k];
      await this.ctx.storage.put(chunk);
    }
  }

  async saveMeta() {
    await this.ctx.storage.put('meta', this.meta);
  }

  // A seat that frees up mid-round goes straight to the next connected phone in line,
  // then everyone still waiting hears their new place.
  async seatFromLine() {
    const changed = [];
    for (const p of this.line()) {
      if (!p.connected) continue;
      const seat = this.freeSeat();
      if (seat === null) break;
      p.seat = seat;
      p.seatedAt = Date.now();
      p.queuedAt = null;
      changed.push(p);
    }
    if (changed.length) {
      await this.savePlayers(changed);
      for (const p of changed) {
        this.toPlayer(p.id, { t: 'seat', seat: p.seat, line: 0 });
        this.toHosts({ t: 'p', p: this.pub(p) });
      }
    }
    this.sendLinePositions();
  }

  // Tells every phone in line where it now stands.
  sendLinePositions() {
    this.line().forEach((p, i) => this.toPlayer(p.id, { t: 'seat', seat: null, line: i + 1 }));
  }

  ipAllowed(ip) {
    const now = Date.now();
    const entry = this.joinsByIp.get(ip);
    if (!entry || now - entry.start > 60_000) {
      this.joinsByIp.set(ip, { start: now, n: 1 });
      return true;
    }
    entry.n++;
    return entry.n <= JOINS_PER_MINUTE_PER_IP;
  }

  inputAllowed(ws) {
    const now = Date.now();
    const r = this.inputRate.get(ws);
    if (!r || now - r.start >= 1000) {
      this.inputRate.set(ws, { start: now, n: 1 });
      return true;
    }
    r.n++;
    return r.n <= INPUTS_PER_SECOND;
  }

  // ---------------------------------------------------------------- codes

  async rotateCode() {
    const now = Date.now();
    const codes = codesStub(this.env);
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = randomId(4, CODE_ALPHABET);
      if (await codes.claim(code, this.meta.room, now + this.codeMs * 2 + 15_000)) {
        this.meta.prev = this.meta.code;
        this.meta.code = code;
        this.meta.codeEnds = now + this.codeMs;
        await this.saveMeta();
        this.toHosts({ t: 'code', code, ends: this.meta.codeEnds });
        return;
      }
    }
  }

  async schedule() {
    const now = Date.now();
    const next = Math.max(now + 1000, Math.min(this.meta.codeEnds || now + TICK_MS, now + TICK_MS));
    await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    if (!this.meta) return;
    const now = Date.now();
    const screenOn = this.screens().length > 0;
    if (screenOn) this.meta.screenSeen = now;
    if (screenOn && now >= this.meta.codeEnds - 500) await this.rotateCode();

    // Free seats and places in line held by phones that never came back.
    const changed = [];
    for (const p of this.active()) {
      if (p.connected) continue;
      if (p.seat !== null && now - p.lastSeen > HOLD_MS) {
        p.seat = null;
        p.queuedAt = null;
        changed.push(p);
      } else if (p.queuedAt !== null && now - p.lastSeen > LINE_HOLD_MS) {
        p.queuedAt = null;
        changed.push(p);
      }
    }
    if (changed.length) {
      await this.savePlayers(changed);
      for (const p of changed) this.toHosts({ t: 'p', p: this.pub(p) });
      await this.seatFromLine();
    }
    await this.saveMeta();
    const anyone = screenOn || this.sockets.size > 0;
    if (anyone) await this.schedule();
  }

  // ---------------------------------------------------------------- sockets

  async fetch(request) {
    if (!this.meta) return socketError('room');
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const [client, server] = Object.values(new WebSocketPair());
    const accepted = () => new Response(null, { status: 101, webSocket: client });

    if (role === 'screen' || role === 'admin') {
      if (!sameSecret(url.searchParams.get('key') || '', this.meta.host)) return socketError('key');
      if (role === 'screen') {
        for (const old of this.screens()) {
          this.send(old, { t: 'replaced' });
          try { old.close(4001, 'replaced'); } catch { /* already closed */ }
        }
      }
      this.ctx.acceptWebSocket(server, [role]);
      server.serializeAttachment({ role });
      if (role === 'screen') {
        this.meta.screenSeen = Date.now();
        if (!this.meta.code || Date.now() >= this.meta.codeEnds - 500) await this.rotateCode();
        await this.schedule();
      }
      this.send(server, this.snapshot());
      return accepted();
    }

    if (role !== 'phone') return socketError('role');

    // A phone coming back with its session token.
    const token = url.searchParams.get('token');
    if (token) {
      const pid = this.byToken.get(token);
      const p = pid ? this.players.get(pid) : null;
      if (!p || p.removed) return socketError('token');
      const screenAway = this.screens().length === 0 && Date.now() - (this.meta.screenSeen || 0) > ROOM_IDLE_MS;
      if (screenAway) return socketError('ended');
      const old = this.sockets.get(pid);
      if (old) {
        try { old.close(4002, 'replaced'); } catch { /* already closed */ }
      }
      this.ctx.acceptWebSocket(server, ['phone']);
      server.serializeAttachment({ role: 'phone', pid });
      this.sockets.set(pid, server);
      p.connected = true;
      p.lastSeen = Date.now();
      await this.savePlayers([p]);
      this.send(server, this.welcome(p));
      this.toHosts({ t: 'p', p: this.pub(p) });
      await this.schedule();
      return accepted();
    }

    // A new phone with a join code.
    const code = url.searchParams.get('code');
    if (!code || (code !== this.meta.code && code !== this.meta.prev)) return socketError('code');
    if (this.meta.locked) return socketError('locked');
    if (this.active().length >= MAX_PLAYERS) return socketError('full');
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS + MAX_PENDING) return socketError('full');
    if (!this.ipAllowed(ip)) return socketError('slow');
    const color = this.pickColor();
    this.ctx.acceptWebSocket(server, ['pend']);
    server.serializeAttachment({ role: 'pend', color });
    this.send(server, { t: 'hi', color, name: suggestName(color), code });
    return accepted();
  }

  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment() || {};

    if (a.role === 'phone') {
      if (typeof message !== 'string') {
        // Steering: [x + 100, buttons, sequence]
        if (!this.inputAllowed(ws)) return;
        const b = new Uint8Array(message);
        if (b.length < 2 || b.length > 8) return;
        this.inputs.push(a.pid >> 8, a.pid & 255, Math.min(200, b[0]), b[1], b[2] || 0);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushInputs(), FLUSH_MS);
        return;
      }
      const m = this.parse(message);
      if (!m) return;
      const p = this.players.get(a.pid);
      if (!p || p.removed) return;
      if (m.t === 'tap') {
        const n = Math.min(20, Math.max(1, Number.parseInt(m.n, 10) || 1));
        this.taps += n;
        this.tappers.add(p.id);
        if (!this.tapTimer) this.tapTimer = setTimeout(() => this.flushTaps(), TAP_FLUSH_MS);
      } else if (m.t === 'line') {
        if (p.seat === null && p.queuedAt === null) {
          const seat = this.freeSeat();
          if (seat !== null) {
            p.seat = seat;
            p.seatedAt = Date.now();
          } else {
            p.queuedAt = Date.now();
          }
          await this.savePlayers([p]);
          this.toPlayer(p.id, { t: 'seat', seat: p.seat, line: this.linePos(p) });
          this.toHosts({ t: 'p', p: this.pub(p) });
        }
      } else if (m.t === 'leave') {
        p.removed = true;
        p.seat = null;
        p.queuedAt = null;
        this.byToken.delete(p.token);
        await this.savePlayers([p]);
        this.toHosts({ t: 'p', p: this.pub(p) });
        await this.seatFromLine();
        try { ws.close(1000, 'left'); } catch { /* already closed */ }
      }
      return;
    }

    if (a.role === 'pend') {
      if (typeof message !== 'string') return;
      const m = this.parse(message);
      if (m && m.t === 'join') await this.join(ws, a, m);
      return;
    }

    if (a.role === 'screen') {
      if (typeof message !== 'string') return;
      const m = this.parse(message, 64_000);
      if (m) await this.fromScreen(m);
      return;
    }

    if (a.role === 'admin') {
      if (typeof message !== 'string') return;
      const m = this.parse(message);
      if (m) await this.fromAdmin(m);
    }
  }

  parse(text, max = 1024) {
    if (text.length > max) return null;
    try {
      const m = JSON.parse(text);
      return m && typeof m === 'object' ? m : null;
    } catch {
      return null;
    }
  }

  async join(ws, a, m) {
    if (this.meta.locked) {
      this.send(ws, { t: 'err', why: 'locked' });
      return;
    }
    const name = cleanName(m.name);
    const problem = nameProblem(name);
    if (problem) {
      this.send(ws, { t: 'err', why: 'name', detail: problem });
      return;
    }
    const now = Date.now();
    const id = this.meta.nextId++;
    const p = {
      id, token: randomId(24), name: this.uniqueName(name), custom: !!m.custom, share: !!m.share,
      color: COLORS.includes(m.color) ? m.color : a.color, seat: null, seatedAt: null, queuedAt: null,
      hidden: false, removed: false, joinedAt: now, lastSeen: now, connected: true, rounds: 0,
    };
    const seat = this.freeSeat();
    if (seat !== null) {
      p.seat = seat;
      p.seatedAt = now;
    } else {
      p.queuedAt = now;
    }
    this.players.set(id, p);
    this.byToken.set(p.token, id);
    this.sockets.set(id, ws);
    ws.serializeAttachment({ role: 'phone', pid: id });
    await this.ctx.storage.put({ ['p:' + id]: p, meta: this.meta });
    this.send(ws, this.welcome(p));
    this.toHosts({ t: 'p', p: this.pub(p), join: true });
    await this.schedule();
  }

  async fromScreen(m) {
    if (m.t === 'to') {
      this.toPlayer(Number(m.id), m.m);
    } else if (m.t === 'multi' && Array.isArray(m.m)) {
      for (const pair of m.m) if (Array.isArray(pair)) this.toPlayer(Number(pair[0]), pair[1]);
    } else if (m.t === 'all') {
      const text = JSON.stringify(m.m);
      for (const ws of this.sockets.values()) this.send(ws, text);
      for (const ws of this.ctx.getWebSockets('pend')) {
        const att = ws.deserializeAttachment();
        if (att && att.role === 'pend') this.send(ws, text);
      }
      this.toAdmins(text);
    } else if (m.t === 'bench') {
      // A driver who stopped steering gives up the seat.
      const p = this.players.get(Number(m.id));
      if (p && p.seat !== null) {
        p.seat = null;
        p.queuedAt = null;
        await this.savePlayers([p]);
        this.toPlayer(p.id, { t: 'seat', seat: null, line: -1, why: 'idle' });
        this.toHosts({ t: 'p', p: this.pub(p) });
        await this.seatFromLine();
      }
    } else if (m.t === 'rotate') {
      await this.rotateSeats();
    }
  }

  // At the end of a round, drivers who have had a turn make room for the line.
  async rotateSeats() {
    const now = Date.now();
    const drivers = this.active().filter(p => p.seat !== null);
    for (const d of drivers) d.rounds++;
    const line = this.line().filter(p => p.connected || now - p.lastSeen < HOLD_MS);
    const changed = new Set(drivers);
    let free = this.meta.seats - drivers.length;
    // A driver who sat down in the last minute of a round keeps the seat.
    const leaving = drivers
      .filter(d => now - (d.seatedAt || 0) > this.minTurnMs)
      .sort((a, b) => (a.seatedAt || 0) - (b.seatedAt || 0));
    let next = 0;
    for (const p of line) {
      let seat = null;
      if (free > 0) {
        seat = this.freeSeat();
        free--;
      } else if (next < leaving.length) {
        const out = leaving[next++];
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
    await this.savePlayers([...changed]);
    for (const p of changed) this.toPlayer(p.id, { t: 'seat', seat: p.seat, line: this.linePos(p) });
    this.sendLinePositions();
    this.toHosts(this.snapshot());
  }

  async fromAdmin(m) {
    const p = m.id !== undefined ? this.players.get(Number(m.id)) : null;
    if (m.t === 'kick' && p && !p.removed) {
      p.removed = true;
      p.seat = null;
      p.queuedAt = null;
      this.byToken.delete(p.token);
      await this.savePlayers([p]);
      const ws = this.sockets.get(p.id);
      if (ws) {
        this.send(ws, { t: 'bye', why: 'removed' });
        try { ws.close(4003, 'removed'); } catch { /* already closed */ }
        this.sockets.delete(p.id);
      }
      this.toHosts({ t: 'p', p: this.pub(p) });
      await this.seatFromLine();
    } else if (m.t === 'hide' && p && !p.removed) {
      p.hidden = !!m.on;
      await this.savePlayers([p]);
      this.toPlayer(p.id, { t: 'name', name: this.display(p) });
      this.toHosts({ t: 'p', p: this.pub(p) });
    } else if (m.t === 'lock') {
      this.meta.locked = !!m.on;
      await this.saveMeta();
      this.toHosts({ t: 'lock', on: this.meta.locked });
    } else if (m.t === 'cmd' && (m.c === 'start' || m.c === 'end')) {
      this.toScreen({ t: 'cmd', c: m.c });
    }
  }

  flushInputs() {
    this.flushTimer = null;
    if (!this.inputs.length) return;
    const out = new Uint8Array(1 + this.inputs.length);
    out[0] = 1;
    out.set(this.inputs, 1);
    this.inputs = [];
    for (const ws of this.screens()) this.send(ws, out);
  }

  flushTaps() {
    this.tapTimer = null;
    if (!this.taps) return;
    this.meta.taps = (this.meta.taps || 0) + this.taps;
    this.toScreen({ t: 'taps', n: this.taps, by: this.tappers.size });
    this.taps = 0;
    this.tappers.clear();
  }

  async webSocketClose(ws) {
    await this.dropped(ws);
  }

  async webSocketError(ws) {
    await this.dropped(ws);
  }

  async dropped(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.role !== 'phone') return;
    if (this.sockets.get(a.pid) !== ws) return; // an older socket for the same phone
    this.sockets.delete(a.pid);
    const p = this.players.get(a.pid);
    if (!p || p.removed) return;
    p.connected = false;
    p.lastSeen = Date.now();
    await this.savePlayers([p]);
    this.toHosts({ t: 'p', p: this.pub(p) });
  }
}
