// Runs the live checks twice on this computer:
//   1. one copy of the switchboard with the in-memory bus
//   2. two copies sharing a Redis stand-in, big screen on one, phones on the other,
//      the way Vercel can spread connections
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMiniRedis } from './mini-redis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = path.resolve(here, '..', 'dev.mjs');
const testEnv = {
  EVENT_KEY_HASH: '4596a16f68a099db007c4af7b9ac890a9a8a4836aef2c625b4a97c371a601d8b', // 'local-test-key'
  ALLOW_LOCAL: '1', CODE_MS: '8000', MIN_TURN_MS: '0',
};
const children = [];

function start(port, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dev, String(port)], {
      env: { ...process.env, ...testEnv, ...extra }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);
    child.stdout.on('data', d => { if (String(d).includes('Fleet Invaders Live on')) resolve(); });
    child.on('exit', code => reject(new Error('server stopped ' + code)));
  });
}

function run(label, env, file = 'live.test.mjs') {
  console.log('\n=== ' + label);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve(here, file)], {
      env: { ...process.env, ...env }, stdio: 'inherit',
    });
    child.on('exit', code => resolve(code));
  });
}

let failed = 0;
try {
  failed += await run('joystick reading', {}, 'pads.test.mjs');
  failed += await run('controller lights', {}, 'lights.test.mjs');
  await startMiniRedis(6390);
  const REDIS_URL = 'redis://127.0.0.1:6390';
  await Promise.all([start(8811), start(8812, { REDIS_URL }), start(8813, { REDIS_URL })]);
  failed += await run('one copy, in-memory bus', { SCREEN: 'http://127.0.0.1:8811' });
  failed += await run('two copies through Redis: big screen on one, phones on the other', {
    SCREEN: 'http://127.0.0.1:8812', PHONES: 'http://127.0.0.1:8813',
  });
  failed += await run('joysticks with phones, one copy', { SCREEN: 'http://127.0.0.1:8811' }, 'joystick.test.mjs');
  failed += await run('joysticks with phones, two copies through Redis', {
    SCREEN: 'http://127.0.0.1:8812', PHONES: 'http://127.0.0.1:8813',
  }, 'joystick.test.mjs');
} finally {
  for (const c of children) c.kill();
}
console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
