/* dist/background.js - MV3 service worker (simple upload stub)
   Replace BACKEND_URL below when you have a server. */
const BACKEND_URL = 'YOUR_BACKEND_URL_HERE'; // <-- set this later
const CAPTURE_KEY = 'aegis_captures';
const CONSENT_KEY = 'aegis_consent';
const MAX_STORED = 500;

async function getStored() {
  const data = await chrome.storage.local.get(CAPTURE_KEY);
  return data[CAPTURE_KEY] || [];
}
async function setStored(arr) {
  await chrome.storage.local.set({ [CAPTURE_KEY]: arr.slice(0, MAX_STORED) });
}
async function pushCapture(cap) {
  const arr = await getStored();
  cap.id = cap.id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  arr.unshift(cap);
  await setStored(arr);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'STORE_CAPTURE' && msg.capture) {
    (async () => {
      try { await pushCapture(msg.capture); } catch (e) { console.error('[BG] push error', e); }
    })();
    return;
  }
  if (msg.cmd === 'GET_CAPTURES') {
    (async () => {
      const arr = await getStored();
      sendResponse({ ok: true, captures: arr });
    })();
    return true;
  }
  if (msg.cmd === 'CLEAR_CAPTURES') {
    (async () => { await setStored([]); sendResponse({ ok: true }); })();
    return true;
  }
  if (msg.cmd === 'UPLOAD_CAPTURE' && msg.captureId) {
    (async () => {
      try {
        const arr = await getStored();
        const cap = arr.find(c => c.id === msg.captureId);
        if (!cap) { sendResponse({ ok: false, error: 'not_found' }); return; }
        if (!BACKEND_URL || BACKEND_URL === 'YOUR_BACKEND_URL_HERE') {
          sendResponse({ ok: false, error: 'no_backend_configured' });
          return;
        }
        const form = new FormData();
        form.append('meta', JSON.stringify({ id: cap.id, kind: cap.kind, ts: cap.ts || Date.now(), meta: cap.meta || null }));
        if (cap.kind === 'file' && cap.arrayBuffer) {
          const ab = cap.arrayBuffer;
          const blob = new Blob([ab], { type: (cap.meta && cap.meta.type) || 'application/octet-stream' });
          form.append('file', blob, (cap.meta && cap.meta.name) || 'file.bin');
        } else if (cap.kind === 'file') {
          form.append('note', cap.note || 'file-not-captured');
        } else if (cap.kind === 'text') {
          form.append('text', cap.text || '');
        } else if (cap.kind === 'outgoing') {
          form.append('payload', JSON.stringify(cap.payload || {}));
        } else {
          form.append('data', JSON.stringify(cap));
        }
        const resp = await fetch(BACKEND_URL, { method: 'POST', body: form });
        const text = await resp.text();
        sendResponse({ ok: true, status: resp.status, body: text });
      } catch (e) {
        console.error('[BG] upload error', e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
});
