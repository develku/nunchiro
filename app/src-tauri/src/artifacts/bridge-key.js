(function () {
  // v1b-23: web widget pages only, inserted before anything else in the page so it runs before widget code. It makes
  // a key the page never sees, announces it once, and stamps it on everything the page posts through `parent`. The
  // window answers only calls carrying the first announced key, so a page this frame navigates to (it has no key, or
  // announces a second one) cannot speak for the widget.
  var p = parent, w = window, def = Object.defineProperty, has = Object.prototype.hasOwnProperty;
  if (p === w) return;
  var a = new Uint32Array(4);
  crypto.getRandomValues(a);
  var key = a[0].toString(36) + '.' + a[1].toString(36) + '.' + a[2].toString(36) + '.' + a[3].toString(36);
  p.postMessage({ type: 'nunchiro:bridge', key: key }, '*');
  var proxy = {};
  def(proxy, 'postMessage', {
    value: function (m) {
      if (m === null || typeof m !== 'object') return p.postMessage(m, '*');
      var c = {};
      for (var k in m) if (has.call(m, k) && k !== 'key') c[k] = m[k];
      // defineProperty, not assignment: a setter page code put on Object.prototype never sees the key.
      def(c, 'key', { value: key, enumerable: true });
      p.postMessage(c, '*');
    },
  });
  def(w, 'parent', { value: proxy });
  // Replies come from the real parent; page code compares `e.source === parent`, so the parent reads as the proxy.
  var source = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source').get;
  def(MessageEvent.prototype, 'source', {
    get: function () {
      var s = source.call(this);
      return s === p ? proxy : s;
    },
  });
})();
