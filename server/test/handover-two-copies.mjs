import { spawn } from 'node:child_process';
import { startMiniRedis } from 'file:///C:/Users/Owner/OneDrive/Documents/Bus_Pulse/fleet-Invaders/lime-fleet-invaders/server/test/mini-redis.mjs';
await startMiniRedis(6395);
const env = { ...process.env, EVENT_KEY_HASH: '4596a16f68a099db007c4af7b9ac890a9a8a4836aef2c625b4a97c371a601d8b', ALLOW_LOCAL: '1', REDIS_URL: 'redis://127.0.0.1:6395', LIVE_TTL_MS: '30000', LIVE_TTL_ENFORCE: '1' };
const kids = [8851, 8852].map(p => spawn(process.execPath, ['dev.mjs', String(p)], { env, stdio: 'ignore' }));
await new Promise(r => setTimeout(r, 2000));
const t = spawn(process.execPath, ['test/handover.test.mjs', process.argv[2] || '70'], { env: { ...process.env, SCREEN: 'http://127.0.0.1:8851', SCREEN_ALT: 'http://127.0.0.1:8852', PHONES: 'http://127.0.0.1:8852' }, stdio: 'inherit' });
t.on('exit', c => { kids.forEach(k => k.kill()); process.exit(c); });
