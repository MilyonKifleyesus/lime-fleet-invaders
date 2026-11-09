// Fleet Invaders Live switchboard.
//
// The big screen runs the game and keeps the room: who is playing, the seats,
// the line and the names (see public/live/room.js). This switchboard only
// checks keys and join codes and passes messages between the big screen,
// the phones and the host panel.
//
// On Vercel every connection is pinned to one copy of this function, and a new
// connection can land on any copy. Messages between connections on the same
// copy go straight across. Messages for a connection on another copy go
// through Redis channels, bundled every few milliseconds to keep Redis use low:
//   fi:s:<room>  everything for the copy that holds the big screen
//   fi:p:<room>  everything for copies that hold phones or host panels

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createBus, findRedisUrl } from './bus.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const DEFAULT_SEATS = 16;
const MAX_SEATS = 32;
const ROOM_TTL_S = 3 * 24 * 3600; // a room and its saved state last three days
const PHONE_TEXT_MAX = 2048;
const SCREEN_TEXT_MAX = 1_500_000;
const INPUTS_PER_SECOND = 40;
const TEXTS_PER_SECOND = 25;
const LOCAL_FLUSH_MS = 16; // about 60 bundles a second to a big screen on this copy
const REMOTE_FLUSH_MS = 25; // a little more bundling when the message goes through Redis
const RETRY_MS = 1000; // while no big screen is listening, try again every second
const GIVE_UP_MS = 45_000;
const QUIET_LIMIT_MS = 30_000; // pages ping at least every 10 s; silence this long means gone
const ROOM_CACHE_MS = 30_000;
const SAVE_EVERY_MS = 2000;
const KEY_TRIES_PER_MINUTE = 10;

// The event key is checked against a slow, salted hash, so only the hash
// lives in the code. Set EVENT_KEY_HASH to change it without a code change.
const EVENT_KEY_SALT = 'fleet-invaders-live-v1';
const DEFAULT_EVENT_KEY_HASH = '9b81828a35ae13f5c6a903ab56443fb7e30ad3c4fdfeb47f68b0b3a0247184cf';

const chS = room => 'fi:s:' + room;
const chP = room => 'fi:p:' + room;
const roomKey = room => 'fi:room:' + room;
const codeKey = code => 'fi:code:' + code;
const stateKey = room => 'fi:state:' + room;

function randomId(length, alphabet = ID_ALPHABET) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

function sameHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function hashEventKey(key) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(key), EVENT_KEY_SALT, 32, { N: 16384, r: 8, p: 1 }, (err, out) =>
      err ? reject(err) : resolve(out.toString('hex')));
  });
}

// Vercel does not pass a close started here on to the page, so first say
// so in a message ({t:'end'}), which makes the page close its side, then
// close and cut the connection a moment later.
function closeWs(ws, code, why) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'end', code, why })); } catch { /* closing */ }
  try { ws.close(code, why); } catch { /* already closed */ }
  const t = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1000);
  if (t.unref) t.unref();
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, max) {
  return new Promise(resolve => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= max) parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString()));
    req.on('error', () => resolve(''));
  });
}

function overRate(r, limit) {
  const now = Date.now();
  if (now - r.start >= 1000) {
    r.start = now;
    r.n = 1;
    return false;
  }
  r.n++;
  return r.n > limit;
}

