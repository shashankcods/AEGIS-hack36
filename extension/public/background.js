// public/background.js
const MAX = 500;
const logs = [];

function d(...a) { console.log('[Aegis background]', ...a); }

chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
  try {
    d('received message:', msg && msg.type, 'from', sender && sender.tab ? sender.tab.url : 'extension');
    if (!msg || !msg.type) return;
    if (msg.type === 'UPLOAD_CANDIDATE') {
      const entry = { text: msg.text || '', files: (msg.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })), ts: Date.now(), source: msg.source || 'content' };
      logs.unshift(entry);
      if (logs.length > MAX) logs.pop();
      // broadcast to popup(s)
      try { chrome.runtime.sendMessage({ type: 'NEW_CAPTURE', entry }); } catch (e) {}
    } else if (msg.type === 'GET_LOGS') {
      sendResp({ ok: true, logs });
    }
  } catch (e) { console.error('[Aegis background] error', e); }
});
