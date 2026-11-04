/* Fleet Invaders: everything that talks to the database.
   The publishable key is meant to be public. The database only lets it call a
   few checked functions (see supabase/migrations). Never put a secret key here. */
(function (global) {
  'use strict';

  const API_URL = 'https://kutxhnkknwtgpvjothdk.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_HQ_YYj6i-vF2Ph8azOg3Vw_AqWdUZ4T';
  const QUEUE_KEY = 'fleetInvadersQueue';
  const REQUEST_TIMEOUT_MS = 8000;
  const RETRY_MS = 30000;

  const NAME_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ._'’-]*$/u;
  const NAME_MESSAGES = {
    name_missing: 'Type a name to start.',
    name_too_long: 'That name is too long. Use up to 16 letters.',
    name_invalid: 'Use letters and numbers. Spaces, hyphens and apostrophes are fine.',
    name_not_allowed: 'Please choose a different name.',
    slow_down: 'Too many games from this connection. Try again in a minute.',
  };

  function storage() {
    try { return global.localStorage; } catch (e) { return null; }
  }
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async function rpc(fn, args, opts) {
    const options = opts || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
        signal: controller.signal,
        keepalive: !!options.keepalive,
      });
      if (!res.ok) throw new Error(`${fn} failed with status ${res.status}`);
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- names ---------- */
  function cleanName(raw) {
    return String(raw || '').normalize('NFC').trim().replace(/\s+/g, ' ').toUpperCase();
  }
  function nameError(name) {
    if (!name) return 'name_missing';
    if ([...name].length > 16) return 'name_too_long';
    if (!NAME_PATTERN.test(name)) return 'name_invalid';
    return null;
  }
  function nameMessage(code) {
    return NAME_MESSAGES[code] || NAME_MESSAGES.name_invalid;
  }
  /* Resolves to the server's answer, or null when it cannot be reached in time. */
  function checkName(name, timeout) {
    return rpc('check_name', { p_name: name }, { timeout: timeout || 2500 }).catch(() => null);
  }

  /* ---------- saving games, safe against lost connections ---------- */
  let memoryQueue = [];
  function readQueue() {
    const s = storage();
    if (!s) return memoryQueue;
    try { return JSON.parse(s.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeQueue(items) {
    const s = storage();
    if (!s) { memoryQueue = items; return; }
    try { s.setItem(QUEUE_KEY, JSON.stringify(items)); } catch (e) { memoryQueue = items; }
  }

  function newRun(details) {
    return {
      id: uuid(),
      name: details.name,
      avatar: details.avatar || null,
      mode: details.mode === 'tournament' ? 'tournament' : 'solo',
      input: details.input || null,
      startAcked: false,
    };
  }
  function start(run) {
    return rpc('start_game', {
      p_id: run.id, p_name: run.name, p_avatar: run.avatar, p_mode: run.mode, p_input: run.input,
    }).then((res) => {
      if (res && res.ok) run.startAcked = true;
    }).catch(() => {});
  }

  async function sendItem(item, keepalive) {
    if (!item.startAcked) {
      const started = await rpc('start_game', {
        p_id: item.id, p_name: item.name, p_avatar: item.avatar, p_mode: item.mode, p_input: item.input,
      }, { keepalive });
      if (!started || !started.ok) return { refused: true };
    }
    const s = item.stats;
    return rpc('finish_game', {
      p_id: item.id,
      p_status: item.status,
      p_score: s.score,
      p_wave: s.wave,
      p_overdrive: s.overdrive,
      p_waves_cleared: s.wavesCleared,
      p_kills: s.kills,
      p_shots: s.shots,
      p_hits: s.hits,
      p_longest_combo: s.longestCombo,
      p_powerups: s.powerups,
      p_duration_s: s.durationS,
      p_end_reason: item.reason,
      p_input: s.input,
      p_was_offline: !item.startAcked,
    }, { keepalive });
  }

  let flushing = null;
  function flush(keepalive) {
    if (flushing) return flushing;
    flushing = (async () => {
      const results = {};
      for (const item of readQueue()) {
        try {
          const res = await sendItem(item, keepalive);
          results[item.id] = res;
          writeQueue(readQueue().filter((q) => q.id !== item.id));
        } catch (e) {
          break; // Still offline. Keep the queue and try again later.
        }
      }
      return results;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /* Queues the game first so it survives a closed tab or a dropped connection.
     Resolves to the player's standing, or null if it has not reached the server yet. */
  async function finish(run, status, stats, reason, opts) {
    const options = opts || {};
    writeQueue(readQueue().concat([{
      id: run.id, name: run.name, avatar: run.avatar, mode: run.mode, input: run.input,
      startAcked: run.startAcked, status, stats, reason: reason || null,
    }]));
    if (flushing) await flushing.catch(() => {});
    const results = await flush(options.keepalive);
    const res = results[run.id];
    return res && res.ok ? res : null;
  }

  function pendingCount() {
    return readQueue().length;
  }

  /* ---------- reading ---------- */
  function visit(screen) {
    return rpc('record_visit', { p_id: uuid(), p_screen: screen }).catch(() => {});
  }
  function leaderboard(q) {
    const query = q || {};
    return rpc('get_leaderboard', {
      p_scope: query.scope || 'today',
      p_group: query.group || 'best',
      p_search: query.search || null,
      p_limit: query.limit || 100,
      p_offset: query.offset || 0,
    });
  }
  function playerGames(name, scope) {
    return rpc('get_player_games', { p_name: name, p_scope: scope || 'all' });
  }
  function standing(id) {
    return rpc('get_standing', { p_id: id });
  }
  function report(secret, day, all) {
    return rpc('get_day_report', { p_secret: secret, p_day: day || null, p_all: !!all }, { timeout: 15000 });
  }

  global.addEventListener('online', () => { flush(); });
  setInterval(() => { if (readQueue().length) flush(); }, RETRY_MS);

  global.FleetData = {
    cleanName, nameError, nameMessage, checkName,
    newRun, start, finish, flush, pendingCount,
    visit, leaderboard, playerGames, standing, report,
  };
})(window);
