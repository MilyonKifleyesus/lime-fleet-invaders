// Fleet Invaders Live: the host panel for whoever runs the booth.
(() => {
  'use strict';

  const CFG = window.FLEET_LIVE;
  const COL = { amber: '#E69F00', sky: '#56B4E9', jade: '#009E73', sun: '#F0E442', cobalt: '#0072B2', ember: '#D55E00', orchid: '#CC79A7' };
  const $ = id => document.getElementById(id);
  const clock = s => { s = Math.max(0, Math.ceil(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  const [room, key] = location.hash.slice(1).split('.');
  if (!/^[a-z0-9]{12}$/.test(room || '') || !key) {
    $('gate').hidden = false;
    return;
  }
  $('panel').hidden = false;

  const players = new Map();
  let seats = 16;

  const link = new window.LiveLink({
    url: () => `${CFG.ws}?room=${room}&role=admin&key=${encodeURIComponent(key)}`,
    watch: true,
    onState: s => {
      $('status').textContent = s === 'open' ? 'Connected to the room' : 'Reconnecting…';
      $('status').classList.toggle('on', s === 'open');
    },
    onMessage: m => {
      if (m.t === 'roster') {
        seats = m.seats;
        players.clear();
        for (const p of m.players) players.set(p.id, p);
        $('code').textContent = m.code || '----';
        $('lock').setAttribute('aria-pressed', String(!!m.locked));
        render();
      } else if (m.t === 'p') {
        players.set(m.p.id, m.p);
        render();
      } else if (m.t === 'code') {
        $('code').textContent = m.code;
      } else if (m.t === 'lock') {
        $('lock').setAttribute('aria-pressed', String(!!m.on));
      } else if (m.t === 'tick') {
        const label = { lobby: 'Waiting', count: 'Starting', play: 'Round ' + m.round, results: 'Results', inter: 'Next round' }[m.phase] || 'Round';
        $('n-phase').textContent = label;
        $('n-left').textContent = m.phase === 'play' || m.phase === 'count' || m.phase === 'inter' ? clock(m.left) : '--:--';
      } else if (m.t === 'err') {
        link.stop();
        $('panel').hidden = true;
        $('gate').hidden = false;
        $('gate-msg').textContent = m.why === 'key' || m.why === 'room'
          ? 'This host link no longer works. Press H on the big screen to show a new one.'
          : m.why === 'noscreen'
            ? "The big screen isn't running. Open the event on the big screen, then reload this page."
            : 'Could not connect to the room.';
      } else if (m.t === 'wait') {
        $('status').textContent = 'Waiting for the big screen…';
      }
    },
  });

  function row(p, status) {
    const li = document.createElement('li');
    li.style.setProperty('--c', COL[p.color] || '#AEB8A6');
    if (p.hidden) li.classList.add('hid');
    const dot = document.createElement('i');
    const nm = document.createElement('div');
    nm.className = 'nm';
    const b = document.createElement('b');
    b.textContent = p.name;
    const s = document.createElement('span');
    s.textContent = status + (p.custom ? ' · typed name' : '') + (p.share ? ' · OK to post' : '');
    nm.append(b, s);
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = p.hidden ? 'Show name' : 'Hide name';
    hide.addEventListener('click', () => link.send({ t: 'hide', id: p.id, on: !p.hidden }));
    const kick = document.createElement('button');
    kick.type = 'button';
    kick.textContent = 'Remove';
    kick.addEventListener('click', () => {
      if (kick.classList.contains('armed')) {
        link.send({ t: 'kick', id: p.id });
        return;
      }
      kick.classList.add('armed');
      kick.textContent = 'Sure?';
      setTimeout(() => { kick.classList.remove('armed'); kick.textContent = 'Remove'; }, 3000);
    });
    li.append(dot, nm, hide, kick);
    return li;
  }

  function fill(listId, countId, items) {
    const ul = $(listId);
    ul.innerHTML = '';
    $(countId).textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      const e = document.createElement('p');
      e.className = 'empty';
      e.textContent = 'Nobody';
      ul.append(e);
      return;
    }
    for (const [p, status] of items) ul.append(row(p, status));
  }

  function render() {
    const active = [...players.values()].filter(p => !p.removed);
    const driving = active.filter(p => p.seat !== null).sort((a, b) => a.seat - b.seat);
    const mc = active.filter(p => p.seat === null && p.queued && p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    const away = active.filter(p => !driving.includes(p) && !mc.includes(p));
    fill('l-drive', 'c-drive', driving.map(p => [p, 'Bus ' + (p.seat + 1) + (p.connected ? '' : ' · reconnecting')]));
    fill('l-mc', 'c-mc', mc.map(p => [p, 'Waiting for a bus']));
    fill('l-away', 'c-away', away.map(p => [p, p.connected ? 'Parked: tapped out of line' : 'Phone disconnected']));
    $('n-drive').textContent = driving.length + '/' + seats;
    $('n-mc').textContent = String(mc.length);
  }

  $('lock').addEventListener('click', () => {
    const on = $('lock').getAttribute('aria-pressed') !== 'true';
    link.send({ t: 'lock', on });
  });
  $('start').addEventListener('click', () => link.send({ t: 'cmd', c: 'start' }));
  $('end').addEventListener('click', () => link.send({ t: 'cmd', c: 'end' }));
})();
