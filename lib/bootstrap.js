(function () {
  try {
    var MARK = '__DSH_SPLASH_CRT__';
    if (window[MARK]) return;
    window[MARK] = { state: 'booting' };
    var ROUTE = '@@ROUTE@@';

    // Watchdog: whatever happens below, the UI must come back.
    var html = document.documentElement;
    var release = function (state) {
      try {
        if (window[MARK] && state) window[MARK].state = state;
        if (html) {
          html.style.visibility = '';
          html.removeAttribute('data-dsh-splash-locked');
        }
      } catch (e) {}
    };

    // Hide the page before the first paint so the splash covers it from frame one.
    try {
      if (html && !html.hasAttribute('data-dsh-splash-locked')) {
        html.setAttribute('data-dsh-splash-locked', '1');
        html.style.visibility = 'hidden';
        setTimeout(function () {
          try {
            if (window[MARK] && window[MARK].state !== 'done') release('timeout');
          } catch (e) {}
        }, 5000);
      }
    } catch (e) {}

    // Load the browser half ourselves. A failure here is swallowed on purpose:
    // the page must never fail to boot because this plugin could not load.
    var boot = function () {
      try {
        var host = document.body || document.head || document.documentElement;
        if (!host) return;
        var el = document.createElement('script');
        el.src = ROUTE + '/client.js';
        el.async = false;
        el.onerror = function () { release('client-load-failed') };
        host.appendChild(el);
      } catch (e) {
        release('client-load-threw')
      }
    };
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  } catch (e) {
    try {
      var h2 = document.documentElement;
      if (h2) h2.style.visibility = '';
    } catch (e2) {}
  }
})();
