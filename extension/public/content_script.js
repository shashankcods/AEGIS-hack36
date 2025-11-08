// public/content_script.js
// Full replacement: prefer background upload (secure) + fallback direct POST with graceful chrome.runtime handling
(function () {
  const DEBUG_TAG = '[Aegis content_script]';
  const ROOT_SELECTOR = '#prompt-textarea';
  const OVERLAY_ID = 'aegis-overlay-logger';

  function d(...a) { try { console.log(DEBUG_TAG, ...a); } catch (e) {} }

  // --- Overlay creation (idempotent) ---
  function createOverlay() {
    let o = document.getElementById(OVERLAY_ID);
    if (o) return o;
    o = document.createElement('div');
    o.id = OVERLAY_ID;
    Object.assign(o.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483647,
      width: '360px', maxHeight: '40vh', overflowY: 'auto',
      background: '#071028', color: '#e6eef8', padding: '10px',
      borderRadius: '10px', boxShadow: '0 8px 28px rgba(2,8,20,0.7)',
      fontFamily: 'system-ui, Arial, sans-serif', fontSize: '12px'
    });
    const head = document.createElement('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.marginBottom = '8px';
    head.innerHTML = `<strong style="font-size:13px">AEGIS — live capture</strong>`;
    const btn = document.createElement('button');
    btn.textContent = 'Hide';
    Object.assign(btn.style, { fontSize: '12px', padding: '4px 8px', cursor: 'pointer' });
    btn.onclick = () => { o.style.display = (o.style.display === 'none') ? '' : 'none'; btn.textContent = (o.style.display === 'none') ? 'Show' : 'Hide'; };
    head.appendChild(btn);
    o.appendChild(head);

    const promptEl = document.createElement('pre');
    promptEl.id = OVERLAY_ID + '-prompt';
    Object.assign(promptEl.style, { whiteSpace: 'pre-wrap', margin: 0, padding: '6px', background: '#0b1730', borderRadius: '6px', maxHeight: '6em', overflow: 'auto' });
    promptEl.textContent = 'Waiting for prompt...';
    o.appendChild(promptEl);

    const filesList = document.createElement('div');
    filesList.id = OVERLAY_ID + '-files';
    filesList.style.marginTop = '8px';
    filesList.textContent = 'Attachments: None';
    o.appendChild(filesList);

    document.body.appendChild(o);
    return o;
  }

  // --- Utilities ---
  function findParagraph() {
    const root = document.querySelector(ROOT_SELECTOR);
    if (!root) return null;
    return root.querySelector('p') || root;
  }
  function readParagraphText(p) {
    if (!p) return '';
    return (p.innerText ?? p.textContent ?? '').replace(/\u00A0/g, '');
  }

  const stagedFiles = []; // { name, type, size, data }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
      fr.onerror = (e) => reject(e || new Error('FileReader error'));
      fr.readAsDataURL(file);
    });
  }

  function updateOverlayPrompt(text) {
    const pre = document.getElementById(OVERLAY_ID + '-prompt');
    if (pre) pre.textContent = text || '';
  }
  function updateOverlayFiles() {
    const el = document.getElementById(OVERLAY_ID + '-files');
    if (!el) return;
    if (!stagedFiles.length) { el.textContent = 'Attachments: None'; return; }
    el.innerHTML = '';
    stagedFiles.forEach((f, i) => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      row.innerHTML = `<div style="font-weight:700">${i+1}. ${escapeHtml(f.name)}</div>
                       <div style="font-size:11px;color:#9fb0d6">${f.type || 'unknown'} — ${Math.round((f.size||0)/1024)} KB</div>`;
      el.appendChild(row);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]); }

  function consoleProof(source, text, files) {
    const excerpt = (text || '').slice(0, 300);
    try {
      console.groupCollapsed('%cAEGIS capture — ' + source, 'background:#071028;color:#cfe8ff;padding:4px;border-radius:4px');
      console.log('excerpt:', excerpt);
      if (files && files.length) console.log('files:', files.map(f => ({ name: f.name, size: f.size, type: f.type })));
      console.log('full text:', text);
      console.groupEnd();
    } catch (e) {}
  }

  // --- Preferred: send to background (secure) ---
  // Wrap chrome.runtime.sendMessage in a Promise and handle lastError gracefully
  function sendToBackgroundMessage(payload) {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ ok: false, reason: 'no_runtime' });
          return;
        }
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            // runtime.lastError — background might not have responded
            d('chrome.runtime.lastError', err && err.message);
            resolve({ ok: false, reason: 'runtime_last_error', error: (err && err.message) || String(err) });
            return;
          }
          // if background replies with explicit no_background we fall back
          if (!resp) {
            resolve({ ok: true, background_ack: false, body: null });
          } else {
            resolve({ ok: true, background_ack: true, body: resp });
          }
        });
      } catch (e) {
        resolve({ ok: false, reason: 'send_exception', error: String(e) });
      }
    });
  }

  // --- Direct POST fallback (dev) ---
  // IMPORTANT: set API_BASE to your real backend origin if you want this fallback to work
  const API_BASE = 'https://your-backend.example.com/api'; // <<< REPLACE THIS with your real backend origin
  const ANALYZE_PATH = '/analyze/json/';
  const TOKEN_KEY = 'aegis_api_token';
  const LARGE_PAYLOAD_THRESHOLD = 6_000_000;

  function approxPayloadSizeBytes(text, files) {
    let s = text ? text.length * 2 : 0;
    for (const f of (files || [])) if (f && f.data) s += Math.ceil((f.data.length * 3) / 4);
    return s;
  }
  function getStoredToken() {
    return new Promise((resolve) => {
      try {
        if (chrome && chrome.storage && chrome.storage.local) chrome.storage.local.get([TOKEN_KEY], (res) => resolve((res && res[TOKEN_KEY]) ? res[TOKEN_KEY] : null));
        else resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function buildJsonPayload(text, files) {
    const payload = { text: String(text || ''), files: [] };
    for (const f of (files || [])) payload.files.push({ name: f.name || 'unknown', mime: f.type || 'application/octet-stream', size: f.size || 0, b64: f.data || null });
    return payload;
  }
  async function postAnalyzeJson(text, files) {
    try {
      const payload = buildJsonPayload(text, files);
      const size = approxPayloadSizeBytes(text, files);
      if (size > LARGE_PAYLOAD_THRESHOLD) {
        updateOverlayPrompt('Payload too large');
        return { ok: false, reason: 'too_large' };
      }
      const token = await getStoredToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      updateOverlayPrompt('(uploading...)');
      const resp = await fetch(API_BASE + ANALYZE_PATH, { method: 'POST', headers, body: JSON.stringify(payload) });
      const txt = await resp.text().catch(() => '');
      let json = null;
      try { json = resp.headers.get('content-type') && resp.headers.get('content-type').includes('application/json') ? JSON.parse(txt) : null; } catch(e){ json = null; }
      if (!resp.ok) {
        d('analyze POST failed', resp.status, txt);
        updateOverlayPrompt('Upload failed: ' + (resp.status || 'network'));
        return { ok: false, status: resp.status, body: txt };
      }
      updateOverlayPrompt('Uploaded — job accepted');
      return { ok: true, status: resp.status, body: json || txt };
    } catch (err) {
      d('postAnalyzeJson error', err);
      updateOverlayPrompt('Upload error');
      return { ok: false, error: String(err) };
    }
  }

  // --- Orchestrator: try background then fallback to direct POST ---
  async function uploadCapture(text, files, source) {
    try {
      updateOverlayPrompt('(sending to background...)');
      // send metadata & staged files data (they are base64 encoded in stagedFiles.data)
      const payload = { type: 'UPLOAD_CANDIDATE', text, files: files || [], source };
      const bgRes = await sendToBackgroundMessage(payload);

      if (bgRes.ok && bgRes.background_ack) {
        // background accepted and responded
        d('background ack', bgRes.body);
        updateOverlayPrompt('Queued for upload (background)');
        return { ok: true, via: 'background', body: bgRes.body || null };
      }

      // No background available or it didn't ack — fallback if API_BASE replaced
      d('background missing or no ack, bgRes:', bgRes);
      if (!API_BASE || API_BASE.includes('your-backend.example.com')) {
        updateOverlayPrompt('No background ack and no direct API configured.');
        return { ok: false, reason: 'no_background_no_api' };
      }

      // fallback to direct POST (dev)
      updateOverlayPrompt('(background missing — direct upload)');
      const postRes = await postAnalyzeJson(text, files);
      return Object.assign({ via: 'direct' }, postRes);
    } catch (err) {
      d('uploadCapture failed', err);
      updateOverlayPrompt('Upload orchestration error');
      return { ok: false, error: String(err) };
    }
  }

  // --- Event handler that page dispatch uses ---
  async function handleEventTrigger(rid) {
    try {
      const p = findParagraph();
      const t = readParagraphText(p);
      updateOverlayPrompt('(event-received) ' + ((t && t.slice(0,80)) || '(empty)'));
      d('performManualCaptureAndUpload start rid=' + String(rid));
      // perform upload orchestration
      const res = await uploadCapture(t, stagedFiles, 'manual-capture');
      d('uploadCapture result', res);
      // reply to page if it expects via postMessage
      if (rid) {
        try { window.postMessage({ __aegis_response_id: rid, payload: res }, '*'); } catch(e) {}
      }
      return res;
    } catch (e) {
      d('handleEventTrigger error', e);
      return { ok: false, error: String(e) };
    }
  }

  // --- Aggressive listeners (window/document/message) ---
  function eventHandlerBridge(ev) {
    try {
      const rid = ev && ev.detail && ev.detail.rid;
      d('AGGRESSIVE HANDLER: got event', ev.type, 'rid=', rid);
      updateOverlayPrompt('(event-received) waiting...');
      handleEventTrigger(rid);
    } catch (e) { d('eventHandlerBridge error', e); }
  }
  window.addEventListener('AEGIS_REQUEST_MANUAL_UPLOAD_FROM_PAGE', eventHandlerBridge, { capture: true });
  document.addEventListener('AEGIS_REQUEST_MANUAL_UPLOAD_FROM_PAGE', eventHandlerBridge, { capture: true });
  window.addEventListener('AEGIS_REQUEST_MANUAL_UPLOAD', eventHandlerBridge, { capture: true });
  document.addEventListener('AEGIS_REQUEST_MANUAL_UPLOAD', eventHandlerBridge, { capture: true });

  window.addEventListener('message', function (e) {
    try {
      const d = e && e.data;
      if (!d) return;
      if (d && d.__AEGIS__ && d.__AEGIS__.action === 'manual-upload') {
        d('postMessage bridge received', d);
        handleEventTrigger(d.__AEGIS__.rid || null);
      }
    } catch (err) { d('postMessage handler error', err); }
  });

  // --- Original watcher & file hooks retained ---
  let last = '';
  (function attachWatcher() {
    createOverlay();
    let paragraph = findParagraph();
    let paragraphObserver = null;
    let rootObserver = null;
    let attempts = 0;

    function start() {
      const root = document.querySelector(ROOT_SELECTOR);
      if (!root && attempts < 40) { attempts++; setTimeout(start, 200); return; }
      if (!root) { d('prompt root not found:', ROOT_SELECTOR); updateOverlayPrompt('Prompt root not found'); return; }

      root.addEventListener('input', () => { paragraph = findParagraph(); onChange('root-input'); }, { passive: true });
      root.addEventListener('keyup', () => { paragraph = findParagraph(); onChange('root-keyup'); }, { passive: true });

      rootObserver = new MutationObserver(() => {
        const newP = findParagraph();
        if (newP !== paragraph) {
          paragraph = newP;
          onChange('root-mutation');
          if (paragraphObserver) { try { paragraphObserver.disconnect(); } catch(e) {} paragraphObserver = null; }
          if (paragraph) {
            paragraphObserver = new MutationObserver(() => onChange('paragraph-mutation'));
            paragraphObserver.observe(paragraph, { characterData: true, childList: true, subtree: true });
          }
        }
      });
      rootObserver.observe(root, { childList: true, subtree: false });

      paragraph = findParagraph();
      if (paragraph) {
        onChange('initial-read');
        paragraphObserver = new MutationObserver(() => onChange('paragraph-mutation'));
        paragraphObserver.observe(paragraph, { characterData: true, childList: true, subtree: true });
      }

      // hook file inputs
      function hookFileInputs() {
        document.querySelectorAll('input[type="file"]').forEach(input => {
          if (input.__aegis_hooked) return;
          input.__aegis_hooked = true;
          input.addEventListener('change', async () => {
            try {
              const arr = Array.from(input.files || []);
              for (const f of arr) {
                const b64 = await fileToBase64(f);
                stagedFiles.push({ name: f.name, type: f.type, size: f.size, data: b64 });
              }
              updateOverlayFiles();
              onChange('file-input-change');
            } catch (e) { d('file change err', e); }
          });
        });
      }
      hookFileInputs();
      setTimeout(hookFileInputs, 700);
      setTimeout(hookFileInputs, 2500);
      setInterval(hookFileInputs, 3500);

      // paste handling
      document.addEventListener('paste', async (ev) => {
        try {
          const items = ev.clipboardData && ev.clipboardData.items;
          if (!items) return;
          for (const it of items) {
            if (it.kind === 'file') {
              const f = it.getAsFile();
              if (f) stagedFiles.push({ name: f.name || 'clipboard', type: f.type, size: f.size, data: await fileToBase64(f) });
            }
          }
          updateOverlayFiles();
          onChange('paste');
        } catch (e) { d('paste err', e); }
      }, { passive: true });

      // drop
      document.addEventListener('drop', async (ev) => {
        try {
          const files = (ev.dataTransfer && Array.from(ev.dataTransfer.files)) || [];
          for (const f of files) stagedFiles.push({ name: f.name, type: f.type, size: f.size, data: await fileToBase64(f) });
          updateOverlayFiles();
          onChange('drop');
        } catch (e) { d('drop err', e); }
      }, { passive: true });

      // manual capture for debugging (keeps old API)
      window.AEGIS_manualCapture = function () {
        const p = findParagraph();
        const t = readParagraphText(p);
        updateOverlayPrompt(t || '(empty)');
        sendToBackground_message(t, stagedFiles, 'manual-capture');
        return { text: t, files: stagedFiles.slice() };
      };
    }

    function onChange(source) {
      paragraph = findParagraph();
      const txt = readParagraphText(paragraph);
      if (txt === last) return;
      last = txt;
      updateOverlayPrompt(txt);
      // send to background (fire-and-forget) for live capture
      try { chrome.runtime.sendMessage && chrome.runtime.sendMessage({ type: 'UPLOAD_CANDIDATE', text: txt, files: stagedFiles || [], source }); } catch (e) { d('onChange send err', e); }
    }

    start();
  })();

  d('AEGIS content script installed (background-preferred uploader)');
})();
