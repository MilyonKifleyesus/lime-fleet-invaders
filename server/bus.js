// The message bus between copies of the live function.
//
// On Vercel, each phone's connection can land on a different copy of the
// function, so copies talk through Redis: short-lived keys for rooms and join
// codes, and publish/subscribe channels for messages. Without a Redis address
// (local testing with one copy) an in-memory bus does the same job.

import { EventEmitter } from 'node:events';

// The Vercel Marketplace names its variables after the store, so look for any
// variable that holds a redis:// or rediss:// address.
export function findRedisUrl(env = process.env) {
  for (const name of ['REDIS_URL', 'KV_URL', 'UPSTASH_REDIS_URL']) {
    if (/^rediss?:\/\//.test(env[name] || '')) return env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (/REDIS|KV/.test(name) && /^rediss?:\/\//.test(value || '')) return value;
  }
  return '';
}

export async function createBus(url) {
  if (!url) return new MemoryBus();
  const { default: Redis } = await import('ioredis');
  return new RedisBus(Redis, url);
}

class RedisBus {
  constructor(Redis, url) {
    const options = {
      maxRetriesPerRequest: 3,
      connectTimeout: 8000,
      keepAlive: 30000,
      // Upstash closes idle connections; reconnect quietly.
      retryStrategy: times => Math.min(200 * times, 2000),
    };
    this.kind = 'redis';
    this.pub = new Redis(url, options);
    this.sub = new Redis(url, options);
    this.handler = () => {};
    this.pub.on('error', e => console.error('[live] redis', e.message));
    this.sub.on('error', e => console.error('[live] redis sub', e.message));
    this.sub.on('messageBuffer', (channel, message) => this.handler(channel.toString(), message.toString()));
  }

  onMessage(fn) {
    this.handler = fn;
  }

  get(key) {
    return this.pub.get(key);
  }

  async set(key, value, seconds, onlyIfNew = false) {
    const ok = onlyIfNew
      ? await this.pub.set(key, value, 'EX', seconds, 'NX')
      : await this.pub.set(key, value, 'EX', seconds);
    return ok === 'OK';
  }

  publish(channel, text) {
    return this.pub.publish(channel, text);
  }

  subscribe(channel) {
    return this.sub.subscribe(channel);
  }

  unsubscribe(channel) {
    return this.sub.unsubscribe(channel);
  }

  close() {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

// One process, one copy: keys in a Map, channels on an EventEmitter.
class MemoryBus {
  constructor() {
    this.kind = 'memory';
    this.keys = new Map();
    this.channels = new Set();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.handler = () => {};
  }

  onMessage(fn) {
    this.handler = fn;
  }

  async get(key) {
    const entry = this.keys.get(key);
    if (!entry) return null;
    if (entry.exp < Date.now()) {
      this.keys.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, seconds, onlyIfNew = false) {
    if (onlyIfNew && (await this.get(key)) !== null) return false;
    this.keys.set(key, { value, exp: Date.now() + seconds * 1000 });
    return true;
  }

  async publish(channel, text) {
    if (!this.channels.has(channel)) return 0;
    queueMicrotask(() => this.handler(channel, text));
    return 1;
  }

  async subscribe(channel) {
    this.channels.add(channel);
  }

  async unsubscribe(channel) {
    this.channels.delete(channel);
  }

  close() {}
}
