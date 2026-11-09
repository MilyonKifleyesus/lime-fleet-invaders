// Runs join-across-handover.mjs on this computer the way Vercel behaves:
// two copies of the switchboard share a Redis stand-in, every connection is
// cut after 30 s, and each new big-screen connection lands on the other copy.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMiniRedis } from './mini-redis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = path.resolve(here, '..', 'dev.mjs');
const env = {
  ...process.env,
  EVENT_KEY_HASH: '4596a16f68a099db007c4af7b9ac890a9a8a4836aef2c625b4a97c371a601d8b', // 'local-test-key'
  ALLOW_LOCAL: '1', CODE_MS: '8000', MIN_TURN_MS: '0',
  LIVE_TTL_MS: '30000', LIVE_TTL_ENFORCE: '1', REDIS_URL: 'redis://127.0.0.1:6393',
};
const children = [];
function start(port) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [dev, String(port)], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(c);
    c.stdout.on('data', d => { if (String(d).includes('Fleet Invaders Live on')) resolve(); });
    c.on('exit', code => reject(new Error('server stopped ' + code)));
  });
}
let code = 1;
try {
  await startMiniRedis(6393);
  await Promise.all([start(8841), start(8842)]);
  code = await new Promise(resolve => {
    const c = spawn(process.execPath, [path.resolve(here, 'join-across-handover.mjs'), process.argv[2] || '100'], {
      env: { ...process.env, SCREEN: 'http://127.0.0.1:8841', SCREEN_ALT: 'http://127.0.0.1:8842', PHONES: 'http://127.0.0.1:8841' },
      stdio: 'inherit',
    });
    c.on('exit', resolve);
  });
} finally {
  for (const c of children) c.kill();
}
process.exit(code);
