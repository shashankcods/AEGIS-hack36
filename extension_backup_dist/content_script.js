// public/content_script.js
(function () {
  const DEBUG_TAG = '[Aegis content_script]';
  const ROOT_SELECTOR = '#prompt-textarea';
  const OVERLAY_ID = 'aegis-overlay-logger';
  const MAX_TRANSFER_BYTES = 8 * 1024 * 1024; // 8 MB safe limit

  function d(...a) { console.log(DEBUG_TAG, ...a); }

  // ===== Overlay UI =====
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
    btn.onclick = () => {
      o.style.display = (o.style.display === 'none') ? '' : 'none';
      btn.textContent = (o.style.display === 'none') ? 'Show' : 'Hide';
    };
    head.appendChild(btn);
    o.appendChild(head);

    const promptEl = document.createElement('pre');
    promptEl.id = OVERLAY_ID + '-prompt';
    Object.assign(promptEl.style, {
      whiteSpace: 'pre-wrap', margin: 0, padding: '6px',
      background: '#0b1730', borderRadius: '6px',
      maxHeight: '6em', overflow: 'auto'
    });
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  // ===== Text helpers =====
  function findParagraph() {
    const root = document.querySelector(ROOT_SELECTOR);
    if (!root) return null;
    return root.querySelector('p') || root;
  }
  function readParagraphText(p) {
    if (!p) return '';
    return (p.innerText ?? p.textContent ?? '').replace(/\u00A0/g, '');
  }

  // ===== State =====
  const stagedFiles = [];

  async function fileToArrayBuffer(file) {
    return await file.arrayBuffer();
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
      row.innerHTML = `<div style="font-weight:700">${i + 1}. ${escapeHtml(f.name)}</div>
                       <div style="font-size:11px;color:#9fb0d6">${f.type || 'unknown'} — ${Math.round((f.size || 0) / 1024)} KB</div>`;
      el.appendChild(row);
    });
  }

  function consoleProof(source, text, files) {
    const excerpt = (text || '').slice(0, 300);
    console.groupCollapsed('%cAEGIS capture — ' + source,
      'background:#071028;color:#cfe8ff;padding:4px;border-radius:4px');
    console.log('excerpt:', excerpt);
    if (files && files.length)
      console.log('files:', files.map(f => ({ name: f.name, size: f.size, type: f.type })));
    console.groupEnd();
  }

  // ===== Message sender =====
  function sendToBackground(text, files, source) {
    consoleProof(source, text, files);
    return new Promise((resolve, reject) => {
      try {
        const payload = {
          text: text || '',
          // serialize ArrayBuffers → number arrays
          files: (files || []).map(f => ({
            name: f.name,
            type: f.type,
            size: f.size,
            buffer: f.buffer ? Array.from(new Uint8Array(f.buffer)) : null
          }))
        };

        chrome.runtime.sendMessage({ type: 'UPLOAD_CANDIDATE', payload, source }, (resp) => {
          const last = chrome.runtime.lastError;
          if (last) return reject(new Error('runtime.sendMessage: ' + last.message));
          if (!resp) return reject(new Error('no response from background'));
          if (resp.ok) return resolve(resp);
          reject(new Error(resp.error || 'upload failed'));
        });
      } catch (e) { reject(e); }
    });
  }

  // ===== Inject fetch interceptor (detect ChatGPT hidden uploads) =====
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('intercept_inject.js');
    (document.head || document.documentElement).appendChild(s);
    d('Injected fetch interceptor script');
  } catch (e) { d('injector error', e); }

  // Listen for intercept messages from injected script
  window.addEventListener('message', (e) => {
    if (e.data && e.data.aegisIntercept && e.data.fileMeta) {
      const meta = e.data.fileMeta;
      d('Intercepted ChatGPT upload via fetch:', meta);
      stagedFiles.push({
        name: meta.name,
        type: meta.type,
        size: meta.size,
        buffer: null // cannot access real blob; just metadata
      });
      updateOverlayFiles();
      sendToBackground('', stagedFiles.slice(), 'fetch-intercept')
        .catch(err => d('bg send err', err));
    }
  });

  // ===== Watcher for text, paste, drop =====
  let last = '';
  (function attachWatcher() {
    createOverlay();
    let paragraph = findParagraph();
    let paragraphObserver = null;

    async function onChange(source) {
      paragraph = findParagraph();
      const txt = readParagraphText(paragraph);
      if (txt === last) return;
      last = txt;
      updateOverlayPrompt(txt);

      const totalBytes = stagedFiles.reduce((s, f) => s + (f.size || 0), 0);
      if (totalBytes > MAX_TRANSFER_BYTES) {
        const meta = stagedFiles.map(f => ({ name: f.name, type: f.type, size: f.size }));
        sendToBackground(txt, meta, source).catch(e => d('bg send err', e));
        return;
      }
      sendToBackground(txt, stagedFiles.slice(), source).catch(e => d('bg send err', e));
    }

    // observe file inputs (normal sites)
    const obs = new MutationObserver(() => {
      document.querySelectorAll('input[type=file]').forEach(input => {
        if (input.__aegis_hooked) return;
        input.__aegis_hooked = true;
        input.addEventListener('change', async () => {
          try {
            for (const f of Array.from(input.files || [])) {
              const buffer = await fileToArrayBuffer(f);
              stagedFiles.push({ name: f.name, type: f.type, size: f.size, buffer });
            }
            updateOverlayFiles();
            onChange('file-input-change');
          } catch (e) { d('file change err', e); }
        });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // paste handler
    document.addEventListener('paste', async (ev) => {
      try {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (const it of items) {
          if (it.kind === 'file') {
            const f = it.getAsFile();
            if (f) {
              const buffer = await fileToArrayBuffer(f);
              stagedFiles.push({ name: f.name || 'clipboard', type: f.type, size: f.size, buffer });
            }
          }
        }
        updateOverlayFiles();
        onChange('paste');
      } catch (e) { d('paste err', e); }
    }, { passive: true });

    // drop handler
    document.addEventListener('drop', async (ev) => {
      try {
        const files = (ev.dataTransfer && Array.from(ev.dataTransfer.files)) || [];
        for (const f of files) {
          const buffer = await fileToArrayBuffer(f);
          stagedFiles.push({ name: f.name, type: f.type, size: f.size, buffer });
        }
        updateOverlayFiles();
        onChange('drop');
      } catch (e) { d('drop err', e); }
    }, { passive: true });

    // text observers
    const root = document.querySelector(ROOT_SELECTOR);
    if (root) {
      root.addEventListener('input', () => onChange('input'), { passive: true });
      paragraph = findParagraph();
      if (paragraph) {
        paragraphObserver = new MutationObserver(() => onChange('paragraph'));
        paragraphObserver.observe(paragraph, { childList: true, subtree: true, characterData: true });
      }
    }
  })();

  d('AEGIS content script installed');
})();
