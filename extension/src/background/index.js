// src/background/index.js
// MV3-safe background service worker — defensive startup and clear logs.

const DEBUG = true;
const API_BASE = 'http://127.0.0.1:8000';
const ANALYZE_PATH = '/api/analyze/';
const API_URL = API_BASE + ANALYZE_PATH;
const TOKEN_KEY = 'aegis_api_token';
const MAX_RETRY = 3;
const MAX_LOGS_PER_TAB = 500;

// in-memory logs map (tabId -> array)
const logsByTab = new Map();

function d(...args) { if (DEBUG) console.log('[Aegis background]', ...args); }

/* ---------- Basic safety handlers ---------- */
self.addEventListener('install', (ev) => {
  d('service worker installing - calling skipWaiting');
  try { self.skipWaiting(); } catch (e) { d('skipWaiting err', e); }
});
self.addEventListener('activate', (ev) => {
  d('service worker activating - claiming clients');
  try { self.clients && self.clients.claim && self.clients.claim(); } catch (e) { d('clients.claim err', e); }
});
self.addEventListener('error', (ev) => d('unhandled error in SW', ev && ev.message ? ev.message : ev));
self.addEventListener('unhandledrejection', (ev) => d('unhandledrejection in SW', ev && ev.reason ? ev.reason : ev));

/* ---------- Tiny chrome.storage promise wrappers ---------- */
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      d('storageGet wrapper error', e);
      resolve({});
    }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (e) {
      d('storageSet wrapper error', e);
      resolve();
    }
  });
}

/* ---------- Token helper ---------- */
async function readToken() {
  try {
    const items = await storageGet([TOKEN_KEY]);
    return items?.[TOKEN_KEY] || null;
  } catch (e) {
    d('readToken err', e);
    return null;
  }
}

/* ---------- Log helpers ---------- */
function ensureLogsFor(tabId) {
  if (!logsByTab.has(tabId)) logsByTab.set(tabId, []);
  return logsByTab.get(tabId);
}
async function persistLogForTab(tabId) {
  try {
    const arr = logsByTab.get(tabId) || [];
    const key = `aegis_logs_tab_${tabId}`;
    await storageSet({ [key]: arr.slice(0, MAX_LOGS_PER_TAB) });
  } catch (e) {
    d('persistLogForTab error', e);
  }
}
function safeBroadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      if (chrome.runtime.lastError) {
        // ignore receiving end missing (normal) but log other errors
        if (!chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
          d('broadcast err:', chrome.runtime.lastError && chrome.runtime.lastError.message);
        }
      } else {
        if (DEBUG) d('broadcasted', msg && msg.type);
      }
    });
  } catch (e) {
    d('safeBroadcast threw', e);
  }
}
function pushLogForTab(tabId, entry) {
  const arr = ensureLogsFor(tabId);
  arr.unshift(entry);
  while (arr.length > MAX_LOGS_PER_TAB) arr.pop();
  persistLogForTab(tabId);
  d('pushLogForTab', tabId, entry.type || 'log', 'count:', arr.length);
  safeBroadcast({ type: 'NEW_CAPTURE', entry, tabId });
}
async function clearLogsFor(tabId) {
  if (typeof tabId === 'undefined' || tabId === null) {
    logsByTab.clear();
    try {
      const all = await storageGet(null);
      const keys = Object.keys(all).filter(k => k.startsWith('aegis_logs_tab_'));
      for (const k of keys) await storageSet({ [k]: [] });
    } catch (e) {
      d('clearLogsFor err', e);
    }
  } else {
    logsByTab.set(tabId, []);
    const key = `aegis_logs_tab_${tabId}`;
    try { await storageSet({ [key]: [] }); } catch (e) { d('clearLogsFor persist err', e); }
  }
}

/* ---------- Upload helper with retry ---------- */
async function uploadToBackend({ form, token }) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(API_URL, { method: 'POST', body: form, headers, credentials: 'omit' });
      if (!res.ok) {
        const text = await res.text().catch(() => '<no body>');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const json = await res.json().catch(() => null);
      return json;
    } catch (err) {
      lastErr = err;
      d('upload attempt', attempt + 1, 'failed:', err && err.message);
      if (attempt < MAX_RETRY - 1) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('upload failed');
}

