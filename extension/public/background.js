// public/background.js
const API_BASE = 'http://127.0.0.1:8000';
const ANALYZE_PATH = '/api/analyze/';
const TOKEN_KEY = 'aegis_api_token';
const MAX_ACCEPT_BYTES = 12 * 1024 * 1024; // background limit: 12 MB (tweak as needed)
const MAX_RETRY = 3;

const MAX_LOGS = 500;
const logs = [];

function d(...a) { console.log('[Aegis background]', ...a); }

function readToken() {
  return new Promise((res) => {
    try {
      chrome.storage.local.get([TOKEN_KEY], (items) => {
        res(items && items[TOKEN_KEY] ? items[TOKEN_KEY] : null);
      });
    } catch (e) {
      d('readToken error', e);
      res(null);
    }
  });
}

// Upload to backend using FormData. files: array of {name,type,size,buffer} where buffer may be ArrayBuffer or null
async function uploadToBackend({ text, files = [] }) {
  const token = await readToken();
  const form = new FormData();
  form.append('text', text || '');

  let totalBytes = 0;
  for (const f of files) totalBytes += (f.size || (f.buffer ? f.buffer.byteLength : 0));
  if (totalBytes > MAX_ACCEPT_BYTES) {
    throw new Error(`Total files size ${totalBytes} > background limit ${MAX_ACCEPT_BYTES}. Use chunked upload or staging.`);
  }

  // Append files that have buffers. If buffer is null, skip but include metadata param for server if you like.
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.buffer) {
      // skip actual file content — we could append a small metadata field instead
      form.append('file_meta', JSON.stringify({ name: f.name, size: f.size, type: f.type }));
      continue;
    }
    // convert ArrayBuffer -> Blob
    const blob = new Blob([f.buffer], { type: f.type || 'application/octet-stream' });
    // field name: files (Django will see request.FILES.getlist('files'))
    form.append('files', blob, f.name || `file-${i}`);
  }

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url = API_BASE + ANALYZE_PATH;

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body: form, headers, credentials: 'omit' });
      if (!res.ok) {
        const text = await res.text().catch(()=>'');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const json = await res.json().catch(()=>null);
      return json;
    } catch (err) {
      lastErr = err;
      d('upload attempt', attempt+1, 'failed', err && err.message);
      if (attempt < MAX_RETRY - 1) await new Promise(r => setTimeout(r, 300 * (attempt+1)));
    }
  }
  throw lastErr || new Error('upload failed');
}

// port-based broadcasting
const connectedPorts = new Map(); // key: port.sender.tab?.id || 'popup', value: port

// call this when a log is pushed
function pushLog(entry) {
  logs.unshift(entry);
  while (logs.length > MAX_LOGS) logs.pop();
  d('pushLog: total logs', logs.length);

  // Broadcast to connected ports (if any)
  for (const [id, port] of connectedPorts.entries()) {
    try {
      port.postMessage({ type: 'NEW_CAPTURE', entry });
    } catch (e) {
      d('port postMessage failed for', id, e && e.message);
      // If port is dead, remove it
      try { port.disconnect(); } catch(_) {}
      connectedPorts.delete(id);
    }
  }
}



chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
  (async () => {
    try {
      d('received message:', msg && msg.type, 'from', sender && sender.tab ? sender.tab.url : 'extension');
      if (!msg || !msg.type) return sendResp({ ok: false, error: 'missing message type' });

      if (msg.type === 'UPLOAD_CANDIDATE') {
        const payload = msg.payload || {};
        const entry = {
          textPreview: (payload.text || '').slice(0, 400),
          textLen: (payload.text || '').length,
          filesMeta: (payload.files || []).map(f => ({ name: f.name, size: f.size, type: f.type, hasBuffer: !!f.buffer })),
          ts: Date.now(),
          source: msg.source || 'content'
        };
        pushLog(entry);

        try {
          // If all files have null buffers, we will still post metadata (server may request client to resend or instruct chunking)
          const result = await uploadToBackend({ text: payload.text, files: payload.files || [] });
          d('upload result', result);
          return sendResp({ ok: true, result });
        } catch (err) {
          d('upload error', err && err.message);
          return sendResp({ ok: false, error: err && err.message ? String(err.message) : String(err) });
        }
      } else if (msg.type === 'GET_LOGS') {
        return sendResp({ ok: true, logs });
      } else {
        return sendResp({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      d('background handler exception', e);
      try { sendResp({ ok: false, error: String(e) }); } catch (ee) {}
    }
  })();
  // Tell Chrome we will call sendResp asynchronously.
  return true;
});
