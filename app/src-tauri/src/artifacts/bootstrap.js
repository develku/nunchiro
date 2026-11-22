(function () {
  var h;
  function post(m) {
    if (parent !== window) parent.postMessage(m, '*');
  }
  // Only http(s) links leave, and only for a real click; the window re-checks the scheme and the sender.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null, u;
    if (!a) return;
    try { u = new URL(a.getAttribute('href'), document.baseURI); } catch (x) { return; }
    e.preventDefault();
    if (e.isTrusted && /^https?:$/.test(u.protocol)) post({ type: 'nunchiro:open-link', url: u.href });
  }, true);
  function size() {
    var r = document.documentElement;
    var v = Math.ceil(r.scrollHeight > r.clientHeight ? r.scrollHeight : r.getBoundingClientRect().height);
    if (v === h) return;
    h = v;
    post({ type: 'nunchiro:height', height: v });
  }
  if (window.ResizeObserver) {
    var o = new ResizeObserver(size);
    o.observe(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { if (document.body) o.observe(document.body); });
  }
  window.addEventListener('load', size);
  document.addEventListener('securitypolicyviolation', function (e) {
    post({ type: 'nunchiro:csp-violation', directive: e.violatedDirective, blocked: e.blockedURI });
  });
  post({ type: 'nunchiro:ready' });
})();
