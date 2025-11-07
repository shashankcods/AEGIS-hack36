// dist/content_script.js - captures DOM text, files, and listens for injected previews
(() => {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { console.error('[CS] inject error', e); }

  const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
  const CAPTURE_LIMIT = 500;

  const sendToBackground = (payload) => {
    try { chrome.runtime.sendMessage({ type: 'STORE_CAPTURE', capture: payload }); }
    catch (e) { console.error('[CS] send error', e); }
  };

  async function handleFile(file, source) {
    const meta = { name: file.name, type: file.type, size: file.size, source };
    if (file.size > MAX_FILE_SIZE_BYTES) {
      sendToBackground({ kind: 'file', meta, note: 'file_too_large', ts: Date.now() });
      return;
    }
    try {
      const ab = await file.arrayBuffer();
      sendToBackground({ kind: 'file', meta, arrayBuffer: ab, ts: Date.now() });
    } catch (e) {
      console.error('[CS] file read', e);
      sendToBackground({ kind: 'file', meta, note: 'read_error', ts: Date.now() });
    }
  }

  document.addEventListener('change', (e) => {
    try {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'file' && t.files && t.files.length) {
        for (const f of t.files) handleFile(f, 'input-file-change');
      }
    } catch (e) {}
  }, true);

  document.addEventListener('paste', (e) => {
    try {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile(); if (f) handleFile(f, 'paste');
        } else if (it.kind === 'string') {
          it.getAsString((s) => { storeTextCapture(s, 'paste'); });
        }
      }
    } catch (e) {}
  }, true);

  document.addEventListener('drop', (e) => {
    try {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      for (const f of files) handleFile(f, 'drop');
    } catch (e) {}
  }, true);

  const recent = new Set();
  function storeTextCapture(text, source = 'dom') {
    const t = (text || '').trim();
    if (!t) return;
    const key = t.slice(0, 400);
    if (recent.has(key)) return;
    recent.add(key);
    if (recent.size > CAPTURE_LIMIT) {
      const it = recent.values().next().value;
      recent.delete(it);
    }
    const payload = { kind: 'text', source, text: t, ts: Date.now() };
    if (window.__AEGIS_CONSENT) sendToBackground(payload);
    else sendToBackground(Object.assign({}, payload, { note: 'no-consent' }));
  }

  function extractTextFromNode(node) {
    try {
      if (!node) return '';
      if (node.nodeType !== 1) return '';
      return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  function findChatContainer() {
    return document.querySelector('main') || document.body;
  }

  function startObserver() {
    const container = findChatContainer();
    if (!container) return;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          try {
            if (!node || node.nodeType !== 1) continue;
            const txt = extractTextFromNode(node);
            if (txt) storeTextCapture(txt, 'dom-added');
          } catch (e) {}
        }
      }
    });
    mo.observe(container, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else startObserver();

  window.addEventListener('message', (ev) => {
    try {
      if (!ev.data) return;
      if (ev.data.__Aegis_capture) {
        const out = { kind: 'outgoing', source: 'injected', payload: ev.data.payload, ts: Date.now() };
        if (window.__AEGIS_CONSENT) sendToBackground(out);
        else sendToBackground(Object.assign({}, out, { note: 'no-consent' }));
      }
    } catch (e) {}
  });
})();
