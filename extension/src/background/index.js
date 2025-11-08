// src/background/index.js
// Minimal background SW that understands UPLOAD_CANDIDATE and GET_LOGS
// Put your real upload/auth logic into uploadToBackend()

const DEBUG = true;
const API_URL = 'http://127.0.0.1:8000/api/analyze/';

// In-memory logs per tab (not durable across SW restarts)
const logsByTab = {};

// persist small logs to chrome.storage.local (optional)
async function persistLog(tabId, entry) {
  try {
    const key = `aegis_logs_tab_${tabId}`;
    const raw = await chrome.storage.local.get(key);
    const arr = raw[key] || [];
    arr.push(entry);
    await chrome.storage.local.set({ [key]: arr });
  } catch (e) {
    if (DEBUG) console.warn('[BG] persistLog err', e);
  }
}

function pushLog(tabId, entry) {
  logsByTab[tabId] = logsByTab[tabId] || [];
  logsByTab[tabId].push(entry);
  persistLog(tabId, entry);
}

// naive upload helper - replace with your authentication and error handling
async function uploadToBackend(formData) {
  const resp = await fetch(API_URL, { method: 'POST', body: formData });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upload failed ' + resp.status + ' ' + text);
  }
  return resp.json();
}

function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) {
        if (DEBUG) console.warn('[BG] sendMessage lastError', chrome.runtime.lastError.message);
      } else if (DEBUG) {
        console.log('[BG] sendMessage response', r);
      }
    });
  } catch (e) {
    console.error('[BG] safeSendMessage', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (DEBUG) console.log('[BG] onMessage', msg, 'from', sender && sender.tab && sender.tab.id ? 'tab:' + sender.tab.id : 'undefined');

  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'no-type' });
    return false;
  }

  if (msg.type === 'GET_LOGS') {
    const tabId = msg.tabId || (sender && sender.tab && sender.tab.id) || 'global';
    (async () => {
      let logs = logsByTab[tabId];
      if (!logs) {
        const key = `aegis_logs_tab_${tabId}`;
        const raw = await chrome.storage.local.get(key);
        logs = raw[key] || [];
      }
      sendResponse({ ok: true, logs });
    })();
    return true;
  }

  if (msg.type === 'UPLOAD_CANDIDATE') {
    const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId || 'global';
    (async () => {
      const ts = Date.now();
      try {
        const payload = msg.payload || {};
        // Build a FormData for upload - if files have base64, convert back to Blob
        const form = new FormData();
        form.append('prompt', payload.text || '');
        if (Array.isArray(payload.files)) {
          for (const f of payload.files) {
            if (f.base64) {
              // convert base64 -> Blob
              const binary = atob(f.base64);
              const len = binary.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
              const blob = new Blob([bytes], { type: f.type || 'application/octet-stream' });
              form.append('file', blob, f.name || 'attachment');
            } else {
              // no buffer provided: append metadata as JSON
              form.append('meta', JSON.stringify({ name: f.name, size: f.size, type: f.type }));
            }
          }
        }

        pushLog(tabId, { ts, type: 'UPLOAD_START', text: (payload.text || '').slice(0, 200) });
        // Call upload (replace with real)
        let result = {};
        try {
          result = await uploadToBackend(form);
        } catch (err) {
          // if upload fails, record error
          const entry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: false, error: String(err) };
          pushLog(tabId, entry);
          safeSendMessage({ type: 'UPLOAD_RESULT', tabId, error: String(err) });
          sendResponse({ ok: false, error: String(err) });
          return;
        }

        const entry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: true, result };
        pushLog(tabId, entry);
        safeSendMessage({ type: 'UPLOAD_RESULT', tabId, result });
        sendResponse({ ok: true, result });
      } catch (err) {
        const entry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: false, error: String(err) };
        pushLog(tabId, entry);
        safeSendMessage({ type: 'UPLOAD_RESULT', tabId, error: String(err) });
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // indicates async response
  }

  // fallback echo
  sendResponse({ ok: true, echo: msg });
  return false;
});
