// Test helpers: raw WebSocket clients for phones and host panels, and the real
// big-screen room (public/live/room.js) running inside Node.
//
//   SCREEN  site the big screen uses       (default http://127.0.0.1:8799)
//   PHONES  site the phones use            (default: same as SCREEN)
//   EVENT_KEY, ORIGIN (needed for the deployed site)
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREEN = (process.env.SCREEN || 'http://127.0.0.1:8799').replace(/\/$/, '');
export const PHONES = (process.env.PHONES || SCREEN).replace(/\/$/, '');
export const API = SCREEN + '/api/live';
export const SCREEN_WS = API.replace(/^http/, 'ws');
export const PHONE_WS = (PHONES + '/api/live').replace(/^http/, 'ws');
export const KEY = process.env.EVENT_KEY || 'local-test-key';
export const ORIGIN = process.env.ORIGIN || '';
const originHeaders = ORIGIN ? { Origin: ORIGIN } : {};
const wsInit = ORIGIN ? { headers: originHeaders } : undefined;

// Load the browser scripts once.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['names.js', 'net.js', 'room.js']) {
  const file = path.resolve(here, '..', '..', 'public', 'live', f);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

class Waiter {
  constructor() {
    this.msgs = [];
    this.bins = [];
    this.waiters = [];
    this.closed = null;
  }

  check() {
    for (const w of [...this.waiters]) {
      const r = w.fn();
      if (r !== undefined) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(r);
      }
    }
  }

  wait(fn, ms, label) {
    return new Promise((resolve, reject) => {
      const first = fn();
      if (first !== undefined) return resolve(first);
      const w = {
        fn, resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new Error('timed out waiting for ' + label));
        }, ms),
      };
      this.waiters.push(w);
    });
  }

  waitFor(pred, ms = 5000, label = 'a message') {
    return this.wait(() => {
      const i = this.msgs.findIndex(pred);
      return i >= 0 ? this.msgs.splice(i, 1)[0] : undefined;
    }, ms, label);
  }

  waitBin(pred = () => true, ms = 5000, label = 'binary') {
    return this.wait(() => {
      const i = this.bins.findIndex(b => pred(b.data));
      return i >= 0 ? this.bins.splice(i, 1)[0].data : undefined;
    }, ms, label);
  }

  waitClose(ms = 5000) {
    return this.wait(() => (this.closed ? this.closed : undefined), ms, 'close');
  }
}

export class Client extends Waiter {
  constructor(url, init) {
    super();
    const headers = { ...originHeaders, ...(init && init.headers) };
    this.ws = Object.keys(headers).length ? new WebSocket(url, { headers }) : new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', e => {
      if (typeof e.data === 'string') {
        let m;
        try { m = JSON.parse(e.data); } catch { m = { raw: e.data }; }
        if (m.t === 'ttl') return;
        if (m.t === 'end') {
          // The switchboard's way of saying it closed this connection.
          this.closed = { code: m.code, reason: m.why || '' };
          try { this.ws.close(); } catch { /* ignore */ }
          this.check();
          return;
        }
        this.msgs.push(m);
      } else {
        this.bins.push({ at: performance.now(), data: new Uint8Array(e.data) });
      }
      this.check();
    });
    this.ws.addEventListener('close', e => {
      this.closed = { code: e.code, reason: e.reason };
      this.check();
    });
    this.ws.addEventListener('error', () => {});
  }

  send(m) {
    this.ws.send(typeof m === 'string' || m instanceof Uint8Array ? m : JSON.stringify(m));
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// The big screen: the real room code, with its messages collected for tests.
export class Screen extends Waiter {
  constructor(room, host, seats = 16) {
    super();
    // SCREEN_ALT makes each new big-screen connection alternate between two
    // copies, like Vercel can, to test a handover that changes copy.
    const alt = process.env.SCREEN_ALT ? (process.env.SCREEN_ALT.replace(/\/$/, '') + '/api/live').replace(/^http/, 'ws') : null;
    let turn = 0;
    this.room = new globalThis.LiveRoom({
      url: () => `${alt && turn++ % 2 ? alt : SCREEN_WS}?room=${room}&role=screen&key=${host}`,
      room, seats, wsInit,
      onMessage: m => { this.msgs.push(m); this.check(); },
      onBinary: d => { this.bins.push({ at: performance.now(), data: d }); this.check(); },
    });
  }

  send(m) {
    return this.room.send(m);
  }

  close() {
    this.room.stop();
  }
}

export async function createRoom(seats = 16, key = KEY) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-event-key': key, ...originHeaders },
    body: JSON.stringify({ seats }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

export const adminUrl = (room, host) => `${PHONE_WS}?room=${room}&role=admin&key=${host}`;
export const resumeUrl = (room, token) => `${PHONE_WS}?room=${room}&role=phone&token=${token}`;
export const joinUrl = code => `${PHONE_WS}?code=${code}`;

export async function joinPhone(code, name = 'PRIYA', extra = {}) {
  const c = new Client(joinUrl(code));
  const hi = await c.waitFor(m => m.t === 'hi' || m.t === 'err', 6000, 'hi');
  if (hi.t === 'err') return { c, err: hi };
  c.send({ t: 'join', name, color: hi.color, ...extra });
  const w = await c.waitFor(m => m.t === 'welcome' || m.t === 'err', 6000, 'welcome');
  if (w.t === 'err') return { c, hi, err: w };
  return { c, hi, w };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
