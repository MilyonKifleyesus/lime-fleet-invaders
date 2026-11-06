// Where the Fleet Invaders Live relay runs.
// Pages opened from this computer (localhost) use a local relay, or ?relay=...
(function () {
  var RELAY = 'https://fleet-invaders-relay.workers.dev';
  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var relay = RELAY;
  if (local) {
    var fromUrl = new URLSearchParams(location.search).get('relay');
    relay = fromUrl || 'http://127.0.0.1:8787';
  }
  window.FLEET_LIVE = {
    relay: relay.replace(/\/$/, ''),
    relayWs: relay.replace(/\/$/, '').replace(/^http/, 'ws'),
    local: local,
    // Keeps ?relay= on links this page builds, only when testing locally.
    keep: local && new URLSearchParams(location.search).get('relay')
      ? '?relay=' + encodeURIComponent(relay) : '',
  };
})();
