// One WebSocket link to the live switchboard that reconnects by itself.
// Used by the phone, the big screen and the host panel.
//
// Vercel closes every connection after a few minutes. The switchboard says
// when ({t:'ttl'}), and about a minute before, the link opens a second
// connection and moves over once it works, so play never stops.
(function (root) {
  function Link(opts) {
    this.opts = opts;
    this.ws = null; // the connection in use
    this.next = null; // a new connection that is taking over
    this.retiring = null; // the old connection, closing after a handover
    this.stopped = false;
    this.tries = 0;
    this.lastMsg = 0;
    this.state = 'idle';
    this.watch = null;
    this.retryTimer = null;
    this.handTimer = null;
    this.connect();
  }

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
    }, this.opts.openTimeout || 6000);
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
    if (this.next && this.next.readyState === 1) {
      // The old connection closed first; the new one is already open.
      this.ws = this.next;
      this.next = null;
      this.lastMsg = Date.now();
      this.scheduleHandover(this.ws.ttl);
      return;
    }
    this.stopWatch();
    clearTimeout(this.handTimer);
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
    this.retryTimer = setTimeout(function () { self.connect(); }, d);
  };

  // ------------------------------------------------------------ handover

  Link.prototype.scheduleHandover = function (ms) {
    clearTimeout(this.handTimer);
    if (!(ms > 0)) return;
    // About a minute early, spread out so a whole room does not move at once.
    var at = Math.max(Math.min(20000, ms / 2), ms - 60000 + (Math.random() * 20000 - 10000));
    var self = this;
    this.handTimer = setTimeout(function () { self.handover(); }, at);
  };

  Link.prototype.retryHandover = function () {
    var self = this;
    clearTimeout(this.handTimer);
    this.handTimer = setTimeout(function () { self.handover(); }, 10000);
  };

  Link.prototype.handover = function () {
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
  Link.prototype.startWatch = function () {
    var self = this;
    this.stopWatch();
    if (!this.opts.watch) return;
    this.watch = setInterval(function () {
      var quiet = Date.now() - self.lastMsg;
      if (quiet > 7000) self.restart();
      else if (quiet > 3500) self.sendRaw('ping');
    }, 1000);
  };

  Link.prototype.stopWatch = function () {
    clearInterval(this.watch);
    this.watch = null;
  };

  Link.prototype.closeExtras = function () {
    var extras = [this.next, this.retiring];
    this.next = null;
    this.retiring = null;
    clearTimeout(this.handTimer);
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
    this.stopWatch();
    this.closeExtras();
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.setState('stopped');
  };

  root.LiveLink = Link;
})(typeof window !== 'undefined' ? window : globalThis);
