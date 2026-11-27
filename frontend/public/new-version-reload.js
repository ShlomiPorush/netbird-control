(function () {
  var MARK = 'nbc-new-version-reload';
  var WINDOW_MS = 30000;

  function recentlyReloaded() {
    try { return Date.now() - Number(sessionStorage.getItem(MARK) || 0) < WINDOW_MS; } catch (e) { return false; }
  }

  function decideReload() {
    if (recentlyReloaded()) return false;
    try { sessionStorage.setItem(MARK, String(Date.now())); } catch (e) { }
    window.location.reload();
    return true;
  }

  window.addEventListener('error', function (event) {
    var el = event.target;
    var url = el && (el.src || el.href) || '';
    if ((el.tagName === 'SCRIPT' || el.tagName === 'LINK') && url.indexOf('/assets/') !== -1) decideReload();
  }, true);

  window.addEventListener('vite:preloadError', function (event) {
    if (decideReload()) event.preventDefault();
  });
})();