/* ---------- Convert incoming payload.files to FormData ---------- */
function buildFormFromPayload(payload) {
  const form = new FormData();
  if (payload.text) form.append('text', payload.text);
  if (Array.isArray(payload.files)) {
    for (const f of payload.files) {
      if (f.buffer && Array.isArray(f.buffer)) {
        const uint8 = new Uint8Array(f.buffer);
        const blob = new Blob([uint8], { type: f.type || 'application/octet-stream' });
        form.append('image', blob, f.name || 'upload.bin');
      } else if (f.base64) {
        try {
          const binary = atob(f.base64);
          const len = binary.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
          const b = new Blob([bytes], { type: f.type || 'application/octet-stream' });
          form.append('image', b, f.name || 'attachment');
        } catch (e) {
          d('base64->blob conversion failed', e);
          form.append('meta', JSON.stringify({ name: f.name, size: f.size, type: f.type }));
        }
      } else {
        form.append('meta', JSON.stringify({ name: f.name, size: f.size, type: f.type }));
      }
    }
  }
  return form;
}

/* ---------- Respond to messages (guarded) ---------- */
try {
  // Register top-level message listener early so PING works even if later logic throws
  chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
    try {
      if (!msg || !msg.type) {
        try { sendResp({ ok: false, error: 'no-type' }); } catch(e) {}
        return false;
      }
      if (msg.type === 'PING') {
        try { sendResp({ ok: true, msg: 'pong from background' }); } catch(e) {}
        return false;
      }

      if (msg.type === 'GET_LOGS') {
        const tabId = (typeof msg.tabId !== 'undefined') ? msg.tabId : ((sender && sender.tab && sender.tab.id) ? sender.tab.id : 'global');
        (async () => {
          try {
            let arr = logsByTab.get(tabId);
            if (!arr) {
              const key = `aegis_logs_tab_${tabId}`;
              const raw = await storageGet([key]);
              arr = raw[key] || [];
              logsByTab.set(tabId, arr);
            }
            try { sendResp({ ok: true, logs: arr }); } catch(e) {}
          } catch (e) { d('GET_LOGS err', e); try { sendResp({ ok: false, error: String(e)}); } catch{} }
        })();
        return true;
      }

      if (msg.type === 'SESSION_START') {
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (msg.tabId ?? 'unknown');
        clearLogsFor(tabId);
        try { sendResp({ ok: true }); } catch (e) {}
        return false;
      }
      if (msg.type === 'SESSION_END') {
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (msg.tabId ?? 'unknown');
        clearLogsFor(tabId);
        safeBroadcast({ type: 'SESSION_CLEARED', tabId });
        try { sendResp({ ok: true }); } catch (e) {}
        return false;
      }

      if (msg.type === 'UPLOAD_CANDIDATE') {
        const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId || 'global';
        (async () => {
          const ts = Date.now();
          const payload = msg.payload || {};
          try {
            const entryMeta = {
              textPreview: (payload.text || '').slice(0, 400),
              textLen: (payload.text || '').length,
              filesMeta: (payload.files || []).map(f => ({ name: f.name, size: f.size, type: f.type, hasBuffer: !!(f.buffer || f.base64) })),
              ts,
              source: msg.source || 'content',
            };
            pushLogForTab(tabId, Object.assign({}, entryMeta, { type: 'UPLOAD_START' }));

            const form = buildFormFromPayload(payload);
            const token = await readToken();
            let result;
            try {
              result = await uploadToBackend({ form, token });
            } catch (err) {
              const eEntry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: false, error: String(err) };
              pushLogForTab(tabId, eEntry);
              safeBroadcast({ type: 'UPLOAD_RESULT', tabId, error: String(err) });
              try { sendResp({ ok: false, error: String(err) }); } catch (e) {}
              return;
            }

            const okEntry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: true, result };
            pushLogForTab(tabId, okEntry);
            safeBroadcast({ type: 'UPLOAD_RESULT', tabId, result });
            try { sendResp({ ok: true, result }); } catch (e) {}
          } catch (err) {
            const entry = { ts: Date.now(), type: 'UPLOAD_RESULT', ok: false, error: String(err) };
            pushLogForTab(tabId, entry);
            safeBroadcast({ type: 'UPLOAD_RESULT', tabId, error: String(err) });
            try { sendResp({ ok: false, error: String(err) }); } catch (e) {}
          }
        })();
        return true;
      }

      // fallback
      try { sendResp({ ok: true, echo: msg }); } catch (e) {}
      return false;
    } catch (e) {
      d('onMessage outer handler error', e);
      try { sendResp({ ok: false, error: String(e) }); } catch (ee) {}
      return false;
    }
  });

  d('Background service worker active (guarded)');
} catch (e) {
  d('Fatal error registering onMessage', e);
  // Leave the worker alive but log; we don't rethrow so registration attempt doesn't kill the SW
}
