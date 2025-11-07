// dist/injected.js - page context (posts small previews to content script)
(function () {
  function safePost(detail) { try { window.postMessage({ __Aegis_capture: true, payload: detail }, '*'); } catch (e) {} }

  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = (typeof input === 'string' ? input : (input && input.url)) || '';
        let bodyPreview = null;
        if (init && init.body) {
          try {
            if (typeof init.body === 'string') bodyPreview = init.body.slice(0, 10000);
            else if (init.body instanceof FormData) {
              const keys = [];
              for (const pair of init.body.entries()) keys.push(pair[0]);
              bodyPreview = { formKeys: keys };
            } else bodyPreview = '[non-serializable-body]';
          } catch (e) { bodyPreview = '[body-extract-error]'; }
        }
        safePost({ kind: 'fetch', url, bodyPreview });
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  } catch (e) {}

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__aegis_meta = { method, url }; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        let bodyPreview = null;
        if (typeof body === 'string') bodyPreview = body.slice(0, 10000);
        else if (body instanceof FormData) {
          const keys = [];
          for (const pair of body.entries()) keys.push(pair[0]);
          bodyPreview = { formKeys: keys };
        } else if (body instanceof Blob || body instanceof ArrayBuffer) bodyPreview = '[binary]';
        safePost({ kind: 'xhr', url: (this.__aegis_meta && this.__aegis_meta.url) || '', method: this.__aegis_meta && this.__aegis_meta.method, bodyPreview });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  } catch (e) {}

  try {
    const OrigWS = window.WebSocket;
    const WrappedWS = function (url, protocols) {
      const sock = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      const origSend = sock.send;
      sock.send = function (data) {
        try {
          const preview = (typeof data === 'string') ? data.slice(0, 2000) : '[binary]';
          safePost({ kind: 'ws', url, preview });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
      return sock;
    };
    WrappedWS.prototype = OrigWS.prototype;
    window.WebSocket = WrappedWS;
  } catch (e) {}
})();
