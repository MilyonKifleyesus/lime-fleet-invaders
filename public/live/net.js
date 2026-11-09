// One WebSocket link to the live switchboard that reconnects by itself.
// Used by the phone, the big screen and the host panel.
//
// Vercel closes every connection after a few minutes. The switchboard says
// when ({t:'ttl'}), and about a minute before, the link opens a second
// connection and moves over once it works, so play never stops.
(function (root) {
  // Calls fn every ms milliseconds. In a background tab, browsers slow page
  // timers to about once a minute, which would stop the "still here" pings
  // and the reconnects. Timers inside a worker keep their pace, so a worker
  // does the counting when the browser has one.
  function every(ms, fn) {
    try {
      if (root.Worker && root.Blob && root.URL && root.URL.createObjectURL && typeof document !== 'undefined') {
        var src = 'var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)};';
        var url = root.URL.createObjectURL(new root.Blob([src], { type: 'text/javascript' }));
        var w = new root.Worker(url);
        root.URL.revokeObjectURL(url);
        w.onmessage = function () { fn(); };
        w.postMessage(ms);
        return { stop: function () { w.terminate(); } };
      }
    } catch (e) { /* no workers here: use a plain timer */ }
    var id = setInterval(fn, ms);
    return { stop: function () { clearInterval(id); } };
  }

  function Link(opts) {
    this.opts = opts;
    this.ws = null; // the connection in use
    this.next = null; // a new connection that is taking over
    this.retiring = null; // the old connection, closing after a handover
    this.stopped = false;
    this.tries = 0;
    this.lastMsg = 0;
    this.state = 'idle';
    this.watching = false;
    this.retryTimer = null;
    this.retryAt = 0;
    this.handTimer = null;
    this.handAt = 0;
    var self = this;
    this.clock = every(1000, function () { self.onClock(); });
    this.connect();
  }

  // Once a second, even in a background tab: health checks, reconnects and
  // handovers whose own timers the browser may have slowed down.
  Link.prototype.onClock = function () {
    if (this.stopped) return;
    var now = Date.now();
    if (this.state === 'retry' && this.retryAt && now >= this.retryAt) {
      this.connect();
      return;
    }
    if (this.handAt && now >= this.handAt) this.handover();
    if (!this.watching || this.state !== 'open') return;
    var quiet = now - this.lastMsg;
    if (quiet > 7000) this.restart();
    // Ping when nothing came in for a while, and also when this page has
    // sent nothing for 10 s, so the switchboard knows it is still here.
    else if (quiet > 3500 || now - (this.lastSent || 0) > 10000) this.sendRaw('ping');
  };

  Link.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    if (this.opts.onState) this.opts.onState(s);
  };

  Link.prototype.make = function () {
    var url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
    // Test scripts outside a browser pass an Origin header this way.
    var ws = this.opts.wsInit ? new WebSocket(url, this.opts.wsInit) : new WebSocket(url);
    var self = this;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) { self.onSocketMessage(ws, e.data); };
    ws.onclose = function (e) { self.onSocketClose(ws, e); };
    ws.onerror = function () { /* onclose follows */ };
    return ws;
  };

  Link.prototype.connect = function () {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryAt = 0;
    var self = this;
    var ws;
    try {
      ws = this.make();
    } catch (e) {
      this.retry();
      return;
    }
    this.ws = ws;
    this.setState('connecting');
    var opened = false;
    // A handshake that hangs (a blocking network) counts as a failure.
    var openTimer = setTimeout(function () {
      if (!opened) { try { ws.close(); } catch (e) { /* ignore */ } }
    }, this.opts.openTimeout || 10000); // a fresh Vercel copy can take a few seconds
    ws.onopen = function () {
      opened = true;
      clearTimeout(openTimer);
      if (ws !== self.ws) return;
      self.tries = 0;
      self.lastMsg = Date.now();
      self.setState('open');
      self.startWatch();
      if (self.opts.onOpen) self.opts.onOpen();
    };
  };

  Link.prototype.onSocketMessage = function (ws, data) {
    var m = null;
    if (typeof data === 'string') {
      if (data === 'pong') {
        if (ws === this.ws) this.lastMsg = Date.now();
        return;
      }
      try { m = JSON.parse(data); } catch (err) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ttl') {
        ws.ttl = m.ms;
        if (ws === this.ws) this.scheduleHandover(m.ms);
        return;
      }
      if (m.t === 'end') {
        // The switchboard closed this connection (Vercel does not pass the
        // close itself on), so close it here and carry on as after a close.
        ws.onmessage = ws.onclose = null;
        try { ws.close(); } catch (err) { /* ignore */ }
        this.onSocketClose(ws, { code: m.code, reason: m.why || '' });
        return;
      }
    }
    if (ws === this.next) {
      if (!m || m.t === 'wait') return;
      this.adopt(ws);
    }
    if (ws === this.ws && this.next && m && m.t === 'replaced') {
      // Our own handover: the new connection reached another copy, which
      // released this one before the new one said it was ready. Move over.
      this.promoteNext();
      return;
    }
    if (ws === this.ws) {
      this.lastMsg = Date.now();
    } else if (ws === this.retiring && this.opts.keepOld) {
      // The big screen keeps reading the old connection until it closes.
      if (m && (m.t === 'replaced' || m.t === 'err')) return;
    } else {
      return;
    }
    if (m) {
      if (this.opts.onMessage) this.opts.onMessage(m);
    } else if (this.opts.onBinary) {
      this.opts.onBinary(new Uint8Array(data));
    }
  };

  Link.prototype.onSocketClose = function (ws, e) {
    if (ws === this.next) {
      this.next = null;
      this.retryHandover();
      return;
    }
    if (ws === this.retiring) {
      this.retiring = null;
      return;
    }
    if (ws !== this.ws) return;
    if (this.next && this.next.readyState <= 1) {
      // The old connection closed first; the new one is taking over.
      this.promoteNext();
      this.retiring = null;
      return;
    }
    this.stopWatch();
    clearTimeout(this.handTimer);
    this.handAt = 0;
    if (this.next) {
      var n = this.next;
      this.next = null;
      try { n.close(); } catch (err) { /* ignore */ }
    }
    if (this.opts.onClose) this.opts.onClose(e);
    this.retry();
  };

  Link.prototype.retry = function () {
    if (this.stopped) return;
    this.setState('retry');
    var delays = [300, 800, 1500, 2500, 4000];
    var d = delays[Math.min(this.tries, delays.length - 1)];
    this.tries++;
    var self = this;
    this.retryAt = Date.now() + d;
    this.retryTimer = setTimeout(function () { if (self.retryAt) self.connect(); }, d);
  };

  // ------------------------------------------------------------ handover

  Link.prototype.scheduleHandover = function (ms) {
    clearTimeout(this.handTimer);
    if (!(ms > 0)) return;
    // About a minute early, spread out so a whole room does not move at once.
    var at = Math.max(Math.min(20000, ms / 2), ms - 60000 + (Math.random() * 20000 - 10000));
    this.planHandover(at);
  };

  Link.prototype.planHandover = function (at) {
    var self = this;
    clearTimeout(this.handTimer);
    this.handAt = Date.now() + at;
    this.handTimer = setTimeout(function () { if (self.handAt) self.handover(); }, at);
  };

  Link.prototype.retryHandover = function () {
    this.planHandover(10000);
  };

  Link.prototype.handover = function () {
    this.handAt = 0;
    if (this.stopped || this.next || !this.ws || this.ws.readyState !== 1) return;
    var ws;
    try {
      ws = this.make();
    } catch (e) {
      this.retryHandover();
      return;
    }
    this.next = ws;
    var self = this;
    setTimeout(function () {
      if (self.next === ws) {
        self.next = null;
        try { ws.close(); } catch (e) { /* ignore */ }
        self.retryHandover();
      }
    }, 8000);
  };

  // Makes the new connection the one in use before it has said anything;
  // its first message then arrives as an ordinary message.
  Link.prototype.promoteNext = function () {
    var old = this.ws;
    this.ws = this.next;
    this.next = null;
    this.retiring = old;
    this.lastMsg = Date.now();
    if (this.ws.ttl) this.scheduleHandover(this.ws.ttl);
    var self = this;
    setTimeout(function () {
      if (self.retiring === old) { self.retiring = null; try { old.close(); } catch (e) { /* ignore */ } }
    }, 3000);
  };

  Link.prototype.adopt = function (ws) {
    var old = this.ws;
    this.ws = ws;
    this.next = null;
    this.retiring = old;
    this.lastMsg = Date.now();
    this.scheduleHandover(ws.ttl);
    var self = this;
    var closeOld = function () {
      if (self.retiring !== old) return;
      try { old.close(1000, 'handover'); } catch (e) { /* ignore */ }
    };
    if (this.opts.keepOld) setTimeout(closeOld, 3000);
    else closeOld();
  };

  // ------------------------------------------------------------ health

  // Phones lose their connection silently when the screen locks. If nothing
  // arrives for a few seconds, ask; if nothing answers, start again.
  // The checks themselves run in onClock.
  Link.prototype.startWatch = function () {
    this.watching = !!this.opts.watch;
  };

  Link.prototype.stopWatch = function () {
    this.watching = false;
  };

  Link.prototype.closeExtras = function () {
    var extras = [this.next, this.retiring];
    this.next = null;
    this.retiring = null;
    clearTimeout(this.handTimer);
    this.handAt = 0;
    for (var i = 0; i < extras.length; i++) {
      if (extras[i]) { try { extras[i].close(); } catch (e) { /* ignore */ } }
    }
  };

  Link.prototype.restart = function () {
    if (this.stopped) return;
    var old = this.ws;
    this.ws = null;
    this.stopWatch();
    this.closeExtras();
    if (old) { try { old.close(); } catch (e) { /* ignore */ } }
    this.tries = 0;
    this.connect();
  };

  // Called when the page comes back into view: check at once.
  Link.prototype.nudge = function () {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > 1 || Date.now() - this.lastMsg > 3000) this.restart();
  };

  Link.prototype.sendRaw = function (data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(data);
      this.lastSent = Date.now();
      return true;
    }
    return false;
  };

  Link.prototype.send = function (m) {
    return this.sendRaw(JSON.stringify(m));
  };

  Link.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryAt = 0;
    if (this.clock) this.clock.stop();
    this.stopWatch();
    this.closeExtras();
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.setState('stopped');
  };

  Link.every = every;
  root.LiveLink = Link;
})(typeof window !== 'undefined' ? window : globalThis);
