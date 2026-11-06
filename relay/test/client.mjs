// A small WebSocket test client that waits for specific messages.

export const BASE = process.env.RELAY || 'http://127.0.0.1:8787';
export const WS_BASE = BASE.replace(/^http/, 'ws');
export const KEY = process.env.EVENT_KEY || 'local-test-key';
// A deployed relay only talks to the game's own website, so tests present its address.
export const ORIGIN = process.env.ORIGIN || '';
const originHeaders = ORIGIN ? { Origin: ORIGIN } : {};

export class Client {
  constructor(url, init) {
    this.msgs = [];
    this.bins = [];
    this.waiters = [];
    this.closed = null;
    const headers = { ...originHeaders, ...(init && init.headers) };
    this.ws = Object.keys(headers).length ? new WebSocket(url, { headers }) : new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('message', e => {
      if (typeof e.data === 'string') {
        let m;
        try { m = JSON.parse(e.data); } catch { m = { raw: e.data }; }
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

  waitFor(pred, ms = 4000, label = 'a message') {
    return this.wait(() => {
      const i = this.msgs.findIndex(pred);
      return i >= 0 ? this.msgs.splice(i, 1)[0] : undefined;
    }, ms, label);
  }

  waitBin(pred = () => true, ms = 4000, label = 'binary') {
    return this.wait(() => {
      const i = this.bins.findIndex(b => pred(b.data));
      return i >= 0 ? this.bins.splice(i, 1)[0].data : undefined;
    }, ms, label);
  }

  waitClose(ms = 4000) {
    return this.wait(() => (this.closed ? this.closed : undefined), ms, 'close');
  }

  open(ms = 4000) {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('open timed out')), ms);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  send(m) {
    this.ws.send(typeof m === 'string' || m instanceof Uint8Array ? m : JSON.stringify(m));
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function createRoom(seats = 16, key = KEY) {
  const res = await fetch(BASE + '/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-event-key': key, ...originHeaders },
    body: JSON.stringify({ seats }),
  });
  return { status: res.status, body: await res.json() };
}

export function screen(room, host, role = 'screen') {
  return new Client(`${WS_BASE}/room/${room}/ws?role=${role}&key=${host}`);
}

export async function joinPhone(code, name = 'PRIYA', extra = {}) {
  const c = new Client(`${WS_BASE}/join?code=${code}`);
  const hi = await c.waitFor(m => m.t === 'hi' || m.t === 'err', 4000, 'hi');
  if (hi.t === 'err') return { c, err: hi };
  c.send({ t: 'join', name, color: hi.color, ...extra });
  const w = await c.waitFor(m => m.t === 'welcome' || m.t === 'err', 4000, 'welcome');
  if (w.t === 'err') return { c, hi, err: w };
  return { c, hi, w };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
