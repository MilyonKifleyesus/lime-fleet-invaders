/* Fleet Invaders: the results screen and the full leaderboard. */
(function (global) {
  'use strict';

  const D = global.FleetData;
  const PAGE = 100;
  const POLL_MS = 15000;
  const TV_PAGE_MS = 9000;
  const TV_ROWS = 1000; // The most the database returns in one request.
  const AUTO_RETURN_S = 45;
  const INPUT_GUARD_MS = 1000; // Stops a player still pressing fire from skipping their result.
  const reducedMotion = global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const waveText = (g) => (g.overdrive > 0 ? `OD${g.overdrive}` : `W${g.wave}`);
  const timeText = (s) => { const m = Math.floor(s / 60), r = s % 60; return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`; };
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

  const S = {
    visible: false, boardOnly: false, tv: false, shared: false, handlers: {},
    scope: 'today', group: 'best', q: '', rows: [], total: 0, rankedTotal: 0,
    open: null, history: {}, me: null, error: false, loaded: false,
    request: 0, session: 0, shownAt: 0, poll: null, tvTimer: null, autoTimer: null, autoLeft: 0, searchTimer: null,
    player: null,
  };

  const root = document.createElement('div');
  root.id = 'resultOverlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Your result and the leaderboard');
  root.innerHTML = `
    <div class="ro-shell">
      <section class="ro-main">
        <div class="ro-rank" id="roRank" aria-live="polite"></div>
        <div class="ro-of" id="roOf"></div>
        <div class="ro-name"><span id="roName"></span><span class="ro-score" id="roScore"></span></div>
        <div class="ro-next" id="roNext"></div>
        <div class="ro-sub" id="roSub"></div>
        <dl class="ro-stats" id="roStats"></dl>
        <div class="ro-actions">
          <button class="fi-btn primary" type="button" id="roPrimary"></button>
          <button class="fi-btn ghost" type="button" id="roSecondary"></button>
        </div>
        <div class="ro-auto" id="roAuto"></div>
      </section>
      <aside class="ro-board" aria-label="Leaderboard">
        <div class="ro-head">
          <button class="fi-link ro-back" type="button" id="roBack" hidden>Back</button>
          <div class="ro-title"><h2>Leaderboard</h2><span class="ro-count" id="roCount"></span></div>
          <div class="ro-tools">
            <div class="fi-seg" role="group" aria-label="Time range">
              <button type="button" data-scope="today" aria-pressed="true">Today</button>
              <button type="button" data-scope="all" aria-pressed="false">All time</button>
            </div>
            <div class="fi-seg" role="group" aria-label="Which games to show">
              <button type="button" data-group="best" aria-pressed="true">Best</button>
              <button type="button" data-group="every" aria-pressed="false">Every game</button>
            </div>
            <label for="roSearch" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">Find a name</label>
            <input class="ro-search" id="roSearch" type="search" placeholder="Find a name" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="ro-cols" aria-hidden="true">
          <span>#</span><span></span><span>Player</span><span>Score</span><span>Wave</span><span class="ro-acc">Acc.</span><span class="ro-when">When</span>
        </div>
        <div class="ro-rows" id="roRows"></div>
        <button class="ro-more" type="button" id="roMore" hidden></button>
      </aside>
    </div>`;
  document.body.appendChild(root);
  const $ = (id) => document.getElementById(id);
  const rowsEl = $('roRows');

  /* ---------- leaderboard ---------- */
  function rowKey(r) { return S.group === 'best' ? r.name : r.game_id; }
  function isMine(r) {
    if (!S.me) return false;
    return S.group === 'best' ? r.name === S.me.name : r.game_id === S.me.id;
  }
  function whenText(r) {
    const d = new Date(r.started_at);
    return S.scope === 'today' ? clock.format(d).replace(/\s?[AP]M$/i, '') : date.format(d);
  }
  function historyHtml(r) {
    const h = S.history[r.name];
    if (!h) return '<div class="ro-hist"><div class="ro-hist-title">Loading games…</div></div>';
    if (h.error) return '<div class="ro-hist"><div class="ro-hist-title">Could not load these games. Select the name to try again.</div></div>';
    const games = h.games;
    const items = games.map((g) => {
      const d = new Date(g.started_at);
      const when = S.scope === 'all' ? `${date.format(d)}, ${clock.format(d)}` : clock.format(d);
      return `<li><span>${esc(when)}</span><span>${waveText(g)} · ${g.accuracy}% · ×${g.longest_combo} · ${timeText(g.duration_s)}</span><b>${fmt(g.score)}</b></li>`;
    }).join('');
    const label = `${games.length} ${games.length === 1 ? 'game' : 'games'}${S.scope === 'today' ? ' today' : ' in total'}`;
    return `<div class="ro-hist"><div class="ro-hist-title">${label}</div><ul>${items}</ul></div>`;
  }
  function rowHtml(r) {
    const key = rowKey(r), open = S.open === key;
    return `<div class="ro-wrap${r.rank <= 3 ? ' top3' : ''}${isMine(r) ? ' me' : ''}" data-k="${esc(key)}" data-name="${esc(r.name)}">
      <button type="button" class="ro-row" aria-expanded="${open}"><span class="ro-r">${r.rank}</span><span class="ro-a" aria-hidden="true">${esc(r.avatar || '')}</span><span class="ro-n">${esc(r.name)}</span><span class="ro-s">${fmt(r.score)}</span><span>${waveText(r)}</span><span class="ro-acc">${r.accuracy}%</span><span class="ro-when">${esc(whenText(r))}</span></button>
      ${open ? historyHtml(r) : ''}
    </div>`;
  }
  function paintControls() {
    root.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === S.scope)));
    root.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === S.group)));
  }
  function renderBoard(opts) {
    const options = opts || {};
    const before = new Map();
    if (options.land && !reducedMotion) {
      rowsEl.querySelectorAll('.ro-wrap').forEach((el) => before.set(el.dataset.k, el.getBoundingClientRect().top));
    }
    const keepScroll = rowsEl.scrollTop;
    paintControls();
    if (S.error) {
      rowsEl.innerHTML = '<div class="ro-msg">Could not load the leaderboard. Check your connection.<br><br><button class="fi-link" type="button" id="roRetry">Try again</button></div>';
      $('roCount').textContent = '';
      $('roMore').hidden = true;
      return;
    }
    if (!S.loaded) {
      rowsEl.innerHTML = '<div class="ro-msg">Loading the leaderboard…</div>';
      return;
    }
    if (S.rows.length) {
      rowsEl.innerHTML = S.rows.map(rowHtml).join('');
    } else {
      rowsEl.innerHTML = `<div class="ro-msg">${S.q ? 'No one by that name yet.' : (S.scope === 'today' ? 'No games yet today. Be the first.' : 'No games yet. Be the first.')}</div>`;
    }
    const noun = S.group === 'best' ? 'players' : 'games';
    $('roCount').textContent = S.q ? `${fmt(S.total)} ${S.total === 1 ? 'match' : 'matches'}` : `${fmt(S.rankedTotal)} ${noun}${S.tv ? ' today' : ''}`;
    const more = $('roMore');
    more.hidden = S.rows.length >= S.total;
    if (!more.hidden) more.textContent = `Show more (${fmt(S.total - S.rows.length)} left)`;
    rowsEl.scrollTop = keepScroll;

    if (options.land) {
      const mine = rowsEl.querySelector('.ro-wrap.me');
      if (!mine) return;
      rowsEl.scrollTop = clamp(mine.offsetTop - rowsEl.clientHeight / 2 + mine.offsetHeight / 2, 0, rowsEl.scrollHeight);
      if (reducedMotion) return;
      const view = rowsEl.getBoundingClientRect();
      rowsEl.querySelectorAll('.ro-wrap').forEach((row) => {
        const now = row.getBoundingClientRect().top;
        if (now > view.bottom || now + row.offsetHeight < view.top) return;
        const was = before.get(row.dataset.k), isMe = row === mine;
        let from = 0;
        if (isMe) from = Math.min(view.bottom - now, 260);
        else if (was !== undefined) from = clamp(was - now, -60, 60);
        if (!from) return;
        row.animate([{ transform: `translateY(${from}px)`, opacity: isMe ? 0.2 : 1 }, { transform: 'none', opacity: 1 }], { duration: isMe ? 760 : 520, easing: 'cubic-bezier(.16,1,.3,1)' });
      });
    }
  }
  async function loadBoard(opts) {
    const options = opts || {};
    const token = ++S.request;
    const want = options.append ? PAGE : Math.max(S.tv ? TV_ROWS : PAGE, options.limit || 0, options.quiet ? S.rows.length : 0);
    try {
      const res = await D.leaderboard({ scope: S.scope, group: S.group, search: S.q || null, limit: want, offset: options.append ? S.rows.length : 0 });
      if (token !== S.request) return;
      S.rows = options.append ? S.rows.concat(res.rows) : res.rows;
      S.total = res.total;
      S.rankedTotal = res.ranked_total;
      S.error = false;
      S.loaded = true;
      renderBoard({ land: options.land });
    } catch (e) {
      if (token !== S.request) return;
      if (options.quiet && S.loaded) return;
      S.error = true;
      renderBoard();
    }
  }
  function resetBoard() {
    S.rows = []; S.loaded = false; S.error = false; S.open = null;
    rowsEl.scrollTop = 0;
    renderBoard();
    loadBoard();
  }
  function startPolling() {
    clearInterval(S.poll);
    S.poll = setInterval(() => {
      if (S.visible && !S.q && !S.open && !document.hidden) loadBoard({ quiet: true });
    }, POLL_MS);
  }
  /* A TV has nobody to scroll it, so it moves through every rank by itself. */
  function tvNextPage() {
    if (document.hidden || S.open) return;
    const row = rowsEl.querySelector('.ro-wrap');
    if (!row) return;
    const rowHeight = row.offsetHeight, last = rowsEl.scrollHeight - rowsEl.clientHeight;
    if (last <= 0) return;
    const behavior = reducedMotion ? 'auto' : 'smooth';
    if (rowsEl.scrollTop >= last - 2) { rowsEl.scrollTo({ top: 0, behavior }); return; }
    // One row repeats, because the bottom row sits under the fade.
    const step = Math.max(1, Math.floor(rowsEl.clientHeight / rowHeight) - 1) * rowHeight;
    rowsEl.scrollTo({ top: Math.min(last, Math.round(rowsEl.scrollTop / rowHeight) * rowHeight + step), behavior });
  }
  async function toggleHistory(row) {
    const wrap = row.closest('.ro-wrap');
    const key = wrap.dataset.k, name = wrap.dataset.name;
    S.open = S.open === key ? null : key;
    if (S.open) delete S.history[name];
    renderBoard();
    if (!S.open) return;
    const scope = S.scope;
    try {
      const games = await D.playerGames(name, scope);
      S.history[name] = { games };
    } catch (e) {
      S.history[name] = { error: true };
    }
    if (S.open === key && S.scope === scope) renderBoard();
  }

  rowsEl.addEventListener('click', (e) => {
    if (e.target.id === 'roRetry') { resetBoard(); return; }
    const row = e.target.closest('.ro-row');
    if (row) { noteActivity(); toggleHistory(row); }
  });
  root.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    noteActivity(); S.scope = b.dataset.scope; resetBoard();
  }));
  root.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    noteActivity(); S.group = b.dataset.group; resetBoard();
  }));
  $('roSearch').addEventListener('input', (e) => {
    noteActivity();
    S.q = e.target.value.trim();
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(resetBoard, 250);
  });
  $('roMore').addEventListener('click', () => { noteActivity(); loadBoard({ append: true }); });
  root.addEventListener('pointermove', () => noteActivity(), { passive: true });

  /* ---------- result panel ---------- */
  function paintActions() {
    const name = S.player ? S.player.name : '';
    const key = S.handlers.primaryKey ? S.handlers.primaryKey() : 'Enter';
    $('roPrimary').innerHTML = `New player <kbd>${esc(key)}</kbd>`;
    $('roSecondary').textContent = `Play again as ${name}`;
  }
  function countUp(target) {
    const el = $('roScore');
    if (reducedMotion) { el.textContent = fmt(target); return; }
    const started = global.performance.now(), session = S.session;
    const tick = (now) => {
      if (session !== S.session) return;
      const p = clamp((now - started) / 700, 0, 1), eased = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt(Math.round((target * eased) / 10) * 10);
      if (p < 1) global.requestAnimationFrame(tick); else el.textContent = fmt(target);
    };
    global.requestAnimationFrame(tick);
  }
  function paintStanding(st, score) {
    if (!st) {
      $('roRank').textContent = '';
      $('roOf').textContent = '';
      $('roNext').textContent = 'Your score is saved on this device.';
      $('roSub').textContent = 'It will join the leaderboard when the connection returns.';
      return;
    }
    if (st.flagged) {
      $('roRank').textContent = '';
      $('roOf').textContent = '';
      $('roNext').textContent = 'This score needs a review.';
      $('roSub').textContent = 'It will not show on the leaderboard unless it is approved.';
      return;
    }
    $('roRank').textContent = st.rank ? `#${st.rank}` : '';
    $('roOf').textContent = st.rank ? `of ${fmt(st.players_today)} ${st.players_today === 1 ? 'player' : 'players'} today` : '';
    if (!st.rank) { $('roNext').textContent = ''; return; }
    $('roNext').textContent = st.next_name ? `${fmt(st.next_score - st.best + 10)} more points passes ${st.next_name}.` : "You lead today's board.";
    if (!st.is_best) $('roSub').textContent = `Your best today stays at ${fmt(st.best)}.`;
    else if (S.player.previousBest != null && score > S.player.previousBest) $('roSub').textContent = 'New personal best.';
    else $('roSub').textContent = '';
  }

  /* ---------- automatic return on shared screens ---------- */
  function paintAuto() {
    $('roAuto').textContent = S.shared && !S.boardOnly ? `Next player screen in ${S.autoLeft} seconds` : '';
  }
  function noteActivity() {
    S.autoLeft = AUTO_RETURN_S;
    paintAuto();
  }
  function startAuto() {
    clearInterval(S.autoTimer);
    if (!S.shared || S.boardOnly) { paintAuto(); return; }
    S.autoLeft = AUTO_RETURN_S;
    paintAuto();
    S.autoTimer = setInterval(() => {
      S.autoLeft -= 1;
      paintAuto();
      if (S.autoLeft <= 0) { clearInterval(S.autoTimer); S.handlers.onNewPlayer(); }
    }, 1000);
  }

  /* ---------- open and close ---------- */
  function open(boardOnly) {
    S.visible = true;
    S.boardOnly = boardOnly;
    S.tv = false;
    root.classList.remove('tv');
    clearInterval(S.tvTimer);
    S.session += 1;
    S.shownAt = Date.now();
    root.classList.add('visible');
    root.classList.toggle('board-only', boardOnly);
    $('roBack').hidden = !boardOnly;
    $('roSearch').value = '';
    root.scrollTop = 0;
    S.q = ''; S.scope = 'today'; S.group = 'best'; S.history = {};
    startPolling();
  }
  function hide() {
    S.visible = false;
    S.session += 1;
    root.classList.remove('visible');
    clearInterval(S.poll);
    clearInterval(S.tvTimer);
    clearInterval(S.autoTimer);
    S.me = null;
  }

  /* Shows a finished game. `player` is { name, avatar, previousBest }, and
     `standing` is a promise of the server's answer (null when offline). */
  function show(details) {
    open(false);
    S.player = details.player;
    S.me = null;
    const st = details.stats;
    $('roRank').textContent = '';
    $('roOf').textContent = '';
    $('roNext').textContent = 'Saving your score…';
    $('roSub').textContent = '';
    $('roName').textContent = `${details.player.avatar || ''} ${details.player.name}`.trim();
    countUp(st.score);
    const accuracy = st.shots > 0 ? Math.min(100, Math.round((st.hits / st.shots) * 100)) : 0;
    const wave = st.overdrive > 0 ? `OD${st.overdrive}` : st.wave;
    $('roStats').innerHTML = [['Wave', wave], ['Accuracy', `${accuracy}%`], ['Best combo', `×${st.longestCombo}`], ['Kills', fmt(st.kills)], ['Time alive', timeText(st.durationS)]]
      .map((s) => `<div><dt>${s[0]}</dt><dd>${s[1]}</dd></div>`).join('');
    paintActions();
    startAuto();
    resetBoard();
    $('roPrimary').focus({ preventScroll: true });
    const session = S.session;
    details.standing.then((res) => {
      if (session !== S.session) return;
      paintStanding(res, st.score);
      // A flagged game is off the board, so an earlier row of theirs must not light up.
      if (res && res.rank && !res.flagged) {
        S.me = { name: details.player.name, id: res.game_id };
        loadBoard({ land: true, limit: res.rank + 8 });
      }
    });
  }
  function showBoard(options) {
    open(true);
    S.tv = !!(options && options.tv);
    root.classList.toggle('tv', S.tv);
    $('roBack').hidden = S.tv;
    if (S.tv) S.tvTimer = setInterval(tvNextPage, TV_PAGE_MS);
    S.me = null;
    clearInterval(S.autoTimer);
    resetBoard();
    $('roBack').focus({ preventScroll: true });
  }

  function guarded() { return Date.now() - S.shownAt < INPUT_GUARD_MS; }
  function primary() {
    if (guarded()) return;
    if (S.boardOnly) { S.handlers.onBack(); return; }
    S.handlers.onNewPlayer();
  }
  function secondary() {
    if (guarded()) return;
    if (S.boardOnly) { S.handlers.onBack(); return; }
    S.handlers.onPlayAgain();
  }
  $('roPrimary').addEventListener('click', primary);
  $('roSecondary').addEventListener('click', secondary);
  $('roBack').addEventListener('click', () => S.handlers.onBack());

  function handleKey(e) {
    noteActivity();
    const typing = e.target && e.target.tagName === 'INPUT';
    if (e.code === 'Escape') {
      if (typing && S.q) { e.target.value = ''; S.q = ''; resetBoard(); return; }
      if (S.boardOnly) S.handlers.onBack();
      return;
    }
    if (typing) return;
    if (e.code === 'Enter' && !(e.target && e.target.tagName === 'BUTTON')) { primary(); return; }
    if (e.code === 'KeyR' && !S.boardOnly && !guarded()) S.handlers.onPlayAgain();
  }

  global.FleetResults = {
    init(options) { S.shared = !!options.shared; S.handlers = options; },
    setShared(on) { S.shared = !!on; },
    show, showBoard, hide, primary, secondary, handleKey,
    scrollBoard(direction) { noteActivity(); rowsEl.scrollBy({ top: direction * 126, behavior: reducedMotion ? 'auto' : 'smooth' }); },
    get visible() { return S.visible; },
  };
})(window);
