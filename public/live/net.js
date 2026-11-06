// One WebSocket link to the relay that reconnects by itself.
// Used by the phone, the big screen and the host panel.
(function () {
  function Link(opts) {
    this.opts = opts;
    this.ws = null;
    this.stopped = false;
    this.tries = 0;
    this.lastMsg = 0;
    this.state = 'idle';
    this.watch = null;
    this.retryTimer = null;
    this.connect();
  }

  Link.prototype.setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    if (this.opts.onState) this.opts.onState(s);
  };

  Link.prototype.connect = function () {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    var self = this;
    var url = typeof this.opts.url === 'function' ? this.opts.url() : this.opts.url;
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
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
      self.tries = 0;
      self.lastMsg = Date.now();
      self.setState('open');
      self.startWatch();
      if (self.opts.onOpen) self.opts.onOpen();
    };
    ws.onmessage = function (e) {
      if (ws !== self.ws) return;
      self.lastMsg = Date.now();
      if (typeof e.data === 'string') {
        if (e.data === 'pong') return;
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (self.opts.onMessage) self.opts.onMessage(m);
      } else if (self.opts.onBinary) {
        self.opts.onBinary(new Uint8Array(e.data));
      }
    };
    ws.onclose = function (e) {
      clearTimeout(openTimer);
      if (ws !== self.ws) return;
      self.stopWatch();
      if (self.opts.onClose) self.opts.onClose(e);
      self.retry();
    };
    ws.onerror = function () { /* onclose follows */ };
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

  Link.prototype.restart = function () {
    if (this.stopped) return;
    var old = this.ws;
    this.ws = null;
    this.stopWatch();
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
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.setState('stopped');
  };

  window.LiveLink = Link;
})();
