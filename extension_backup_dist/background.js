// public/background.js
const API_BASE = 'http://127.0.0.1:8000';
const ANALYZE_PATH = '/api/analyze/';
const TOKEN_KEY = 'aegis_api_token';
const MAX_RETRY = 3;
const MAX_LOGS = 500;

const logs = [];
function d(...a) { console.log('[Aegis background]', ...a); }

// ---- Keep-alive heartbeat ----
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Aegis background] Installed');
  chrome.alarms.create('aegis_heartbeat', { periodInMinutes: 4 });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Aegis background] Startup');
  chrome.alarms.create('aegis_heartbeat', { periodInMinutes: 4 });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'aegis_heartbeat') d('heartbeat tick');
});

// ---- Read token helper ----
function readToken() {
  return new Promise(res => {
    try {
      chrome.storage.local.get([TOKEN_KEY], items => res(items?.[TOKEN_KEY] || null));
    } catch (e) { d('readToken error', e); res(null); }
  });
}

// ---- Ping responder ----
chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
  if (msg?.type === 'PING') {
    d('Got PING from', sender?.url);
    sendResp({ ok: true, msg: 'pong from background' });
    return true;
  }
});

// ---- Upload function ----
async function uploadToBackend({ text, files = [] }) {
  const token = await readToken();
  const form = new FormData();
  if (text) form.append('text', text);

  if (files.length > 0) {
    const f = files[0];
    let blob = null;
    if (f.buffer && Array.isArray(f.buffer)) {
      const uint8 = new Uint8Array(f.buffer);
      blob = new Blob([uint8], { type: f.type || 'application/octet-stream' });
    }
    if (blob) {
      d('Attached blob:', f.name, blob.size);
      form.append('image', blob, f.name || 'upload.bin');
    } else {
      d('⚠️ file missing buffer', f.name);
    }
  }

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = API_BASE + ANALYZE_PATH;

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", body: form, headers, credentials: "omit" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      // try parse JSON, otherwise return null
      const json = await res.json().catch(() => null);
      return json;
    } catch (err) {
      lastErr = err;
      d("upload attempt", attempt + 1, "failed:", err && err.message);
      if (attempt < MAX_RETRY - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("upload failed");
}

// add entry to logs for a tab and notify listeners
function pushLogForTab(tabId, entry) {
  const arr = ensureLogsFor(tabId);
  arr.unshift(entry);
  while (arr.length > MAX_LOGS_PER_TAB) arr.pop();
  d("pushLogForTab:", tabId, "count:", arr.length);

  // runtime broadcast NEW_CAPTURE with tabId included
  try {
    chrome.runtime.sendMessage({ type: "NEW_CAPTURE", entry, tabId }, () => {
      const le = chrome.runtime.lastError;
      if (le && !le.message.includes("Receiving end does not exist")) d("broadcast NEW_CAPTURE err:", le.message);
    });
  } catch (e) {
    d("broadcast NEW_CAPTURE threw:", e && e.message ? e.message : e);
  }
}

// safe runtime broadcast helper for arbitrary message
function safeBroadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      const le = chrome.runtime.lastError;
      if (le && !le.message.includes("Receiving end does not exist")) d("broadcast err:", le.message);
    });
  } catch (e) {
    d("broadcast threw:", e && e.message ? e.message : e);
  }
}

// message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
  (async () => {
    try {
      d("received message:", msg && msg.type, "from", sender && sender.tab ? sender.tab.url : "extension");

      if (!msg || !msg.type) return sendResp({ ok: false, error: "missing message type" });

      // SESSION_START: clear logs for this tab (start of new ChatGPT session)
      if (msg.type === "SESSION_START") {
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (msg.tabId ?? "unknown");
        clearLogsFor(tabId);
        return sendResp({ ok: true });
      }

      // SESSION_END: clear logs for this tab (page refresh/close)
      if (msg.type === "SESSION_END") {
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (msg.tabId ?? "unknown");
        clearLogsFor(tabId);
        // notify UI(s) that session cleared for this tab
        safeBroadcast({ type: "SESSION_CLEARED", tabId });
        return sendResp({ ok: true });
      }

      // UPLOAD_CANDIDATE: content script captured text/files -> upload to backend
      if (msg.type === "UPLOAD_CANDIDATE") {
        const payload = msg.payload || {};
        // prefer tab id from sender when available
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : (msg.tabId ?? "unknown");

        const entryMeta = {
          textPreview: (payload.text || "").slice(0, 400),
          textLen: (payload.text || "").length,
          filesMeta: (payload.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type, hasBuffer: !!f.buffer })),
          ts: Date.now(),
          source: msg.source || "content",
        };

        // store meta as a capture log
        pushLogForTab(tabId, entryMeta);

        try {
          const result = await uploadToBackend({ text: payload.text, files: payload.files || [] });
          d("upload result", result);

          // broadcast the parsed result with tabId
          safeBroadcast({ type: "UPLOAD_RESULT", result, tabId });

          // also save a result entry in logs (so GET_LOGS returns it)
          const resultEntry = Object.assign({}, entryMeta, { result, ts: Date.now() });
          pushLogForTab(tabId, resultEntry);

          return sendResp({ ok: true, result });
        } catch (err) {
          d("upload error", err && err.message);
          return sendResp({ ok: false, error: err && err.message ? String(err.message) : String(err) });
        }
      }

      // GET_LOGS: return logs for supplied tabId or sender.tab.id
      if (msg.type === "GET_LOGS") {
        const tabId = (typeof msg.tabId !== "undefined") ? msg.tabId : ((sender && sender.tab && sender.tab.id) ? sender.tab.id : "unknown");
        const arr = logsByTab.get(tabId) || [];
        return sendResp({ ok: true, logs: arr });
      }

      // RESET_SESSION (compat): clear logs for tab or all
      if (msg.type === "RESET_SESSION") {
        const tabId = (typeof msg.tabId !== "undefined") ? msg.tabId : ((sender && sender.tab && sender.tab.id) ? sender.tab.id : undefined);
        if (typeof tabId !== "undefined") {
          clearLogsFor(tabId);
          safeBroadcast({ type: "SESSION_CLEARED", tabId });
        } else {
          logsByTab.clear();
          safeBroadcast({ type: "SESSION_CLEARED", tabId: null });
        }
        return sendResp({ ok: true });
      }

      // PING: quick alive response
      if (msg.type === "PING") return sendResp({ ok: true });

      // unknown
      return sendResp({ ok: false, error: "unknown message type" });
    } catch (e) {
      d("background handler exception", e);
      try { sendResp({ ok: false, error: String(e) }); } catch (ee) {}
    }
  })();

  // indicate we'll respond asynchronously
  return true;
});

d('Background worker active');
