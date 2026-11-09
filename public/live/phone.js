// Fleet Invaders Live: the phone controller.
(function () {
  'use strict';

  var CFG = window.FLEET_LIVE;
  var COL = { amber: '#E69F00', sky: '#56B4E9', jade: '#009E73', sun: '#F0E442', cobalt: '#0072B2', ember: '#D55E00', orchid: '#CC79A7' };
  var INK = { amber: '#1A1200', sky: '#03131F', jade: '#00140E', sun: '#1A1800', cobalt: '#F2F8FF', ember: '#1A0900', orchid: '#1C0A14' };
  var PARTS = ['PISTON', 'GEARBOX', 'AXLE', 'DIESEL', 'CLUTCH', 'SPARK', 'TORQUE', 'TURBO', 'VALVE', 'BRAKE',
    'MUFFLER', 'RADIATOR', 'WIPER', 'FUSE', 'SPOKE', 'CHASSIS', 'BUMPER', 'IGNITION', 'CAMSHAFT', 'ROTOR',
    'HUBCAP', 'WRENCH', 'RATCHET', 'GASKET', 'BEARING', 'PULLEY', 'SHIFTER', 'THROTTLE', 'MIRROR', 'HEADLIGHT'];
  var SCREENS = ['s-connect', 's-code', 's-join', 's-drive', 's-line', 's-bench', 's-bye'];
  var STORE = 'fleetLive';

  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var fmt = function (n) { return Math.round(n || 0).toLocaleString('en-US'); };
  var clock = function (s) { s = Math.max(0, Math.ceil(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var ordinal = function (n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  var S = {
    code: null, room: null, token: null, id: null, joined: false,
    name: '', part: '', custom: false, nameSet: false, rerolls: 3, color: 'amber',
    seat: null, line: 0, phase: 'lobby', round: 1, left: 0, fleet: 0, charge: 0,
    hull: 3, score: 0, taps: 0, joining: false,
  };
  var link = null;
  var current = 's-connect';

  // ------------------------------------------------------------ storage

  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (v && v.token && Date.now() - v.at < 6 * 3600e3) return v;
    } catch (e) { /* storage blocked */ }
    return null;
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ room: S.room, token: S.token, at: Date.now() })); } catch (e) { /* storage blocked */ }
  }
  function forget() {
    try { localStorage.removeItem(STORE); } catch (e) { /* storage blocked */ }
  }

  // ------------------------------------------------------------ screens

  function show(id) {
    current = id;
    SCREENS.forEach(function (s) { $(s).hidden = s !== id; });
  }

  var slowTimer = null;
  var SLOW_NET = "Still trying. If you're on the venue Wi-Fi, turn Wi-Fi off to use mobile data.";
  var SLOW_SCREEN = "Your phone is connected. The big screen isn't answering: ask the host to check it's open and in front. You'll join as soon as it's back.";

  // hint: shown after a few seconds; it says what is most likely wrong.
  function connecting(msg, hint) {
    show('s-connect');
    $('connect-msg').textContent = msg || 'Connecting to the big screen…';
    $('slow').textContent = hint || SLOW_NET;
    $('slow').hidden = true;
    $('new-code').hidden = true;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(function () {
      if (current !== 's-connect') return;
      $('slow').hidden = false;
      // The big screen isn't answering: this may be an old link or an event
      // that has ended. Let the player type the code on the big screen now.
      $('new-code').hidden = hint !== SLOW_SCREEN;
    }, 4500);
  }

  function showCode(msg) {
    if (link) { link.stop(); link = null; }
    show('s-code');
    $('code-err').textContent = msg || '';
    $('code-in').value = '';
  }

  var BYE = {
    removed: ['You were removed', 'The host removed you from this game.'],
    ended: ['This game has ended', 'Thanks for playing. Scan the code on the big screen to join the next one.'],
    left: ['Thanks for playing', 'You left the game. Scan the code again any time to rejoin.'],
    locked: ['The room is closed', "The host isn't letting new players in right now. Ask at the booth."],
    full: ['The room is full', 'Try again in a few minutes.'],
    error: ['Something went wrong', 'Scan the code on the big screen again.'],
  };
  function bye(why) {
    if (link) { link.stop(); link = null; }
    S.joined = false;
    var t = BYE[why] || BYE.error;
    $('bye-h').textContent = t[0];
    $('bye-p').textContent = t[1];
    $('bye-again').hidden = why === 'removed';
    show('s-bye');
  }

  // ------------------------------------------------------------ colour

  var busImg = new Image();
  busImg.src = '/sprites/bus_gunner.png';
  function tinted(color) {
    var w = 360, h = Math.round(busImg.height * w / busImg.width);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.drawImage(busImg, 0, 0, w, h);
    x.globalCompositeOperation = 'saturation'; x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'multiply'; x.fillStyle = color; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(busImg, 0, 0, w, h);
    return c.toDataURL();
  }
  function applyColor() {
    var root = document.documentElement.style;
    root.setProperty('--pc', COL[S.color] || COL.amber);
    root.setProperty('--pci', INK[S.color] || INK.amber);
    $('s-drive').classList.toggle('light-ink', S.color === 'cobalt');
    var paint = function () { try { $('j-ava').src = tinted(COL[S.color]); } catch (e) { /* keep the plain bus */ } };
    if (busImg.complete && busImg.naturalWidth) paint(); else busImg.onload = paint;
  }

  // ------------------------------------------------------------ connection

  function codeFromUrl() {
    var m = location.pathname.match(/\/j\/([A-Za-z0-9]{4})\/?$/);
    var c = m ? m[1] : new URLSearchParams(location.search).get('code');
    return c ? c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : null;
  }

  function linkUrl() {
    if (S.token) return CFG.ws + '?room=' + S.room + '&role=phone&token=' + encodeURIComponent(S.token);
    return CFG.ws + '?code=' + encodeURIComponent(S.code);
  }

  function open() {
    if (link) link.stop();
    link = new window.LiveLink({ url: linkUrl, watch: true, onMessage: onMessage, onState: onState });
  }

  function startCode(code) {
    S.triedCode = true;
    S.code = code;
    S.token = null;
    S.joined = false;
    connecting();
    open();
  }

  function startToken(saved) {
    S.room = saved.room;
    S.token = saved.token;
    connecting('Getting your seat back…');
    open();
  }

  function onState(state) {
    var conn = $('d-conn');
    if (state === 'open') {
      conn.textContent = 'Connected';
      conn.classList.remove('off');
    } else if (S.joined && (state === 'retry' || state === 'connecting')) {
      conn.textContent = 'Reconnecting…';
      conn.classList.add('off');
    }
  }

  function onMessage(m) {
    switch (m.t) {
      case 'hi': return onHi(m);
      case 'err': return onError(m);
      case 'welcome': return onWelcome(m);
      case 'seat':
        S.seat = m.seat; S.line = m.line;
        route(m.why);
        return;
      case 'wait':
        if (!S.joined) {
          // Getting a seat back in an event whose big screen isn't answering,
          // while this page was opened with a join code: that code is likely
          // a newer event (a freshly scanned QR), so join with it instead.
          var c = codeFromUrl();
          if (S.token && c && !S.triedCode) {
            forget();
            S.token = null;
            if (link) { link.stop(); link = null; }
            startCode(c);
            return;
          }
          connecting('Waiting for the big screen…', SLOW_SCREEN);
        }
        return;
      case 'tick': return onTick(m);
      case 'me':
        if (m.hull !== undefined) S.hull = m.hull;
        if (m.score !== undefined) S.score = m.score;
        renderMe();
        return;
      case 'fx': return fx(m.k);
      case 'mv': return onMove(m);
      case 'res': return showCard(m);
      case 'name':
        S.name = m.name;
        $('d-name').textContent = S.name;
        return;
      case 'bye':
        forget();
        return bye(m.why);
      default:
    }
  }

  function onHi(m) {
    S.color = m.color;
    S.code = m.code || S.code;
    if (!S.nameSet) {
      S.name = m.name;
      S.part = m.name.split(' ').slice(1).join(' ');
    } else if (!S.custom) {
      S.name = S.color.toUpperCase() + ' ' + S.part;
    }
    applyColor();
    renderJoin();
    S.joining = false;
    $('j-play').disabled = false;
    $('j-play').textContent = 'Play';
    show('s-join');
  }

  function onError(m) {
    var why = m.why;
    if (why === 'name') {
      S.joining = false;
      $('j-play').disabled = false;
      $('j-play').textContent = 'Play';
      $('j-err').textContent = m.detail === 'long' ? 'Use 16 characters or fewer.' : "That name isn't allowed. Try another, or tap New name.";
      show('s-join');
      return;
    }
    if (why === 'noscreen' && S.token && (S.offline = (S.offline || 0) + 1) <= 20) {
      // The big screen is reloading or asleep: keep the seat and try again.
      if (link) { link.stop(); link = null; }
      connecting('The big screen is offline. Trying again…', SLOW_SCREEN);
      setTimeout(function () { if (current === 's-connect') open(); }, 15000);
      return;
    }
    if (why === 'noscreen' && !S.token && S.code && (S.offline = (S.offline || 0) + 1) <= 8) {
      // A new player whose big screen went quiet: keep trying the same code.
      // If the code runs out meanwhile, the code screen asks for the new one.
      if (link) { link.stop(); link = null; }
      connecting('The big screen is offline. Trying again…', SLOW_SCREEN);
      setTimeout(function () { if (current === 's-connect') open(); }, 10000);
      return;
    }
    if (why === 'token' || why === 'ended' || why === 'room' || why === 'noscreen') {
      forget();
      S.token = null;
      S.joined = false;
      var code = codeFromUrl();
      if (link) { link.stop(); link = null; }
      if (code && !S.triedCode) startCode(code); else bye('ended');
      return;
    }
    if (why === 'code') {
      showCode(S.nameSet || current === 's-join'
        ? 'The code changed while you were choosing. Type the code on the big screen now.'
        : 'That code has expired. Type the code on the big screen now.');
      return;
    }
    if (why === 'slow') {
      if (link) { link.stop(); link = null; }
      connecting('Lots of people are joining. Trying again…');
      setTimeout(function () { if (current === 's-connect') startCode(S.code); }, 4000);
      return;
    }
    bye(why === 'locked' || why === 'full' ? why : 'error');
  }

  function onWelcome(m) {
    S.joined = true;
    S.joining = false;
    S.offline = 0;
    S.id = m.id; S.token = m.token; S.room = m.room;
    S.name = m.name; S.color = m.color; S.seat = m.seat; S.line = m.line;
    save();
    applyColor();
    $('d-name').textContent = S.name;
    $('d-sub').textContent = 'Driver ' + String(S.id).padStart(2, '0') + ' · the ' + S.color + ' bus';
    wake();
    route();
  }

  function route(why) {
    if (!S.joined) return;
    if (S.seat !== null) {
      if (current !== 's-drive') { S.hull = 3; renderMe(); }
      show('s-drive');
      renderTick();
    } else if (S.line > 0) {
      show('s-line');
      renderLine();
    } else {
      $('b-line').disabled = false;
      show('s-bench');
      void why;
    }
  }

  // ------------------------------------------------------------ join screen

  function renderJoin() {
    $('j-code').textContent = S.code || '----';
    $('j-name').textContent = S.name;
    $('j-col').textContent = 'Your colour is ' + S.color;
    $('j-reroll').textContent = S.rerolls > 0 ? 'New name (' + S.rerolls + ' left)' : 'No more new names';
    $('j-reroll').disabled = S.rerolls <= 0;
    $('j-err').textContent = '';
  }

  $('j-reroll').addEventListener('click', function () {
    if (S.rerolls <= 0) return;
    var part;
    do { part = PARTS[Math.floor(Math.random() * PARTS.length)]; } while (part === S.part);
    S.part = part;
    S.rerolls--;
    S.custom = false;
    S.nameSet = true;
    S.name = S.color.toUpperCase() + ' ' + part;
    renderJoin();
  });

  $('j-own').addEventListener('click', function () {
    $('j-own-row').hidden = false;
    $('j-own-in').value = S.custom ? S.name : '';
    $('j-own-in').focus();
  });

  function useOwn() {
    var v = $('j-own-in').value.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!v) { $('j-err').textContent = 'Type a name first.'; return; }
    if ([...v].length > 16) { $('j-err').textContent = 'Use 16 characters or fewer.'; return; }
    S.name = v;
    S.custom = true;
    S.nameSet = true;
    $('j-own-row').hidden = true;
    renderJoin();
  }
  $('j-own-ok').addEventListener('click', useOwn);
  $('j-own-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') useOwn(); });

  $('j-play').addEventListener('click', function () {
    if (!$('j-own-row').hidden && $('j-own-in').value.trim()) useOwn();
    if (S.joining) return;
    if (!link || !link.send({ t: 'join', name: S.name, custom: S.custom, share: $('j-share').checked, color: S.color })) {
      $('j-err').textContent = 'Still connecting. Try again in a second.';
      return;
    }
    S.joining = true;
    $('j-play').disabled = true;
    $('j-play').textContent = 'Joining…';
    wake();
    vibrate(1);
  });

  // ------------------------------------------------------------ code screen

  var codeIn = $('code-in');
  codeIn.addEventListener('input', function () {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  function submitCode() {
    var c = codeIn.value;
    if (c.length !== 4) { $('code-err').textContent = 'The code has 4 characters.'; return; }
    try { history.replaceState(null, '', '/j/' + c + CFG.keep); } catch (e) { /* ignore */ }
    startCode(c);
  }
  $('code-go').addEventListener('click', submitCode);
  $('new-code').addEventListener('click', function () {
    // Give up on the old event and join whatever is on the big screen now.
    forget();
    S.token = null;
    S.joined = false;
    S.offline = 0;
    showCode('Type the code shown on the big screen now.');
  });
  codeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitCode(); });
  $('bye-again').addEventListener('click', function () { showCode(''); });

  // ------------------------------------------------------------ driving

  var strip = $('strip');
  var ctrl = { on: false, ax: 0, q: 0, lastQ: null, lastSend: 0, seq: 0, timer: null, keep: null, key: 0, btn: 0 };

  function knob(d, axPct) {
    strip.style.setProperty('--kx', clamp(axPct + d * 32, 12, 88) + '%');
    strip.style.setProperty('--ax', axPct + '%');
  }

  function sendInput(q) {
    ctrl.lastQ = q;
    ctrl.lastSend = performance.now();
    ctrl.seq = (ctrl.seq + 1) & 255;
    // Byte 2: bit 0 = touching, then the moves: 2 dash, 4 shield, 8 charge.
    if (link) link.sendRaw(new Uint8Array([q + 100, 1 | ctrl.btn, ctrl.seq]));
  }

  // Sends only when the stick moved, at most 20 times a second.
  function trySend() {
    if (ctrl.q === ctrl.lastQ) return;
    var wait = 50 - (performance.now() - ctrl.lastSend);
    if (wait > 0) {
      if (!ctrl.timer) ctrl.timer = setTimeout(function () { ctrl.timer = null; trySend(); }, wait);
      return;
    }
    sendInput(ctrl.q);
  }

  function steer(v) {
    ctrl.q = Math.round(clamp(v, -1, 1) * 20) * 5;
    trySend();
  }

  function fromPointer(e) {
    var r = strip.getBoundingClientRect();
    var max = r.width * 0.32;
    var d = clamp((e.clientX - ctrl.ax) / max, -1, 1);
    var dz = 0.12;
    var v = Math.abs(d) < dz ? 0 : Math.sign(d) * (Math.abs(d) - dz) / (1 - dz);
    knob(d, ((ctrl.ax - r.left) / r.width) * 100);
    steer(v);
  }

  // While a thumb rests on the strip, say so every few seconds, so a driver
  // holding still is not taken for someone who walked away.
  function startKeep() {
    clearInterval(ctrl.keep);
    ctrl.keep = setInterval(function () { sendInput(ctrl.q); }, 3000);
  }

  function release() {
    if (!ctrl.on) return;
    ctrl.on = false;
    strip.classList.remove('on');
    knob(0, 50);
    clearTimeout(ctrl.timer);
    ctrl.timer = null;
    clearInterval(ctrl.keep);
    ctrl.q = 0;
    sendInput(0);
    strip.setAttribute('aria-valuenow', '0');
  }

  strip.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { strip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    ctrl.on = true;
    ctrl.ax = e.clientX;
    strip.classList.add('on');
    fromPointer(e);
    startKeep();
  });
  strip.addEventListener('pointermove', function (e) { if (ctrl.on) fromPointer(e); });
  strip.addEventListener('pointerup', release);
  strip.addEventListener('pointercancel', release);
  strip.addEventListener('lostpointercapture', release);
  strip.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    var d = e.key === 'ArrowLeft' ? -1 : 1;
    if (ctrl.key === d) return;
    ctrl.key = d;
    knob(d * 0.9, 50);
    steer(d);
  });
  strip.addEventListener('keyup', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    ctrl.key = 0;
    knob(0, 50);
    steer(0);
  });
  // Stop the page itself from scrolling or zooming under the thumb.
  document.addEventListener('touchmove', function (e) { if (current === 's-drive') e.preventDefault(); }, { passive: false });

  // ------------------------------------------------------------ moves

  // Dash, shield and charge buttons. They send right away, not on the
  // 20-a-second steering clock, so a tap is never lost.
  var mvCharge = { t0: 0, raf: 0 };
  function setBit(bit, on) {
    var next = on ? ctrl.btn | bit : ctrl.btn & ~bit;
    if (next === ctrl.btn) return;
    ctrl.btn = next;
    sendInput(ctrl.q);
  }
  [].forEach.call(document.querySelectorAll('.mv'), function (el) {
    var bit = Number(el.getAttribute('data-bit'));
    function down(e) {
      e.preventDefault();
      if (el.classList.contains('cool') || el.classList.contains('used')) return;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      el.classList.add('held');
      setBit(bit, true);
      vibrate(8);
      if (bit === 8) chargeStart(el);
    }
    function up() {
      if (!el.classList.contains('held')) return;
      el.classList.remove('held', 'full');
      setBit(bit, false);
      if (bit === 8) chargeStop(el);
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  });
  function chargeStart(el) {
    mvCharge.t0 = performance.now();
    var bar = el.querySelector('i');
    var buzzed = false;
    (function tick() {
      var k = Math.min(1, (performance.now() - mvCharge.t0) / 1000);
      bar.style.width = (k * 100) + '%';
      if (k >= 1 && !buzzed) { buzzed = true; el.classList.add('full'); vibrate(25); }
      mvCharge.raf = requestAnimationFrame(tick);
    })();
  }
  function chargeStop(el) {
    cancelAnimationFrame(mvCharge.raf);
    el.querySelector('i').style.width = '0';
  }
  // The big screen confirms a move: show its cool-down.
  function onMove(m) {
    if (m.k === 'dash') {
      var d = $('mv-dash'), bar = d.querySelector('i'), t0 = performance.now(), cd = (m.cd || 2) * 1000;
      d.classList.add('cool');
      vibrate(15);
      (function tick() {
        var k = (performance.now() - t0) / cd;
        bar.style.width = Math.max(0, 100 - k * 100) + '%';
        if (k < 1) requestAnimationFrame(tick); else { d.classList.remove('cool'); bar.style.width = '0'; }
      })();
    } else if (m.k === 'shield') {
      $('mv-shield').classList.add('used');
      $('mv-shield').querySelector('span').textContent = 'Back next wave';
      vibrate([20, 30, 40]);
    } else if (m.k === 'ready') {
      $('mv-shield').classList.remove('used');
      $('mv-shield').querySelector('span').textContent = 'Once a wave';
    }
  }

  function renderMe() {
    var pips = $('d-hull').children;
    for (var i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= S.hull);
    $('d-score').textContent = fmt(S.score);
  }

  var wreckTimer = null;
  function fx(k) {
    var drive = $('s-drive');
    if (k === 'kill' || k === 'hit') {
      drive.classList.remove('kill', 'hit');
      void drive.offsetWidth;
      drive.classList.add(k);
      vibrate(k === 'kill' ? 12 : 40);
    } else if (k === 'wreck') {
      vibrate([60, 40, 90]);
      var n = 3;
      $('d-wreck-n').textContent = n;
      $('d-wreck').hidden = false;
      clearInterval(wreckTimer);
      wreckTimer = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(wreckTimer); $('d-wreck').hidden = true; return; }
        $('d-wreck-n').textContent = n;
      }, 1000);
    } else if (k === 'spawn') {
      clearInterval(wreckTimer);
      $('d-wreck').hidden = true;
      vibrate(20);
    } else if (k === 'big') {
      drive.classList.remove('kill', 'hit');
      void drive.offsetWidth;
      drive.classList.add('kill');
      vibrate([30, 20, 60]);
    }
  }

  // ------------------------------------------------------------ round state

  function onTick(m) {
    S.phase = m.phase;
    S.round = m.round;
    S.left = m.left;
    S.fleet = m.fleet;
    S.charge = m.charge;
    if (current === 's-join') $('j-state').textContent = m.phase === 'play' ? 'Round ' + m.round + ' is on' : '';
    renderTick();
  }

  var WAIT = {
    lobby: ['Get ready', 'Drag below to find your bus'],
    count: ['Round starts in', 'Drag below to find your bus'],
    results: ['Round over', 'Look up at the big screen'],
    inter: ['Next round in', 'Drag below to find your bus'],
  };
  function renderTick() {
    $('d-round').textContent = 'Round ' + S.round;
    $('d-left').textContent = S.phase === 'play' ? clock(S.left) : S.phase === 'results' ? 'Results' : clock(S.left);
    var w = WAIT[S.phase];
    $('d-wait').hidden = !w;
    if (w) {
      $('d-wait-h').textContent = w[0] + (S.phase === 'count' || S.phase === 'inter' ? ' ' + Math.max(0, Math.ceil(S.left)) : '');
      $('d-wait-s').textContent = w[1];
    }
    $('l-fleet').textContent = fmt(S.fleet);
    $('l-phase').textContent = S.phase === 'play' ? 'Round ' + S.round : S.phase === 'results' ? 'Round over' : 'Next round';
    $('l-left').textContent = S.phase === 'results' ? '--:--' : clock(S.left);
    $('tap').style.setProperty('--p', clamp(S.charge || 0, 0, 100));
    $('tap-pct').textContent = Math.floor(S.charge || 0) + '%';
  }

  // ------------------------------------------------------------ mission control

  function renderLine() {
    var el = $('l-status');
    if (S.line === 1) el.innerHTML = "<b>You're next.</b> You drive when a seat opens, usually at the end of this round.";
    else el.innerHTML = '<b>' + (S.line - 1) + ' ahead of you</b> in line for a bus. Tap to help the fleet while you wait.';
    renderTick();
  }

  var tapBtn = $('tap');
  tapBtn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    S.taps++;
    tapBtn.classList.remove('bump');
    void tapBtn.offsetWidth;
    tapBtn.classList.add('bump');
    vibrate(6);
  });
  setInterval(function () {
    if (!S.taps || !link) return;
    if (link.send({ t: 'tap', n: Math.min(20, S.taps) })) S.taps = 0;
  }, 1000);

  function confirmLeave(btn) {
    if (btn.dataset.armed) {
      if (link) link.send({ t: 'leave' });
      forget();
      bye('left');
      return;
    }
    btn.dataset.armed = '1';
    var text = btn.textContent;
    btn.textContent = 'Tap again to leave';
    setTimeout(function () { delete btn.dataset.armed; btn.textContent = text; }, 3000);
  }
  $('l-leave').addEventListener('click', function () { confirmLeave(this); });
  $('b-leave').addEventListener('click', function () { confirmLeave(this); });
  $('b-line').addEventListener('click', function () {
    if (link && link.send({ t: 'line' })) this.disabled = true;
  });

  // ------------------------------------------------------------ results card

  var cardTimer = null;
  function showCard(m) {
    var card = $('card');
    var html = '<h2>' + (m.rank ? 'You placed ' + ordinal(m.rank) : 'Round over') + '</h2>';
    html += '<p>Round ' + (m.round || S.round) + ' · ' + fmt(m.score) + ' points' + (m.of ? ' · ' + m.of + ' drivers' : '') + '</p>';
    if (m.badge) html += '<span class="badge"></span>';
    card.innerHTML = html;
    if (m.badge) card.querySelector('.badge').textContent = m.badge;
    card.hidden = false;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(function () { card.hidden = true; }, 8000);
  }
  $('card').addEventListener('click', function () { this.hidden = true; });

  // ------------------------------------------------------------ phone features

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* not supported */ }
  }

  var lock = null;
  function wake() {
    if (!('wakeLock' in navigator) || document.hidden || lock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      lock = l;
      l.addEventListener('release', function () { lock = null; });
    }).catch(function () { /* not allowed: the page still works */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (link) link.nudge();
    if (S.joined) wake();
  });
  window.addEventListener('pageshow', function () { if (link) link.nudge(); });
  window.addEventListener('online', function () { if (link) link.nudge(); });

  if (/LinkedInApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger/i.test(navigator.userAgent)) $('j-tip').hidden = false;

  // ------------------------------------------------------------ start

  window.FleetPhone = { state: S, steer: steer };

  var saved = load();
  var code = codeFromUrl();
  if (saved) startToken(saved);
  else if (code) startCode(code);
  else showCode('');
})();
