// A tiny Redis stand-in for tests: just the commands the switchboard uses
// (GET, SET with EX and NX, PUBLISH, SUBSCRIBE, UNSUBSCRIBE), so two local
// copies of the switchboard can share rooms and messages like on Vercel.
//   node test/mini-redis.mjs [port]
import net from 'node:net';

const port = Number(process.argv[2] || 6390);
const keys = new Map();
const subs = new Map(); // channel -> Set of sockets
export const stats = { publish: 0, set: 0, get: 0 };

const bulk = s => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
const arr = items => `*${items.length}\r\n` + items.map(i => (typeof i === 'number' ? `:${i}\r\n` : bulk(i))).join('');

function parse(buf) {
  // Returns [commands, rest]
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 42) return [out, Buffer.alloc(0)]; // only arrays are expected
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const n = Number(buf.slice(i + 1, nl).toString());
    let j = nl + 2;
    const parts = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const nl2 = buf.indexOf('\r\n', j);
      if (nl2 < 0) { ok = false; break; }
      const len = Number(buf.slice(j + 1, nl2).toString());
      if (nl2 + 2 + len + 2 > buf.length) { ok = false; break; }
      parts.push(buf.slice(nl2 + 2, nl2 + 2 + len).toString());
      j = nl2 + 2 + len + 2;
    }
    if (!ok) break;
    out.push(parts);
    i = j;
  }
  return [out, buf.slice(i)];
}

function run(sock, [cmd, ...args]) {
  const c = cmd.toUpperCase();
  if (c === 'GET') {
    stats.get++;
    const e = keys.get(args[0]);
    if (e && e.exp < Date.now()) keys.delete(args[0]);
    return bulk(keys.has(args[0]) ? keys.get(args[0]).v : null);
  }
  if (c === 'SET') {
    stats.set++;
    const [k, v, ...opt] = args;
    let exp = Infinity;
    let nx = false;
    for (let i = 0; i < opt.length; i++) {
      const o = opt[i].toUpperCase();
      if (o === 'EX') exp = Date.now() + Number(opt[++i]) * 1000;
      else if (o === 'PX') exp = Date.now() + Number(opt[++i]);
      else if (o === 'NX') nx = true;
    }
    const cur = keys.get(k);
    if (nx && cur && cur.exp > Date.now()) return '$-1\r\n';
    keys.set(k, { v, exp });
    return '+OK\r\n';
  }
  if (c === 'PUBLISH') {
    stats.publish++;
    const set = subs.get(args[0]) || new Set();
    for (const s of set) s.write(arr(['message', args[0], args[1]]));
    return `:${set.size}\r\n`;
  }
  if (c === 'SUBSCRIBE' || c === 'UNSUBSCRIBE') {
    let reply = '';
    for (const ch of args) {
      if (!subs.has(ch)) subs.set(ch, new Set());
      if (c === 'SUBSCRIBE') { subs.get(ch).add(sock); sock.channels.add(ch); } else { subs.get(ch).delete(sock); sock.channels.delete(ch); }
      reply += arr([c.toLowerCase(), ch, sock.channels.size]);
    }
    return reply;
  }
  if (c === 'PING') return '+PONG\r\n';
  if (c === 'INFO') return bulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\n');
  return '+OK\r\n'; // AUTH, SELECT, CLIENT and anything else
}

export function startMiniRedis(p = port) {
  const server = net.createServer(sock => {
    sock.channels = new Set();
    let rest = Buffer.alloc(0);
    sock.on('data', d => {
      const [cmds, left] = parse(Buffer.concat([rest, d]));
      rest = left;
      for (const cmd of cmds) sock.write(run(sock, cmd));
    });
    const drop = () => { for (const ch of sock.channels) subs.get(ch)?.delete(sock); };
    sock.on('close', drop);
    sock.on('error', drop);
  });
  return new Promise(resolve => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('mini-redis.mjs')) {
  startMiniRedis().then(() => console.log('mini redis on ' + port));
}
