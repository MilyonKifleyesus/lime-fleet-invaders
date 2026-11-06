// Fleet Invaders Live: the big screen. It runs the whole game; phones only steer.
(() => {
  'use strict';

  const CFG = window.FLEET_LIVE;
  const params = new URLSearchParams(location.search);
  const T = { count: 8, play: Number(params.get('round')) || 180, results: 12, inter: 8 };
  const COL = { amber: '#E69F00', sky: '#56B4E9', jade: '#009E73', sun: '#F0E442', cobalt: '#0072B2', ember: '#D55E00', orchid: '#CC79A7' };
  const INK = { amber: '#1A1200', sky: '#03131F', jade: '#00140E', sun: '#1A1800', cobalt: '#F2F8FF', ember: '#1A0900', orchid: '#1C0A14' };
  const W = 1600, H = 900, GROUND = 772, LEFT = 60, RIGHT = 1290;
  const ROWS = ['engine', 'trans', 'oil', 'wrench'], COLS = 9, CW = 112, RH = 76;
  const IDLE_MS = 30_000, IDLE_WARN_MS = 20_000;
  const SAVE_KEY = 'fleetLiveScreen';

  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n || 0).toLocaleString('en-US');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  // ------------------------------------------------------------ state

  const G = {
    creds: null, phase: 'lobby', t: 0, round: 1, wave: 1, fleet: 0, best: 0, record: false,
    roster: new Map(), buses: new Map(), stats: new Map(),
    code: '----', ends: 0, codeAt: 0, locked: false, seats: 16,
    charge: 0, shield: 0, tapLog: [], roundTaps: 0, mcCount: 0, emptyFor: 0,
    toasts: [], parts: [], pops: [], bolts: [], ebolts: [], banner: null,
    form: { t: 0, oy: -260 }, inv: [], drone: null, droneT: 12, eft: 1,
    qr: null, stars: [],
  };
  let link = null;
  const outbox = [];

  // ------------------------------------------------------------ sprites

  const SRC = {
    bus: '/sprites/bus_gunner.png', engine: '/sprites/engine_invader.png', trans: '/sprites/transmission_invader.png',
    oil: '/sprites/oil_barrel_invader.png', wrench: '/sprites/wrench_tool_invader.png', drone: '/sprites/zero_fault_drone.png',
  };
  const BUS = {}, INV = {};
  let GREY = null;
  function tint(img, color, w, glow) {
    const h = Math.round(img.height * w / img.width), pad = glow ? Math.round(w * 0.22) : 0;
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const x = t.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, w, h);
    x.globalCompositeOperation = 'saturation'; x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'multiply'; x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(img, 0, 0, w, h);
    if (!glow) return t;
    const c = document.createElement('canvas');
    c.width = w + pad * 2; c.height = h + pad * 2;
    const y = c.getContext('2d');
    y.shadowColor = color; y.shadowBlur = pad * 0.8; y.drawImage(t, pad, pad);
    y.shadowBlur = 0; y.drawImage(t, pad, pad);
    return c;
  }
  function scaled(img, bw, bh) {
    const s = Math.min(bw / img.width, bh / img.height);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  for (const k in SRC) {
    const im = new Image();
    im.onload = () => {
      if (k === 'bus') {
        for (const c in COL) BUS[c] = tint(im, COL[c], 150, true);
        GREY = tint(im, '#5A6156', 150, false);
      } else INV[k] = scaled(im, k === 'drone' ? 180 : 150, k === 'drone' ? 130 : 124);
    };
    im.src = SRC[k];
  }

  // ------------------------------------------------------------ canvas

  const cv = $('game'), ctx = cv.getContext('2d');
  let k = 1;
  function fit() {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(r.width * d);
    cv.height = Math.round(r.width * 9 / 16 * d);
    k = cv.width / W;
  }
  new ResizeObserver(fit).observe(cv);
  for (let i = 0; i < 110; i++) G.stars.push({ x: rand(0, W), y: rand(0, H), s: rand(0.6, 2.2), v: rand(6, 26) });

  // ------------------------------------------------------------ saved event

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return null; }
  }
  function saveCreds(c) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(c)); } catch { /* storage blocked */ }
  }
  function forgetCreds() {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* storage blocked */ }
  }

  const saved = loadSaved();
  if (saved && saved.room) $('resume').hidden = false;
  // ?seats=N picks a size that is not in the list (used for testing).
  const seatParam = Number.parseInt(params.get('seats'), 10);
  if (seatParam >= 1 && seatParam <= 32) {
    const opt = document.createElement('option');
    opt.value = String(seatParam);
    opt.textContent = String(seatParam);
    $('seats').append(opt);
    $('seats').value = String(seatParam);
  }
  $('resume-go').addEventListener('click', () => startEvent(saved, false));
  $('setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const key = $('key').value.trim();
    const err = $('setup-err');
    if (!key) { err.textContent = 'Enter the event key.'; return; }
    err.textContent = '';
    $('setup-go').disabled = true;
    try {
      const res = await fetch(CFG.relay + '/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-event-key': key },
        body: JSON.stringify({ seats: Number($('seats').value) }),
      });
      if (res.status === 401) throw new Error("That event key isn't right.");
      if (!res.ok) throw new Error('The relay refused the request (' + res.status + ').');
      const creds = await res.json();
      saveCreds(creds);
      startEvent(creds, true);
    } catch (ex) {
      err.textContent = ex instanceof TypeError ? "Can't reach the relay. Check this computer's internet connection." : ex.message;
    } finally {
      $('setup-go').disabled = false;
    }
  });

  function startEvent(creds, fresh) {
    G.creds = creds;
    G.seats = creds.seats || 16;
    try { G.best = Number(localStorage.getItem('fleetLiveBest:' + creds.room)) || 0; } catch { G.best = 0; }
    $('setup').hidden = true;
    connect();
    if (fresh) showHostQr();
  }

  function setupError(msg) {
    if (link) { link.stop(); link = null; }
    $('setup').hidden = false;
    $('resume').hidden = !loadSaved();
    $('setup-err').textContent = msg;
  }

  // ------------------------------------------------------------ host panel QR

  function drawQrTo(c, text, ink, bg) {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
    const m = c.width / n;
    x.fillStyle = ink;
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) x.fillRect(col * m, r * m, m + 0.4, m + 0.4);
  }
  function hostUrl() {
    return location.origin + '/host' + CFG.keep + '#' + G.creds.room + '.' + G.creds.host;
  }
  function showHostQr() {
    if (!G.creds) return;
    drawQrTo($('hostqr-c'), hostUrl(), '#0B1400', '#F3F7EC');
    $('hostqr-url').textContent = hostUrl();
    $('hostqr').hidden = false;
  }
  $('hostqr-close').addEventListener('click', () => { $('hostqr').hidden = true; });

  // ------------------------------------------------------------ relay

  function connect() {
    if (link) link.stop();
    link = new window.LiveLink({
      url: () => `${CFG.relayWs}/room/${G.creds.room}/ws?role=screen&key=${G.creds.host}`,
      watch: true,
      onMessage,
      onBinary,
      onState: s => { $('conn').hidden = s === 'open' || s === 'stopped'; },
    });
  }

  function onMessage(m) {
    switch (m.t) {
      case 'roster':
        G.seats = m.seats;
        G.locked = m.locked;
        setCode(m.code, m.ends);
        G.roster = new Map(m.players.map(p => [p.id, p]));
        for (const id of [...G.buses.keys()]) if (!G.roster.has(id)) removeBus(G.buses.get(id), null);
        for (const p of G.roster.values()) syncBus(p, false);
        countMission();
        break;
      case 'p':
        G.roster.set(m.p.id, m.p);
        syncBus(m.p, !!m.join);
        countMission();
        break;
      case 'code':
        setCode(m.code, m.ends);
        break;
      case 'lock':
        G.locked = m.on;
        toast(m.on ? 'The host closed the room to new players' : 'The room is open again', 'lime');
        break;
      case 'taps':
        onTaps(m);
        break;
      case 'cmd':
        if (m.c === 'start' && G.phase !== 'play' && G.phase !== 'results') startPlay();
        if (m.c === 'end' && G.phase === 'play') endRound();
        break;
      case 'replaced':
        setupError('This event is now open on another screen.');
        break;
      case 'err':
        if (m.why === 'key' || m.why === 'room') {
          forgetCreds();
          setupError("This event can't be reopened. Start a new one.");
        }
        break;
      default:
    }
  }

  function onBinary(d) {
    if (d[0] !== 1) return;
    const t = now();
    for (let i = 1; i + 5 <= d.length; i += 5) {
      const id = (d[i] << 8) | d[i + 1];
      const bus = G.buses.get(id);
      if (!bus) continue;
      const seq = d[i + 4];
      if (bus.seq !== undefined && ((seq - bus.seq) & 255) > 128) continue; // an older message
      bus.seq = seq;
      bus.input = (d[i + 2] - 100) / 100;
      bus.lastInput = t;
      bus.benchSent = false;
    }
  }

  function setCode(code, ends) {
    if (!code) return;
    G.code = code;
    G.ends = ends;
    G.codeAt = Date.now();
    try {
      const q = window.qrcode(0, 'M');
      q.addData(location.origin + '/j/' + code + CFG.keep);
      q.make();
      const n = q.getModuleCount();
      const cells = [];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(r * n + c);
      G.qr = { n, cells };
    } catch {
      G.qr = null;
    }
  }

  function send(m) {
    if (link) link.send(m);
  }
  function toPlayer(id, msg) {
    outbox.push([id, msg]);
  }
  setInterval(() => {
    const t = now();
    for (const bus of G.buses.values()) {
      if (bus.dirty && t - bus.sentAt > 250) {
        outbox.push([bus.id, { t: 'me', hull: bus.hull, score: bus.st.score }]);
        bus.dirty = false;
        bus.sentAt = t;
      }
    }
    if (outbox.length) send({ t: 'multi', m: outbox.splice(0, 300) });
  }, 100);

  function sendTick() {
    send({ t: 'all', m: { t: 'tick', phase: G.phase, round: G.round, left: Math.ceil(G.t), fleet: G.fleet, charge: Math.floor(G.charge) } });
  }
  setInterval(sendTick, 1000);

  // ------------------------------------------------------------ players

  function countMission() {
    let n = 0;
    for (const p of G.roster.values()) if (!p.removed && p.seat === null && p.connected) n++;
    G.mcCount = n;
  }

  function statsFor(p) {
    let s = G.stats.get(p.id);
    if (!s) {
      s = { id: p.id, name: p.name, color: p.color, score: 0, kills: 0, shots: 0, hits: 0, wrecks: 0, time: 0, first: (p.rounds || 0) === 0 };
      G.stats.set(p.id, s);
    }
    s.name = p.name;
    s.color = p.color;
    return s;
  }

  function spawnX() {
    const xs = [...G.buses.values()].map(b => b.x).sort((a, b) => a - b);
    const points = [LEFT, ...xs, RIGHT];
    let best = (LEFT + RIGHT) / 2, gap = -1;
    for (let i = 0; i < points.length - 1; i++) {
      const g = points[i + 1] - points[i];
      if (g > gap) { gap = g; best = (points[i] + points[i + 1]) / 2; }
    }
    return xs.length ? best : (LEFT + RIGHT) / 2;
  }

  function syncBus(p, isJoin) {
    const bus = G.buses.get(p.id);
    const driving = p.seat !== null && !p.removed;
    if (driving && !bus) addBus(p);
    else if (!driving && bus) removeBus(bus, p);
    else if (bus) {
      bus.name = p.name;
      bus.color = p.color;
      bus.st.name = p.name;
      if (bus.connected !== p.connected) {
        bus.connected = p.connected;
        if (p.connected) bus.lastInput = now();
      }
    }
    if (isJoin && !driving) toast(p.name + ' joined Mission Control', p.color);
  }

  function addBus(p) {
    const t = now();
    const bus = {
      id: p.id, name: p.name, color: p.color, x: spawnX(), vx: 0, input: 0, lastInput: t, benchSent: false,
      hull: 3, shield: 3, spot: 2.6, wrecked: 0, flash: 0, cool: rand(0.2, 0.6), a: 0,
      connected: p.connected, dirty: true, sentAt: 0, st: statsFor(p),
    };
    G.buses.set(p.id, bus);
    toast(p.name + ' is driving', p.color);
    toPlayer(p.id, { t: 'fx', k: 'spawn' });
  }

  function removeBus(bus, p) {
    burst(bus.x, GROUND - 10, COL[bus.color] || '#B8FF38', 18);
    G.buses.delete(bus.id);
    if (!p) return;
    if (p.removed) toast(bus.name + ' was removed', 'mute');
    else if (p.queued) toast(bus.name + ' moved to Mission Control', p.color);
    else toast(bus.name + "'s bus parked", 'mute');
  }

  function toast(text, color) {
    G.toasts.unshift({ text, color, t: 0 });
    if (G.toasts.length > 6) G.toasts.length = 6;
  }

  function onTaps(m) {
    const t = now();
    G.tapLog.push([t, m.by]);
    while (G.tapLog.length && t - G.tapLog[0][0] > 1000) G.tapLog.shift();
    G.roundTaps += m.n;
    G.totalTaps = (G.totalTaps || 0) + m.n;
    if (G.phase !== 'play' || G.shield > 0) return;
    // Each phone sends its taps once a second, so this sum is about the number
    // of people tapping. Dividing by it means the whole room has to join in.
    let tappers = 0;
    for (const e of G.tapLog) tappers += e[1];
    G.charge = Math.min(100, G.charge + m.n / Math.max(3, tappers));
    if (G.charge >= 100) {
      G.charge = 0;
      G.shield = 6;
      G.banner = { text: 'Fleet shield on', t: 1.8, lime: true };
      toast('Mission Control charged the fleet shield', 'lime');
    }
  }

  // ------------------------------------------------------------ rounds

  function newWave() {
    G.inv = [];
    const n = G.buses.size;
    const extra = n >= 20 ? 2 : n >= 8 ? 1 : 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < COLS; c++) {
      G.inv.push({ r, c, type: ROWS[r], hp: (r === 0 ? 2 : 1) + extra, alive: true, hit: 0 });
    }
    G.form.oy = -260;
  }

  function startCount() {
    G.phase = 'count';
    G.t = T.count;
    if (!G.inv.some(v => v.alive)) newWave();
    sendTick();
  }

  function startPlay() {
    G.phase = 'play';
    G.t = T.play;
    G.stats = new Map();
    G.fleet = 0;
    G.charge = 0;
    G.shield = 0;
    G.roundTaps = 0;
    G.wave = 1;
    G.record = false;
    G.bolts = [];
    G.ebolts = [];
    G.eft = 1.2;
    const t = now();
    for (const bus of G.buses.values()) {
      const p = G.roster.get(bus.id) || bus;
      bus.st = statsFor(p);
      bus.hull = 3;
      bus.wrecked = 0;
      bus.lastInput = t;
      bus.benchSent = false;
      bus.dirty = true;
    }
    newWave();
    $('results').hidden = true;
    sendTick();
  }

  function endRound() {
    G.phase = 'results';
    G.t = T.results;
    G.bolts = [];
    G.ebolts = [];
    const list = [...G.stats.values()].filter(s => s.time > 5 || s.score > 0).sort((a, b) => b.score - a.score);
    const used = new Set();
    const award = (title, candidates, desc) => {
      const s = candidates.find(c => !used.has(c.id));
      if (!s) return null;
      used.add(s.id);
      return { title, s, desc: desc(s) };
    };
    const badges = [
      award('Top mechanic', list.filter(s => s.kills > 0).sort((a, b) => b.kills - a.kills), s => s.kills + ' faults fixed'),
      award('Sharpshooter', list.filter(s => s.shots >= 15).sort((a, b) => b.hits / b.shots - a.hits / a.shots), s => Math.round((s.hits / s.shots) * 100) + '% of shots hit'),
      award('Last bus running', list.filter(s => s.wrecks === 0 && s.time >= T.play * 0.5), () => 'Never wrecked'),
      award('Fresh plates', list.filter(s => s.first), s => 'Best first game: ' + fmt(s.score)),
    ].filter(Boolean);
    G.record = G.fleet > G.best && G.fleet > 0;
    if (G.record) {
      G.best = G.fleet;
      try { localStorage.setItem('fleetLiveBest:' + G.creds.room, String(G.best)); } catch { /* storage blocked */ }
    }
    list.forEach((s, i) => {
      const b = badges.find(x => x.s.id === s.id);
      toPlayer(s.id, { t: 'res', round: G.round, rank: i + 1, of: list.length, score: s.score, badge: b ? b.title : null });
    });
    showResults(list, badges);
    sendTick();
  }

  function startInter() {
    send({ t: 'rotate' });
    G.round++;
    G.phase = 'inter';
    G.t = T.inter;
    $('results').hidden = true;
    const buses = [...G.buses.values()].sort((a, b) => a.x - b.x);
    buses.forEach((b, i) => {
      b.x = LEFT + 40 + (i + 0.5) * ((RIGHT - LEFT - 80) / Math.max(1, buses.length));
      b.shield = 2;
      b.hull = 3;
      b.wrecked = 0;
      b.dirty = true;
    });
    newWave();
    sendTick();
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showResults(list, badges) {
    const box = $('results');
    box.innerHTML = '';
    const res = el('div', 'res');
    const head = el('div', 'res-head');
    const left = el('span');
    left.append(el('b', '', 'Round ' + G.round), ' complete');
    head.append(left, el('span', '', 'Next round soon · scan to play'));
    const grid = el('div', 'res-grid');
    const score = el('div', 'res-score');
    score.append(el('span', 'res-lbl', 'Fleet score'), el('span', 'led', fmt(G.fleet)));
    if (G.record) score.append(el('span', 'rec', 'New event record'));
    const podium = el('ol', 'podium');
    list.slice(0, 3).forEach((s, i) => {
      const li = el('li');
      li.style.setProperty('--c', COL[s.color]);
      li.append(el('b', '', String(i + 1)), el('span', '', s.name), el('em', '', fmt(s.score)));
      podium.append(li);
    });
    if (!list.length) podium.append(el('li', '', 'No drivers this round'));
    score.append(podium);
    const bx = el('div', 'badges');
    for (const b of badges) {
      const d = el('div', 'badge');
      d.style.setProperty('--c', COL[b.s.color]);
      d.append(el('span', 't', b.title), el('span', 'n', b.s.name), el('span', 'd', b.desc));
      bx.append(d);
    }
    grid.append(score, bx);
    const wall = el('div', 'wall');
    wall.append(el('b', 'res-lbl', list.length + (list.length === 1 ? ' driver' : ' drivers')));
    for (const s of list) {
      const pill = el('span', '', s.name);
      pill.style.setProperty('--c', COL[s.color]);
      pill.style.setProperty('--ci', INK[s.color]);
      wall.append(pill);
    }
    wall.append(el('span', 'mcount', 'Mission Control: ' + G.mcCount + ' players · ' + fmt(G.roundTaps) + ' taps'));
    res.append(head, grid, wall);
    box.append(res);
    box.hidden = false;
  }

  // ------------------------------------------------------------ simulation

  function invPos(v) {
    return { x: 200 + Math.sin(G.form.t * 0.42) * 95 + v.c * CW, y: G.form.oy + v.r * RH };
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = rand(80, 360);
      G.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.35, 0.8), max: 0.8, color: Math.random() < 0.25 ? '#FF8A1F' : color, size: rand(2, 5) });
    }
  }

  function addScore(bus, pts) {
    bus.st.score = Math.max(0, bus.st.score + pts);
    bus.dirty = true;
  }

  function update(dt) {
    const t = now();
    G.form.t += dt;
    for (const s of G.stars) { s.y += s.v * dt; if (s.y > H) { s.y = -4; s.x = rand(0, W); } }
    for (const tt of G.toasts) tt.t += dt;
    G.toasts = G.toasts.filter(x => x.t < 9);
    if (G.banner) { G.banner.t -= dt; if (G.banner.t <= 0) G.banner = null; }

    // phases
    const n = G.buses.size;
    if (G.phase === 'lobby') {
      if (n > 0) startCount();
    } else if (G.phase === 'count') {
      G.t -= dt;
      if (n === 0) { G.phase = 'lobby'; sendTick(); } else if (G.t <= 0) startPlay();
    } else if (G.phase === 'play') {
      G.t -= dt;
      G.emptyFor = n === 0 ? G.emptyFor + dt : 0;
      if (G.emptyFor > 8) { G.phase = 'lobby'; G.emptyFor = 0; sendTick(); }
      else if (G.t <= 0) endRound();
    } else if (G.phase === 'results') {
      G.t -= dt;
      if (G.t <= 0) startInter();
    } else if (G.phase === 'inter') {
      G.t -= dt;
      if (G.t <= 0) { if (n > 0) startPlay(); else { G.phase = 'lobby'; sendTick(); } }
    }
    const playing = G.phase === 'play';

    // formation
    const maxY = 250 + Math.min(G.wave * 18, 110);
    if (G.form.oy < 180) G.form.oy = Math.min(180, G.form.oy + dt * 320);
    else if (playing) G.form.oy = Math.min(maxY, G.form.oy + dt * (2 + G.wave * 0.6));
    if (playing && G.form.oy >= 150 && !G.inv.some(v => v.alive)) {
      G.banner = { text: 'Wave ' + G.wave + ' cleared', t: 1.8 };
      for (const b of G.buses.values()) if (!b.wrecked) addScore(b, 100);
      G.wave++;
      newWave();
    }

    // enemy fire scales gently with the number of drivers
    if (playing && G.form.oy >= 150) {
      G.eft -= dt;
      if (G.eft <= 0) {
        G.eft = clamp(0.62 / Math.sqrt(Math.max(1, n)), 0.15, 0.62) * rand(0.7, 1.3);
        const cols = [...new Set(G.inv.filter(v => v.alive).map(v => v.c))];
        if (cols.length) {
          const c = cols[Math.floor(Math.random() * cols.length)];
          const low = G.inv.filter(v => v.alive && v.c === c).sort((a, b) => b.r - a.r)[0];
          const p = invPos(low);
          G.ebolts.push({ x: p.x, y: p.y + 30, vy: rand(250, 320) + G.wave * 6 });
        }
      }
      G.droneT -= dt;
      if (G.droneT <= 0 && !G.drone) { G.drone = { x: -90, y: 128, hp: 2 }; G.droneT = rand(14, 22); }
    }
    if (G.drone) { G.drone.x += dt * 230; if (G.drone.x > RIGHT + 100) G.drone = null; }

    // buses
    for (const b of G.buses.values()) {
      b.flash = Math.max(0, b.flash - dt);
      b.shield = Math.max(0, b.shield - dt);
      b.spot = Math.max(0, b.spot - dt);
      b.a = Math.min(1, b.a + dt * 2);
      if (playing) b.st.time += dt;
      if (b.wrecked > 0) {
        b.wrecked -= dt;
        if (b.wrecked <= 0) {
          b.wrecked = 0; b.hull = 3; b.shield = 2.5; b.dirty = true;
          toPlayer(b.id, { t: 'fx', k: 'spawn' });
        }
        continue;
      }
      const input = b.connected ? b.input : 0;
      b.vx += (input * 560 - b.vx) * Math.min(1, dt * 14);
      b.x = clamp(b.x + b.vx * dt, LEFT, RIGHT);
      if (playing && b.connected) {
        b.cool -= dt;
        if (b.cool <= 0) {
          G.bolts.push({ x: b.x - 3, y: GROUND - 50, vy: -840, b });
          b.st.shots++;
          b.cool = 0.5;
        }
        if (!b.benchSent && t - b.lastInput > IDLE_MS) {
          b.benchSent = true;
          send({ t: 'bench', id: b.id });
        }
      }
    }
    // keep buses from stacking on top of each other
    const sorted = [...G.buses.values()].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1], gap = b.x - a.x;
      if (gap < 30) { const push = (30 - gap) / 2; a.x = clamp(a.x - push, LEFT, RIGHT); b.x = clamp(b.x + push, LEFT, RIGHT); }
    }

    // player shots
    for (const p of G.bolts) {
      p.y += p.vy * dt;
      if (G.drone && Math.abs(p.x - G.drone.x) < 52 && Math.abs(p.y - G.drone.y) < 32) {
        p.dead = true;
        G.drone.hp--;
        burst(p.x, p.y, COL[p.b.color], 8);
        if (G.drone.hp <= 0) {
          burst(G.drone.x, G.drone.y, COL[p.b.color], 26);
          G.pops.push({ x: G.drone.x, y: G.drone.y, text: 'Zero Fault +150', color: COL[p.b.color], life: 1.2 });
          addScore(p.b, 150);
          p.b.st.hits++;
          toPlayer(p.b.id, { t: 'fx', k: 'kill' });
          G.drone = null;
        }
        continue;
      }
      for (const v of G.inv) {
        if (!v.alive) continue;
        const q = invPos(v);
        if (Math.abs(p.x - q.x) < 36 && Math.abs(p.y - q.y) < 30) {
          p.dead = true;
          v.hp--;
          v.hit = 0.12;
          p.b.st.hits++;
          if (v.hp <= 0) {
            v.alive = false;
            const pts = v.r === 0 ? 60 : 40;
            burst(q.x, q.y, COL[p.b.color], 16);
            G.pops.push({ x: q.x, y: q.y, text: '+' + pts, color: COL[p.b.color], life: 0.8 });
            addScore(p.b, pts);
            p.b.st.kills++;
            toPlayer(p.b.id, { t: 'fx', k: 'kill' });
          } else burst(p.x, p.y, COL[p.b.color], 5);
          break;
        }
      }
      if (p.y < 60) p.dead = true;
    }
    G.bolts = G.bolts.filter(p => !p.dead && G.buses.has(p.b.id));

    // enemy shots
    for (const e of G.ebolts) {
      e.y += e.vy * dt;
      if (G.shield > 0) {
        const dx = (e.x - 675) / 700, dy = (e.y - (GROUND + 70)) / 230;
        if (dx * dx + dy * dy < 1) { e.dead = true; burst(e.x, e.y, '#B8FF38', 6); continue; }
      }
      for (const b of G.buses.values()) {
        if (b.wrecked > 0) continue;
        if (Math.abs(e.x - b.x) < 30 && e.y > GROUND - 44 && e.y < GROUND + 20) {
          e.dead = true;
          if (b.shield > 0) { burst(e.x, e.y, COL[b.color], 6); break; }
          b.flash = 0.4;
          b.hull--;
          b.dirty = true;
          burst(e.x, e.y, '#FF8A1F', 10);
          if (b.hull <= 0) {
            b.wrecked = 3;
            b.st.wrecks++;
            addScore(b, -100);
            burst(b.x, GROUND - 10, COL[b.color], 30);
            toPlayer(b.id, { t: 'fx', k: 'wreck' });
          } else toPlayer(b.id, { t: 'fx', k: 'hit' });
          break;
        }
      }
      if (e.y > H) e.dead = true;
    }
    G.ebolts = G.ebolts.filter(e => !e.dead);

    for (const p of G.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy = p.vy * 0.96 + 140 * dt; p.life -= dt; }
    G.parts = G.parts.filter(p => p.life > 0);
    for (const p of G.pops) { p.y -= 40 * dt; p.life -= dt; }
    G.pops = G.pops.filter(p => p.life > 0);
    for (const v of G.inv) v.hit = Math.max(0, v.hit - dt);
    if (G.shield > 0) G.shield -= dt;

    let fleet = 0;
    for (const s of G.stats.values()) fleet += s.score;
    G.fleet = fleet;
  }

  // ------------------------------------------------------------ drawing

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const F = (w, s, f) => `${w} ${s}px ${f === 'led' ? 'Doto, "Courier New", monospace' : f === 'ui' ? 'Barlow, "Segoe UI", sans-serif' : '"Barlow Condensed", "Arial Narrow", sans-serif'}`;
  function text(t, x, y, font, color, align) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.fillText(t, x, y);
  }
  const clock = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function render() {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#050805'); bg.addColorStop(0.7, '#0A1208'); bg.addColorStop(1, '#0E1A0A');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(243,247,236,.55)';
    for (const s of G.stars) { ctx.globalAlpha = s.s / 3; ctx.fillRect(s.x, s.y, s.s, s.s); }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(184,255,56,.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) { const y = GROUND + 30 + i * i * 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1310, y); ctx.stroke(); }

    for (const v of G.inv) {
      if (!v.alive) continue;
      const p = invPos(v), im = INV[v.type];
      if (!im) continue;
      const w = im.width / 2, h = im.height / 2;
      ctx.globalAlpha = v.hit > 0 ? 0.55 : 1;
      ctx.drawImage(im, p.x - w / 2, p.y - h / 2, w, h);
    }
    ctx.globalAlpha = 1;
    if (G.drone && INV.drone) { const im = INV.drone; ctx.drawImage(im, G.drone.x - im.width / 4, G.drone.y - im.height / 4, im.width / 2, im.height / 2); }

    for (const e of G.ebolts) {
      const g = ctx.createLinearGradient(0, e.y - 18, 0, e.y + 8);
      g.addColorStop(0, 'rgba(255,138,31,0)'); g.addColorStop(1, '#FF8A1F');
      ctx.fillStyle = g; rr(e.x - 3, e.y - 18, 6, 26, 3); ctx.fill();
    }
    for (const p of G.bolts) {
      ctx.fillStyle = COL[p.b.color];
      rr(p.x - 2.5, p.y - 14, 5, 20, 2.5); ctx.fill();
    }
    for (const p of G.parts) { ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size); }
    ctx.globalAlpha = 1;

    if (G.shield > 0) {
      const a = Math.min(1, G.shield) * 0.9;
      ctx.save();
      ctx.globalAlpha = a; ctx.strokeStyle = '#B8FF38'; ctx.lineWidth = 3; ctx.shadowColor = '#B8FF38'; ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.ellipse(675, GROUND + 70, 700, 230, 0, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.shadowBlur = 0; ctx.globalAlpha = a * 0.07; ctx.fillStyle = '#B8FF38'; ctx.fill();
      ctx.restore();
    }
    const gl = ctx.createLinearGradient(0, 0, 1310, 0);
    gl.addColorStop(0, 'rgba(184,255,56,0)'); gl.addColorStop(0.5, 'rgba(184,255,56,.45)'); gl.addColorStop(1, 'rgba(184,255,56,0)');
    ctx.fillStyle = gl; ctx.fillRect(0, GROUND + 26, 1310, 2);

    drawBuses();
    for (const p of G.pops) { ctx.globalAlpha = Math.min(1, p.life * 2); text(p.text, p.x, p.y, F(800, 20, 'd'), p.color, 'center'); }
    ctx.globalAlpha = 1;
    drawHud();
    drawSide();
    drawCenter();
  }

  function drawBuses() {
    const t = now();
    for (const b of G.buses.values()) {
      if (b.wrecked > 0) {
        ctx.globalAlpha = 0.35; ctx.strokeStyle = COL[b.color]; ctx.setLineDash([6, 6]);
        rr(b.x - 36, GROUND - 34, 72, 60, 10); ctx.stroke(); ctx.setLineDash([]);
        text(String(Math.ceil(b.wrecked)), b.x, GROUND + 6, F(900, 30, 'led'), COL[b.color], 'center');
        ctx.globalAlpha = 1;
        continue;
      }
      const blink = b.flash > 0 && Math.floor(b.flash * 20) % 2 ? 0.35 : 1;
      ctx.globalAlpha = b.a * 0.35;
      ctx.fillStyle = COL[b.color];
      ctx.beginPath(); ctx.ellipse(b.x, GROUND + 22, 36, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = b.a * blink;
      const im = b.connected ? BUS[b.color] : GREY;
      if (im) { const w = im.width / 2, h = im.height / 2; ctx.drawImage(im, b.x - w / 2, GROUND - h / 2 - 6, w, h); }
      if (b.shield > 0) {
        ctx.strokeStyle = COL[b.color]; ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(t / 90);
        ctx.beginPath(); ctx.arc(b.x, GROUND - 6, 48, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // name tags in two rows so neighbours don't collide
    const order = [...G.buses.values()].sort((a, b) => a.x - b.x);
    order.forEach((b, i) => {
      const y = GROUND + 48 + (i % 2) * 28;
      ctx.font = F(700, 17, 'd');
      const label = b.name.toUpperCase();
      const w = ctx.measureText(label).width + 18;
      ctx.globalAlpha = b.a * (b.connected ? 1 : 0.5);
      ctx.fillStyle = COL[b.color]; rr(b.x - w / 2, y - 13, w, 24, 12); ctx.fill();
      ctx.fillStyle = INK[b.color]; ctx.textAlign = 'center'; ctx.fillText(label, b.x, y + 5);
      ctx.globalAlpha = 1;
      const idle = now() - b.lastInput;
      let note = null, color = COL[b.color];
      if (!b.connected) { note = 'RECONNECTING'; color = '#AEB8A6'; }
      else if (b.spot > 0) note = 'NEW DRIVER';
      else if (G.phase === 'play' && idle > IDLE_WARN_MS) { note = 'STILL THERE?'; color = '#FF8A1F'; }
      if (note) {
        ctx.globalAlpha = b.spot > 0 ? Math.min(1, b.spot) : 1;
        text(note, b.x, GROUND - 78, F(800, 18, 'd'), color, 'center');
        if (b.spot > 0) {
          ctx.strokeStyle = COL[b.color]; ctx.lineWidth = 2;
          ctx.globalAlpha = Math.min(1, b.spot) * 0.6;
          ctx.beginPath(); ctx.arc(b.x, GROUND - 6, 60 + (2.6 - b.spot) * 40, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    });
  }

  function drawHud() {
    text('ROUND ' + G.round, 40, 44, F(700, 19, 'd'), '#AEB8A6');
    const label = { lobby: 'WAITING', count: 'STARTING', play: clock(G.t), results: 'RESULTS', inter: 'NEXT ROUND' }[G.phase];
    text(label, 38, 94, G.phase === 'play' ? F(900, 48, 'led') : F(800, 40, 'd'), '#F3F7EC');
    text('FLEET SCORE', 560, 44, F(700, 19, 'd'), '#AEB8A6', 'center');
    text(fmt(G.fleet), 560, 96, F(900, 52, 'led'), '#B8FF38', 'center');
    const mx = 830, mw = 440;
    text('MISSION CONTROL', mx, 44, F(700, 19, 'd'), '#AEB8A6');
    text(G.mcCount + (G.mcCount === 1 ? ' PLAYER' : ' PLAYERS'), mx + 150, 44, F(700, 19, 'd'), '#F3F7EC');
    text(G.shield > 0 ? 'SHIELD ON' : 'SHIELD ' + Math.floor(G.charge) + '%', mx + mw, 44, F(800, 19, 'd'), G.shield > 0 ? '#B8FF38' : '#F3F7EC', 'right');
    ctx.fillStyle = 'rgba(243,247,236,.1)'; rr(mx, 60, mw, 12, 6); ctx.fill();
    const fill = G.shield > 0 ? mw * Math.min(1, G.shield / 6) : mw * G.charge / 100;
    const mg = ctx.createLinearGradient(mx, 0, mx + mw, 0);
    mg.addColorStop(0, '#6E9F1F'); mg.addColorStop(1, '#B8FF38');
    ctx.fillStyle = mg; rr(mx, 60, Math.max(12, fill), 12, 6); ctx.fill();
    text('Tap together on your phone to charge it', mx, 98, F(500, 16, 'ui'), '#859079');
  }

  function drawSide() {
    const cx = 1330, cw = 246;
    ctx.fillStyle = '#F3F7EC'; rr(cx, 26, cw, 318, 18); ctx.fill();
    if (G.locked) {
      text('ROOM', cx + cw / 2, 150, F(800, 44, 'd'), '#0B1400', 'center');
      text('CLOSED', cx + cw / 2, 196, F(800, 44, 'd'), '#0B1400', 'center');
      text('Ask at the booth', cx + cw / 2, 236, F(600, 17, 'ui'), '#4A5540', 'center');
    } else if (G.qr) {
      const size = 180, m = size / G.qr.n;
      ctx.fillStyle = '#0B1400';
      for (const cell of G.qr.cells) {
        const r = Math.floor(cell / G.qr.n), c = cell % G.qr.n;
        ctx.fillRect(cx + 33 + c * m, 48 + r * m, m + 0.35, m + 0.35);
      }
      text('SCAN TO PLAY', cx + cw / 2, 264, F(800, 28, 'd'), '#0B1400', 'center');
      text('or type the code', cx + 22, 300, F(500, 15, 'ui'), '#4A5540');
      text(G.code, cx + 22, 334, F(900, 34, 'led'), '#0B1400');
      const total = Math.max(1, G.ends - G.codeAt);
      const pr = clamp((G.ends - Date.now()) / total, 0, 1);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(11,20,0,.15)'; ctx.beginPath(); ctx.arc(cx + cw - 34, 318, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#0B1400'; ctx.beginPath(); ctx.arc(cx + cw - 34, 318, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); ctx.stroke();
    } else {
      text('CONNECTING', cx + cw / 2, 180, F(800, 32, 'd'), '#0B1400', 'center');
    }
    text('DRIVERS', cx, 392, F(700, 17, 'd'), '#859079');
    text(G.buses.size + '/' + G.seats, cx, 430, F(900, 34, 'led'), '#F3F7EC');
    text('MISSION CONTROL', cx + 120, 392, F(700, 17, 'd'), '#859079');
    text(String(G.mcCount), cx + 120, 430, F(900, 34, 'led'), '#B8FF38');
    ctx.fillStyle = 'rgba(243,247,236,.1)'; ctx.fillRect(cx, 456, cw, 1);
    let ty = 494;
    for (const tt of G.toasts) {
      ctx.globalAlpha = tt.t < 0.3 ? tt.t / 0.3 : tt.t > 7 ? Math.max(0, (9 - tt.t) / 2) : 1;
      const c = tt.color === 'lime' ? '#B8FF38' : tt.color === 'mute' ? '#859079' : COL[tt.color] || '#AEB8A6';
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx + 6, ty - 6, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = F(600, 16, 'ui'); ctx.fillStyle = '#E3E9DB'; ctx.textAlign = 'left';
      let s = tt.text;
      while (ctx.measureText(s).width > cw - 22 && s.length > 4) s = s.slice(0, -2);
      if (s !== tt.text) s = s.trim() + '…';
      ctx.fillText(s, cx + 20, ty);
      ty += 36;
    }
    ctx.globalAlpha = 1;
  }

  function drawCenter() {
    const cx = 660;
    if (G.phase === 'lobby') {
      ctx.fillStyle = 'rgba(5,7,5,.55)'; ctx.fillRect(0, 300, 1310, 300);
      text('SCAN TO DRIVE', cx, 430, F(800, 96, 'd'), '#B8FF38', 'center');
      text('The first ' + G.seats + ' phones each drive a bus. Everyone after that joins Mission Control.', cx, 486, F(500, 24, 'ui'), '#E3E9DB', 'center');
    } else if (G.phase === 'count') {
      text('ROUND ' + G.round + ' STARTS IN', cx, 380, F(800, 40, 'd'), '#F3F7EC', 'center');
      text(String(Math.max(1, Math.ceil(G.t))), cx, 520, F(900, 150, 'led'), '#B8FF38', 'center');
      text('Find the bus in your colour and drag on your phone to steer', cx, 580, F(500, 22, 'ui'), '#AEB8A6', 'center');
    } else if (G.phase === 'inter') {
      text('NEXT ROUND IN ' + Math.max(1, Math.ceil(G.t)), cx, 450, F(800, 64, 'd'), '#F3F7EC', 'center');
      text('New drivers: find the bus in your colour', cx, 500, F(500, 24, 'ui'), '#AEB8A6', 'center');
    }
    if (G.banner) {
      ctx.globalAlpha = Math.min(1, G.banner.t * 2);
      text(G.banner.text.toUpperCase(), cx, 470, F(800, 64, 'd'), G.banner.lime ? '#B8FF38' : '#F3F7EC', 'center');
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------ loop and keys

  let last = now();
  function frame(ts) {
    const dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const key = e.key.toLowerCase();
    if (key === 'h' && G.creds) { if ($('hostqr').hidden) showHostQr(); else $('hostqr').hidden = true; }
    if (key === 'f') { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); }
    if (key === 's' && G.creds && G.phase !== 'play' && G.phase !== 'results') startPlay();
    if (key === 'e' && G.phase === 'play') endRound();
  });

  // For automated tests.
  window.FleetScreen = { G, startPlay, endRound };
})();
