// Runs the site the way Vercel does, on this computer: the files in public/
// with the rewrites from vercel.json, and the live switchboard at /api/live.
//
//   node server/dev.mjs [port]
//
// Without REDIS_URL it uses one in-memory copy. Set REDIS_URL to run several
// copies against one Redis, the way Vercel spreads connections.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveServer } from './live.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'public');
const config = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'vercel.json'), 'utf8'));
const port = Number(process.argv[2] || process.env.PORT || 8799);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const live = createLiveServer();

function rewrite(p) {
  for (const r of config.rewrites || []) {
    const re = new RegExp('^' + r.source.replace(/:[a-z]+/g, '[^/]+') + '$');
    if (re.test(p)) return r.destination;
  }
  return p;
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0].split('#')[0];
  if (pathname === '/api/live') return live.emit('request', req, res);
  const p = rewrite(decodeURIComponent(pathname));
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.split('?')[0] === '/api/live') live.emit('upgrade', req, socket, head);
  else socket.destroy();
});

server.listen(port, '127.0.0.1', async () => {
  const bus = await live.live.getBus();
  console.log(`Fleet Invaders Live on http://localhost:${port} (copy ${live.live.inst}, ${bus.kind} bus)`);
});