export function createLiveServer(opts = {}) {
  const env = opts.env || process.env;
  const eventKeyHash = env.EVENT_KEY_HASH || DEFAULT_EVENT_KEY_HASH;
  const codeMs = Number(env.CODE_MS) || 45_000;
  const minTurnMs = env.MIN_TURN_MS !== undefined ? Number(env.MIN_TURN_MS) : 60_000;
  // Vercel closes a connection at the function's maximum duration (300 s on
  // Hobby). Pages are told, so they open a fresh connection a minute before.
  const ttlMs = env.LIVE_TTL_MS !== undefined ? Number(env.LIVE_TTL_MS) : env.VERCEL ? 300_000 : 0;
  const allowLocal = env.ALLOW_LOCAL === '1';
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

  const inst = 1 + crypto.randomInt(0xfffffe); // this copy's number, 24 bits
  const instHex = inst.toString(36);
  let cidCounter = 0;
  let batchCounter = 0;

  const conns = new Map(); // connection id -> connection on this copy
  const rooms = new Map(); // room id -> what this copy holds for that room
  const roomCache = new Map();
  const keyTries = new Map();

  let busPromise = null;
  function getBus() {
    if (!busPromise) {
      busPromise = (opts.bus ? Promise.resolve(opts.bus) : createBus(findRedisUrl(env))).then(bus => {
        bus.onMessage(onBus);
        return bus;
      });
    }
    return busPromise;
  }

  // ------------------------------------------------------------ helpers

  function nextCid() {
    cidCounter = (cidCounter + 1) % 0x1000000;
    return inst * 0x1000000 + cidCounter;
  }

  function writeCid(buf, at, cid) {
    const hi = Math.floor(cid / 0x1000000);
    const lo = cid % 0x1000000;
    buf[at] = hi >> 16; buf[at + 1] = (hi >> 8) & 255; buf[at + 2] = hi & 255;
    buf[at + 3] = lo >> 16; buf[at + 4] = (lo >> 8) & 255; buf[at + 5] = lo & 255;
  }

  function send(ws, msg) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  function roomOf(id) {
    let R = rooms.get(id);
    if (!R) {
      R = {
        id, screen: null, members: new Set(), subS: null, subP: null, remote: 1,
        up: [], upBin: [], upTimer: null, down: [], downTimer: null,
        waiting: [], waitTimer: null, savedAt: 0, saveTimer: null, pendingSave: null, tidyTimer: null,
      };
      rooms.set(id, R);
    }
    return R;
  }

  async function subscribe(R, kind) {
    const prop = kind === 's' ? 'subS' : 'subP';
    if (!R[prop]) {
      const bus = await getBus();
      R[prop] = bus.subscribe(kind === 's' ? chS(R.id) : chP(R.id)).catch(e => {
        R[prop] = null;
        throw e;
      });
    }
    return R[prop];
  }

  async function unsubscribe(R, kind) {
    const prop = kind === 's' ? 'subS' : 'subP';
    if (!R[prop]) return;
    R[prop] = null;
    const bus = await getBus();
    bus.unsubscribe(kind === 's' ? chS(R.id) : chP(R.id)).catch(() => {});
  }

  function tidySoon(R) {
    clearTimeout(R.tidyTimer);
    R.tidyTimer = setTimeout(() => {
      if (!R.screen) unsubscribe(R, 's');
      if (!R.members.size) unsubscribe(R, 'p');
      if (!R.screen && !R.members.size && !R.up.length && !R.waiting.length && !R.down.length) rooms.delete(R.id);
    }, 5000);
  }

  function originAllowed(req) {
    const origin = req.headers.origin || '';
    if (!origin) return allowLocal; // test scripts only
    let url;
    try { url = new URL(origin); } catch { return false; }
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (url.host === host) return true;
    if (allowedOrigins.includes(origin)) return true;
    return allowLocal && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  }

  function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || String(req.headers['x-real-ip'] || '') || req.socket.remoteAddress || 'local';
  }

  // The room's record: the host key's hash and the number of seats.
  async function roomInfo(room) {
    const hit = roomCache.get(room);
    if (hit && Date.now() - hit.at < ROOM_CACHE_MS) return hit.info;
    const bus = await getBus();
    const raw = await bus.get(roomKey(room));
    const info = raw ? JSON.parse(raw) : null;
    if (info) roomCache.set(room, { info, at: Date.now() });
    return info;
  }

  // ------------------------------------------------------------ HTTP

  async function onRequest(req, res) {
    try {
      if (req.method === 'POST') return await createRoom(req, res);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const bus = await getBus();
        return json(res, 200, { ok: true, bus: bus.kind, copy: instHex, ttl: ttlMs });
      }
      json(res, 405, { error: 'method' });
    } catch (e) {
      console.error('[live] request', e);
      json(res, 500, { error: 'server' });
    }
  }

  // The big screen opens an event. Only someone with the event key can.
  async function createRoom(req, res) {
    if (!originAllowed(req)) return json(res, 403, { error: 'origin' });
    const bus = await getBus();
    if (bus.kind === 'memory' && env.VERCEL) return json(res, 503, { error: 'redis' });
    const ip = clientIp(req);
    const tries = keyTries.get(ip) || { start: Date.now(), n: 0 };
    if (Date.now() - tries.start > 60_000) { tries.start = Date.now(); tries.n = 0; }
    tries.n++;
    keyTries.set(ip, tries);
    if (tries.n > KEY_TRIES_PER_MINUTE) return json(res, 429, { error: 'slow' });
    const key = String(req.headers['x-event-key'] || '').trim();
    if (!key || !eventKeyHash || !sameHex(await hashEventKey(key), eventKeyHash)) return json(res, 401, { error: 'key' });
    let seats = DEFAULT_SEATS;
    try {
      const n = Number.parseInt(JSON.parse(await readBody(req, 4096)).seats, 10);
      if (Number.isFinite(n)) seats = Math.min(MAX_SEATS, Math.max(1, n));
    } catch {
      // no body: keep the default
    }
    const room = randomId(12);
    const host = randomId(32);
    await bus.set(roomKey(room), JSON.stringify({ h: sha256(host), seats, created: Date.now() }), ROOM_TTL_S);
    json(res, 200, { room, host, seats });
  }

  // ------------------------------------------------------------ connections

  const screenWss = new WebSocketServer({ noServer: true, maxPayload: SCREEN_TEXT_MAX + 1024 });
  const pageWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  async function onUpgrade(req, socket, head) {
    const q = new URL(req.url, 'http://local').searchParams;
    const role = q.get('code') ? 'phone' : q.get('role') || '';
    const wss = role === 'screen' ? screenWss : pageWss;
    const accept = fn => wss.handleUpgrade(req, socket, head, fn);
    // Accept, explain and close, so the page can say what went wrong.
    const refuse = why => accept(ws => {
      send(ws, { t: 'err', why });
      closeWs(ws, 4000, why);
    });
    if (!originAllowed(req)) return refuse('origin');
    const ip = clientIp(req);
    const ipTag = sha256(EVENT_KEY_SALT + ip).slice(0, 12);

    const code = (q.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (q.get('code')) {
      if (code.length !== 4) return refuse('code');
      const bus = await getBus();
      const room = await bus.get(codeKey(code));
      if (!room) return refuse('code');
      return accept(ws => attach(ws, { room, role: 'phone', ip: ipTag, q: { code } }));
    }

    const room = q.get('room') || '';
    if (!/^[a-z0-9]{12}$/.test(room)) return refuse('room');
    const info = await roomInfo(room);
    if (!info) return refuse('room');
    if (role === 'screen' || role === 'admin') {
      if (!sameHex(sha256(q.get('key') || ''), info.h)) return refuse('key');
      return accept(ws => attach(ws, { room, role, ip: ipTag, info }));
    }
    if (role === 'phone') {
      const token = q.get('token') || '';
      if (!/^[a-z0-9]{24}$/.test(token)) return refuse('token');
      return accept(ws => attach(ws, { room, role, ip: ipTag, q: { token } }));
    }
    return refuse('role');
  }

  function attach(ws, c) {
    const conn = {
      ws, cid: nextCid(), room: c.room, role: c.role, ip: c.ip, lastIn: Date.now(),
      inRate: { start: 0, n: 0 }, textRate: { start: 0, n: 0 }, ready: false, early: [],
    };
    conns.set(conn.cid, conn);
    if (ttlMs > 0) send(ws, { t: 'ttl', ms: ttlMs });
    // Tests can cut connections at the time limit the way Vercel does.
    if (ttlMs > 0 && env.LIVE_TTL_ENFORCE === '1') setTimeout(() => ws.terminate(), ttlMs).unref?.();
    ws.on('message', (data, isBinary) => {
      conn.lastIn = Date.now();
      try {
        if (conn.role === 'screen') fromScreen(conn, data, isBinary);
        else fromPage(conn, data, isBinary);
      } catch (e) {
        console.error('[live] message', e);
      }
    });
    ws.on('close', () => dropped(conn));
    ws.on('error', () => {});
    const R = roomOf(conn.room);
    clearTimeout(R.tidyTimer);
    if (conn.role === 'screen') {
      becomeScreen(conn, c.info).catch(e => {
        console.error('[live] screen', e);
        closeWs(ws, 1011, 'server');
      });
    } else {
      R.members.add(conn.cid);
      // Listen for replies before asking the big screen anything.
      subscribe(R, 'p')
        .then(() => queueUp(R, ['o', conn.cid, conn.role, c.q || null, conn.ip]))
        .catch(e => {
          console.error('[live] subscribe', e);
          closeWs(ws, 1011, 'server');
        });
    }
  }

  async function becomeScreen(conn, info) {
    const R = roomOf(conn.room);
    const old = R.screen;
    R.screen = conn;
    if (old && old !== conn) {
      send(old.ws, { t: 'replaced' });
      closeWs(old.ws, 4001, 'replaced');
    }
    const bus = await getBus();
    await subscribe(R, 's');
    // Any other copy that held this room's big screen lets it go.
    await bus.publish(chS(R.id), JSON.stringify({ i: instHex, claim: 1 }));
    bus.set(roomKey(R.id), JSON.stringify(info), ROOM_TTL_S).catch(() => {});
    const saved = await bus.get(stateKey(R.id));
    if (R.screen !== conn) return;
    R.remote = 1;
    send(conn.ws, {
      t: 'ready', copy: instHex, room: R.id, seats: info.seats, codeMs, minTurnMs,
      state: saved ? JSON.parse(saved) : null,
    });
    conn.ready = true;
    for (const early of conn.early) send(conn.ws, early);
    conn.early = [];
    if (R.up.length || R.upBin.length) flushUp(R);
  }

  // A phone or host panel sent something: bundle it for the big screen.
  function fromPage(conn, data, isBinary) {
    const R = roomOf(conn.room);
    if (isBinary) {
      // Steering: [x + 100, buttons, sequence]
      if (conn.role !== 'phone' || data.length < 2 || data.length > 8) return;
      if (overRate(conn.inRate, INPUTS_PER_SECOND)) return;
      const e = Buffer.alloc(9);
      writeCid(e, 0, conn.cid);
      e[6] = Math.min(200, data[0]);
      e[7] = data[1];
      e[8] = data[2] || 0;
      R.upBin.push(e);
      scheduleUp(R);
      return;
    }
    const text = data.toString();
    if (text === 'ping') {
      send(conn.ws, 'pong');
      return;
    }
    if (text.length > PHONE_TEXT_MAX || overRate(conn.textRate, TEXTS_PER_SECOND)) return;
    queueUp(R, ['m', conn.cid, text]);
  }

  function queueUp(R, event) {
    R.up.push(event);
    scheduleUp(R);
  }

  function scheduleUp(R) {
    if (!R.upTimer) R.upTimer = setTimeout(() => flushUp(R), R.screen ? LOCAL_FLUSH_MS : REMOTE_FLUSH_MS);
  }

  async function flushUp(R) {
    clearTimeout(R.upTimer);
    R.upTimer = null;
    const events = R.up;
    const bins = R.upBin;
    R.up = [];
    R.upBin = [];
    if (!events.length && !bins.length) return;
    if (R.screen && !R.screen.ready) {
      // The big screen here is still loading the room; ready() sends these.
      R.up = events.concat(R.up);
      R.upBin = bins.concat(R.upBin);
      return;
    }
    const n = instHex + '.' + (++batchCounter).toString(36);
    if (R.screen && R.screen.ws.readyState === 1) {
      if (events.length) send(R.screen.ws, JSON.stringify({ t: 'up', n, l: events }));
      if (bins.length) send(R.screen.ws, Buffer.concat([Buffer.from([1]), ...bins]));
      return;
    }
    const bus = await getBus();
    const payload = { i: instHex, n, l: events };
    if (bins.length) payload.b = Buffer.concat(bins).toString('base64');
    let got = 0;
    try {
      // This copy may still be listening on the channel; it does not count.
      got = (await bus.publish(chS(R.id), JSON.stringify(payload))) - (R.subS ? 1 : 0);
    } catch (e) {
      console.error('[live] publish', e.message);
    }
    if (got <= 0 && events.length) holdForScreen(R, events);
    else if (got > 0) R.waitTries = 0;
  }

  // No big screen is listening (it is reloading, or the room is closed).
  // Keep messages for a while, and tell new phones to wait.
  function holdForScreen(R, events) {
    const now = Date.now();
    for (const ev of events) {
      if (ev[0] === 'o' && !ev.since) {
        const c = conns.get(ev[1]);
        if (c) send(c.ws, { t: 'wait' });
      }
      ev.since = ev.since || now;
      R.waiting.push(ev);
    }
    // Back off (1, 2, 4, 8 sÃ¢â‚¬Â¦) so a closed room costs only a few Redis messages.
    if (!R.waitTimer) {
      R.waitTries = (R.waitTries || 0) + 1;
      R.waitTimer = setTimeout(() => retryWaiting(R), Math.min(15_000, RETRY_MS * 2 ** (R.waitTries - 1)));
    }
  }

  function retryWaiting(R) {
    R.waitTimer = null;
    const now = Date.now();
    const list = R.waiting;
    R.waiting = [];
    for (const ev of list) {
      const c = ev[0] === 'g' ? null : conns.get(ev[1]);
      if (ev[0] !== 'g' && !c) continue; // that connection has gone
      if (now - ev.since > GIVE_UP_MS) {
        if (ev[0] === 'o' && c) {
          send(c.ws, { t: 'err', why: 'noscreen' });
          closeWs(c.ws, 4000, 'noscreen');
        }
        continue;
      }
      R.up.push(ev);
    }
    if (R.up.length) flushUp(R);
  }

  // The big screen sent something for phones or host panels.
  function fromScreen(conn, data, isBinary) {
    if (isBinary) return;
    const text = data.toString();
    if (text === 'ping') {
      send(conn.ws, 'pong');
      return;
    }
    const R = roomOf(conn.room);
    if (R.screen !== conn) return; // a big screen that was replaced
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'batch' && Array.isArray(m.l)) {
      for (const pair of m.l) if (Array.isArray(pair)) down(R, ['s', Number(pair[0]), JSON.stringify(pair[1])]);
    } else if (m.t === 'send') {
      down(R, ['s', Number(m.c), JSON.stringify(m.m)]);
    } else if (m.t === 'all') {
      down(R, ['a', m.r === 'a' || m.r === 'p' ? m.r : 'pa', JSON.stringify(m.m)]);
    } else if (m.t === 'close') {
      down(R, ['c', Number(m.c), Number(m.code) || 4000, String(m.why || '').slice(0, 60), m.m ? JSON.stringify(m.m) : null]);
    } else if (m.t === 'code') {
      newCode(conn).catch(e => console.error('[live] code', e.message));
    } else if (m.t === 'save' && m.s) {
      saveState(R, m.s, !!m.now);
    }
  }

  // Delivers to connections on this copy. Says whether other copies need it too.
  function deliverHere(R, d) {
    const [kind] = d;
    if (kind === 's' || kind === 'c') {
      const c = conns.get(d[1]);
      if (!c || c.room !== R.id) return true;
      if (kind === 's') send(c.ws, d[2]);
      else {
        if (d[4]) send(c.ws, d[4]);
        closeWs(c.ws, d[2], d[3]);
      }
      return false;
    }
    if (kind === 'a') {
      for (const cid of R.members) {
        const c = conns.get(cid);
        if (!c) continue;
        if (d[1] === 'pa' || (d[1] === 'p' && c.role === 'phone') || (d[1] === 'a' && c.role === 'admin')) send(c.ws, d[2]);
      }
      return R.remote > 0;
    }
    return false;
  }

  function down(R, d) {
    if (!deliverHere(R, d)) return;
    R.down.push(d);
    if (!R.downTimer) R.downTimer = setTimeout(() => flushDown(R), LOCAL_FLUSH_MS);
  }

  async function flushDown(R) {
    R.downTimer = null;
    const list = R.down;
    R.down = [];
    if (!list.length) return;
    const bus = await getBus();
    try {
      const got = await bus.publish(chP(R.id), JSON.stringify({ i: instHex, l: list }));
      // How many other copies are listening decides whether broadcasts go out.
      R.remote = got - (R.subP ? 1 : 0);
    } catch (e) {
      console.error('[live] publish', e.message);
    }
  }

  async function newCode(conn) {
    const bus = await getBus();
    const seconds = Math.ceil((codeMs * 2 + 15_000) / 1000);
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = randomId(4, CODE_ALPHABET);
      if (await bus.set(codeKey(code), conn.room, seconds, true)) {
        send(conn.ws, { t: 'code', code, ends: Date.now() + codeMs });
        return;
      }
    }
  }

  // A copy of the room, so a big screen on another computer can carry on.
  function saveState(R, s, now = false) {
    R.pendingSave = s;
    if (now) clearTimeout(R.saveTimer), (R.saveTimer = null), (R.savedAt = 0);
    if (R.saveTimer) return;
    const wait = Math.max(0, R.savedAt + SAVE_EVERY_MS - Date.now());
    R.saveTimer = setTimeout(async () => {
      R.saveTimer = null;
      const data = R.pendingSave;
      R.pendingSave = null;
      R.savedAt = Date.now();
      if (!data) return;
      const bus = await getBus();
      bus.set(stateKey(R.id), JSON.stringify(data), ROOM_TTL_S).catch(e => console.error('[live] save', e.message));
    }, wait);
  }

  function dropped(conn) {
    if (!conns.has(conn.cid)) return;
    conns.delete(conn.cid);
    const R = rooms.get(conn.room);
    if (!R) return;
    if (conn.role === 'screen') {
      if (R.screen === conn) R.screen = null;
    } else {
      R.members.delete(conn.cid);
      queueUp(R, ['g', conn.cid]);
    }
    tidySoon(R);
  }

  // Messages from other copies.
  function onBus(channel, text) {
    const parts = channel.split(':');
    const R = rooms.get(parts[2]);
    if (!R) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || m.i === instHex) return;
    if (parts[1] === 's') {
      if (m.claim) {
        // Another copy now holds this room's big screen.
        const old = R.screen;
        if (old) {
          R.screen = null;
          send(old.ws, { t: 'replaced' });
          closeWs(old.ws, 4001, 'replaced');
        }
        unsubscribe(R, 's');
        return;
      }
      R.remote = Math.max(R.remote, 1);
      if (!R.screen) return;
      const out = [];
      if (m.l && m.l.length) out.push(JSON.stringify({ t: 'up', n: m.n, l: m.l }));
      if (m.b) out.push(Buffer.concat([Buffer.from([1]), Buffer.from(m.b, 'base64')]));
      for (const msg of out) {
        if (R.screen.ready) send(R.screen.ws, msg);
        else R.screen.early.push(msg);
      }
    } else if (parts[1] === 'p' && Array.isArray(m.l)) {
      for (const d of m.l) if (d[0] === 'a' || d[0] === 's' || d[0] === 'c') deliverHereOnly(R, d);
    }
  }

  function deliverHereOnly(R, d) {
    const remote = R.remote;
    R.remote = 0;
    deliverHere(R, d);
    R.remote = remote;
  }

  // Closes connections that went quiet without saying goodbye.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const c of conns.values()) {
      if (now - c.lastIn > QUIET_LIMIT_MS) {
        closeWs(c.ws, 4000, 'quiet');
        dropped(c);
      }
    }
  }, 10_000);
  if (sweep.unref) sweep.unref();

  const server = http.createServer(onRequest);
  server.on('upgrade', (req, socket, head) => {
    onUpgrade(req, socket, head).catch(e => {
      console.error('[live] upgrade', e);
      socket.destroy();
    });
  });
  server.live = { getBus, conns, rooms, inst: instHex };
  return server;
}
