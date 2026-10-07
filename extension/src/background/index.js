import { buildFormFromPayload, requestBackend, safeResultSummary } from './api.js';

const TOKEN_KEY = 'aegis_api_token';
const logsByTab = new Map();
const jobsByTab = new Map();
const SUPPORTED_HOSTS = new Set(['chatgpt.com', 'chat.openai.com', 'gemini.google.com']);

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, items => resolve(items || {})));
}

async function readToken() {
  return (await storageGet([TOKEN_KEY]))[TOKEN_KEY] || null;
}

// Older versions persisted prompt previews. Current logs contain counts and labels only.
async function clearLegacyLogs() {
  const stored = await storageGet(null);
  const keys = Object.keys(stored).filter(key => key.startsWith('aegis_logs_tab_'));
  if (keys.length) chrome.storage.local.remove(keys);
}
clearLegacyLogs().catch(() => {});

function broadcast(message) {
  chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
}

function sendToTab(tabId, message) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, message, () => { void chrome.runtime.lastError; });
}

function record(tabId, entry) {
  const logs = logsByTab.get(tabId) || [];
  logs.unshift(entry);
  logsByTab.set(tabId, logs.slice(0, 100));
  broadcast({ type: 'NEW_CAPTURE', tabId, entry });
}

function isSupportedSender(sender) {
  try { return SUPPORTED_HOSTS.has(new URL(sender.tab?.url || sender.url || '').hostname); }
  catch { return false; }
}

async function processJob(tabId, state, job) {
  state.running = true;
  const { payload, requestId, respond } = job;
  try {
    const token = await readToken();
    const result = await requestBackend('/api/analyze/', {
      method: 'POST', body: buildFormFromPayload(payload),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!result || !Array.isArray(result.detections)) throw new Error('The backend returned an invalid analysis response.');
    if (state.latestId !== requestId) {
      respond({ ok: false, superseded: true, requestId });
    } else {
      record(tabId, {
        ts: Date.now(), type: 'UPLOAD_RESULT', ok: true,
        textLen: (payload.text || '').length, fileCount: (payload.files || []).length,
        result: safeResultSummary(result),
      });
      sendToTab(tabId, { type: 'UPLOAD_RESULT', result, requestId });
      broadcast({ type: 'UPLOAD_RESULT', tabId, requestId });
      respond({ ok: true, result, requestId });
    }
  } catch (error) {
    if (state.latestId !== requestId) {
      respond({ ok: false, superseded: true, requestId });
    } else {
      const message = error instanceof Error ? error.message : 'The privacy check failed.';
      record(tabId, { ts: Date.now(), type: 'UPLOAD_RESULT', ok: false, error: message });
      sendToTab(tabId, { type: 'UPLOAD_RESULT', error: message, requestId });
      respond({ ok: false, error: message, requestId });
    }
  } finally {
    state.running = false;
    if (state.pending) {
      const next = state.pending;
      state.pending = null;
      void processJob(tabId, state, next);
    }
  }
}

function enqueue(tabId, job) {
  const state = jobsByTab.get(tabId) || { running: false, pending: null, latestId: null };
  state.latestId = job.requestId;
  jobsByTab.set(tabId, state);
  if (state.running) {
    if (state.pending) state.pending.respond({ ok: false, superseded: true, requestId: state.pending.requestId });
    state.pending = job;
  } else {
    void processJob(tabId, state, job);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'PING') { respond({ ok: true }); return false; }
  if (message?.type === 'GET_LOGS') {
    respond({ ok: true, logs: logsByTab.get(message.tabId ?? sender.tab?.id) || [] });
    return false;
  }
  if (message?.type === 'SESSION_START' || message?.type === 'SESSION_END') {
    logsByTab.delete(sender.tab?.id);
    respond({ ok: true });
    return false;
  }
  if (message?.type === 'GET_STATS') {
    (async () => {
      const token = await readToken();
      const options = { headers: token ? { Authorization: `Bearer ${token}` } : {} };
      const [stats, health] = await Promise.allSettled([
        requestBackend('/api/stats/', options, { timeoutMs: 15000, maxAttempts: 1 }),
        requestBackend('/api/health/', options, { timeoutMs: 15000, maxAttempts: 1 }),
      ]);
      respond({
        ok: stats.status === 'fulfilled',
        data: stats.status === 'fulfilled' ? stats.value : null,
        error: stats.status === 'rejected' ? stats.reason.message : null,
        health: health.status === 'fulfilled' ? health.value : null,
        healthError: health.status === 'rejected' ? health.reason.message : null,
      });
    })().catch(() => respond({ ok: false, error: 'Cannot connect to the local backend.' }));
    return true;
  }
  if (message?.type === 'UPLOAD_CANDIDATE') {
    if (!isSupportedSender(sender)) {
      respond({ ok: false, error: 'AEGIS only analyzes prompts on ChatGPT and Gemini.' });
      return false;
    }
    const payload = message.payload || {};
    if (!(payload.text || '').trim() && !payload.files?.length) {
      respond({ ok: false, error: 'Enter text or attach a supported image or PDF first.' });
      return false;
    }
    enqueue(sender.tab.id, {
      payload, requestId: message.requestId || crypto.randomUUID(), respond,
    });
    return true;
  }
  respond({ ok: false, error: 'Unknown extension message.' });
  return false;
});

chrome.tabs.onRemoved.addListener(tabId => {
  logsByTab.delete(tabId);
  const state = jobsByTab.get(tabId);
  if (state) {
    state.latestId = null;
    state.pending?.respond({ ok: false, superseded: true });
    state.pending = null;
  }
  jobsByTab.delete(tabId);
});
