// Where the Fleet Invaders Live switchboard runs: /api/live on this same site.
(function () {
  var api = location.origin + '/api/live';
  window.FLEET_LIVE = {
    api: api,
    ws: api.replace(/^http/, 'ws'),
    local: location.hostname === 'localhost' || location.hostname === '127.0.0.1',
    keep: '',
  };
})();
