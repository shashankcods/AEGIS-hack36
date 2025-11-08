// background/service-worker.js
// Full-file replacement: MV3 service worker that accepts UPLOAD_CANDIDATE messages
// and posts them to a configured backend. Replies to the sender to avoid 'message port closed'.
// IMPORTANT: set API_BASE to your backend origin below.

const API_BASE = 'https://your-real-backend.example.com/api'; // <<< REPLACE with real origin
const ANALYZE_PATH = '/analyze/json/'; // endpoint that accepts { text, files: [{name,mime,size,b64}] }
const TOKEN_STORAGE_KEY = 'aegis_api_token';
const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 800;

self.addEventListener('install', (e) => {
  // immediate activation in dev
  try { self.skipWaiting(); } catch (e) {}
});

self.addEventListener('activate', (e) => {
  try { self.clients.claim(); } catch (e) {}
});

// simple storage helpers
function getStoredToken() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([TOKEN_STORAGE_KEY], (res) => resolve((res && res[TOKEN_STORAGE_KEY]) ? res[TOKEN_STORAGE_KEY] : null));
    } catch (err) {
      resolve(null);
    }
  });
}

function saveJobRecord(jobId, meta) {
  // small queue of recent jobs
  try {
    chrome.storage.local.get(['aegis_jobs'], (res) => {
      const arr = Array.isArray(res && res.aegis_jobs) ? res.aegis_jobs : [];
      arr.unshift({ job_id: jobId, meta, created_at: (new Date()).toISOString() });
      // keep last 20
      const toSave = arr.slice(0, 20);
      chrome.storage.local.set({ aegis_jobs: toSave });
    });
  } catch (e) {
    console.warn('AEGIS background: saveJobRecord error', e);
  }
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function postJsonWithRetries(url, body, token) {
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const txt = await resp.text().catch(() => '');
      let json = null;
      try { json = resp.headers.get('content-type') && resp.headers.get('content-type').includes('application/json') ? JSON.parse(txt) : null; } catch (e) { json = null; }
      if (!resp.ok) {
        lastErr = { status: resp.status, body: txt };
        // For 4xx errors do not retry (client error) except 429
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw new Error(`HTTP ${resp.status}: ${txt}`);
        }
        // else continue to retry
      } else {
        return { ok: true, status: resp.status, body: json || txt };
      }
    } catch (err) {
      lastErr = err;
      // exponential backoff
      const backoff = Math.round(RETRY_BASE_MS * Math.pow(2, attempt));
      await delay(backoff);
    }
  }
  // all retries failed
  return { ok: false, error: lastErr ? (lastErr.message || lastErr) : 'unknown' };
}

// Ensure we answer sender quickly: handle onMessage and reply via sendResponse
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) {
        sendResponse({ ok: false, reason: 'invalid_message' });
        return;
      }

      // Handle candidate upload from content script
      if (msg.type === 'UPLOAD_CANDIDATE') {
        // send an immediate short ACK so the content script's callback doesn't trigger lastError
        // but we will also compute the upload and then include the final result in the same sendResponse call
        // (MV3 supports asynchronous sendResponse if we return true)
        const { text, files, source } = msg;
        console.log('[AEGIS bg] Received UPLOAD_CANDIDATE from', sender && sender.tab ? sender.tab.url : 'page', 'source=', source);

        // quick validation
        const payload = { text: (typeof text === 'string' ? text : ''), files: Array.isArray(files) ? files : [] };

        // Try to use stored token; if none, still attempt if API_BASE is configured
        const token = await getStoredToken();

        if (!API_BASE || API_BASE.includes('your-real-backend.example.com') || API_BASE.includes('your-backend.example.com')) {
          console.warn('[AEGIS bg] API_BASE not configured or still placeholder; skipping direct upload and returning ack-only.');
          // return a structured ack so content script knows a background exists but did not upload
          sendResponse({ ok: true, ack: true, uploaded: false, reason: 'no_api_configured' });
          return;
        }

        // perform POST to backend
        const url = API_BASE.replace(/\/$/, '') + ANALYZE_PATH;
        const result = await postJsonWithRetries(url, payload, token);

        if (result.ok) {
          // store job record if backend returns job_id
          try {
            const jobId = (result.body && result.body.job_id) ? result.body.job_id : null;
            if (jobId) saveJobRecord(jobId, { source, url });
          } catch (e) {}
          sendResponse({ ok: true, ack: true, uploaded: true, via: 'background', result: result.body || null });
        } else {
          console.warn('[AEGIS bg] upload failed', result);
          sendResponse({ ok: false, ack: true, uploaded: false, error: String(result.error || result) });
        }
        return;
      }

      // other message types: reply simple
      sendResponse({ ok: false, reason: 'unknown_type' });
    } catch (err) {
      console.error('[AEGIS bg] onMessage handler error', err);
      try { sendResponse({ ok: false, error: String(err) }); } catch (e) {}
    }
  })();

  // Indicate we'll call sendResponse asynchronously
  return true;
});
