// src/content/content_script.ts
// CRXJS-friendly conversion of your previous public/content_script.js
// - Typed, module-scoped
// - Sends base64 file payloads to background
// - Exposes window.AEGIS_manualCapture()
// Paste/replace the file at: extension/src/content/content_script.ts

type StagedFile = {
  name: string;
  type?: string | null;
  size?: number;
  buffer?: ArrayBuffer | null;
};

declare global {
  interface Window {
    AEGIS_manualCapture?: () => Promise<any>;
  }
}

const DEBUG_TAG = '[Aegis content_script]';
const ROOT_SELECTOR = '#prompt-textarea';
const OVERLAY_ID = 'aegis-overlay-logger';
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024; // 8 MB total safe transfer (tweak as needed)

function d(...a: unknown[]) { console.log(DEBUG_TAG, ...a); }

// overlay creation (idempotent)
function createOverlay(): HTMLElement {
  let o = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (o) return o;
  o = document.createElement('div');
  o.id = OVERLAY_ID;
  Object.assign(o.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    width: '360px', maxHeight: '40vh', overflowY: 'auto',
    background: '#071028', color: '#e6eef8', padding: '10px',
    borderRadius: '10px', boxShadow: '0 8px 28px rgba(2,8,20,0.7)',
    fontFamily: 'system-ui, Arial, sans-serif', fontSize: '12px'
  } as unknown as Partial<CSSStyleDeclaration>);
  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.justifyContent = 'space-between';
  head.style.marginBottom = '8px';
  head.innerHTML = `<strong style="font-size:13px">AEGIS — live capture</strong>`;
  const btn = document.createElement('button');
  btn.textContent = 'Hide';
  Object.assign(btn.style, { fontSize: '12px', padding: '4px 8px', cursor: 'pointer' } as unknown as Partial<CSSStyleDeclaration>);
  btn.onclick = () => { o!.style.display = (o!.style.display === 'none') ? '' : 'none'; btn.textContent = (o!.style.display === 'none') ? 'Show' : 'Hide'; };
  head.appendChild(btn);
  o.appendChild(head);

  const promptEl = document.createElement('pre');
  promptEl.id = OVERLAY_ID + '-prompt';
  Object.assign(promptEl.style, { whiteSpace: 'pre-wrap', margin: '0', padding: '6px', background: '#0b1730', borderRadius: '6px', maxHeight: '6em', overflow: 'auto' } as unknown as Partial<CSSStyleDeclaration>);
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

function findParagraph(): HTMLElement | null {
  const root = document.querySelector(ROOT_SELECTOR);
  if (!root) return null;
  return (root.querySelector('p') as HTMLElement) || (root as HTMLElement);
}
function readParagraphText(p: Element | null): string {
  if (!p) return '';
  const text = (p as HTMLElement).innerText ?? (p as HTMLElement).textContent ?? '';
  return text.replace(/\u00A0/g, '');
}

// staged files: { name, type, size, buffer: ArrayBuffer }
const stagedFiles: StagedFile[] = [];

async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return await file.arrayBuffer();
}

function updateOverlayPrompt(text: string) {
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
function escapeHtml(s: string) { return String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m] as string); }

function consoleProof(source: string, text: string | undefined, files?: StagedFile[]) {
  const excerpt = (text || '').slice(0, 300);
  console.groupCollapsed('%cAEGIS capture — ' + source, 'background:#071028;color:#cfe8ff;padding:4px;border-radius:4px');
  console.log('excerpt:', excerpt);
  if (files && files.length) console.log('files:', files.map(f => ({ name: f.name, size: f.size, type: f.type })));
  console.log('full text:', text);
  console.groupEnd();
}

// Sends capture to background and returns a Promise resolving with background response
function sendToBackground(text: string, files?: StagedFile[], source?: string): Promise<any> {
  consoleProof(source || 'unknown', text, files);

  return new Promise((resolve, reject) => {
    try {
      // Prepare a light payload: convert buffers to base64 to avoid structured-clone limits
      const payload = {
        text: text || '',
        files: (files || []).map(f => {
          if (f.buffer instanceof ArrayBuffer) {
            const bytes = new Uint8Array(f.buffer);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              const sub = bytes.subarray(i, i + chunk);
              binary += String.fromCharCode(...sub);
            }
            const base64 = btoa(binary);
            return { name: f.name, type: f.type, size: f.size, base64 };
          }
          return { name: f.name, type: f.type, size: f.size };
        })
      };

      chrome.runtime.sendMessage({ type: 'UPLOAD_CANDIDATE', payload, source }, (resp) => {
        const last = chrome.runtime.lastError;
        if (last) {
          d('chrome.runtime.lastError', last);
          return reject(new Error('runtime.sendMessage lastError: ' + last.message));
        }
        if (!resp) return reject(new Error('no response from background'));
        if (resp.ok) return resolve(resp);
        return reject(new Error(resp.error || 'upload failed'));
      });
    } catch (e) {
      d('sendToBackground exception', e);
      reject(e);
    }
  });
}

let last = '';

(function attachWatcher() {
  createOverlay();
  let paragraph = findParagraph();
  let paragraphObserver: MutationObserver | null = null;
  let rootObserver: MutationObserver | null = null;
  let attempts = 0;

  function start() {
    const root = document.querySelector(ROOT_SELECTOR);
    if (!root && attempts < 40) { attempts++; setTimeout(start, 200); return; }
    if (!root) { d('prompt root not found:', ROOT_SELECTOR); updateOverlayPrompt('Prompt root not found'); return; }

    // root level events
    root.addEventListener('input', () => { paragraph = findParagraph(); onChange('root-input'); }, { passive: true });
    root.addEventListener('keyup', () => { paragraph = findParagraph(); onChange('root-keyup'); }, { passive: true });

    // observe structural changes to the prompt root
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
      document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach(input => {
        const anyInput = input as any;
        if (anyInput.__aegis_hooked) return;
        anyInput.__aegis_hooked = true;
        input.addEventListener('change', async () => {
          try {
            const arr = Array.from(input.files || []);
            for (const f of arr) {
              const buffer = await fileToArrayBuffer(f);
              stagedFiles.push({ name: f.name, type: f.type, size: f.size, buffer });
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
    document.addEventListener('paste', async (ev: ClipboardEvent) => {
      try {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (const it of Array.from(items)) {
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

    // drop
    document.addEventListener('drop', async (ev: DragEvent) => {
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

    // manual capture for debugging (returns an object)
    window.AEGIS_manualCapture = function () {
      const p = findParagraph();
      const t = readParagraphText(p);
      updateOverlayPrompt(t || '(empty)');

      // Quick size check before sending
      const totalBytes = stagedFiles.reduce((s, f) => s + (f.size || (f.buffer ? f.buffer.byteLength : 0)), 0);
      if (totalBytes > MAX_TRANSFER_BYTES) {
        d('Total staged files exceed transfer limit', totalBytes);
        // send metadata only so background can decide what to do next
        const minimal = stagedFiles.map(f => ({ name: f.name, type: f.type, size: f.size }));
        void minimal; // referenced to avoid TS unused warning
        // still call sendToBackground with empty buffers to record capture in logs
        return sendToBackground(t, stagedFiles.map(f => ({ ...f, buffer: null })), 'manual-capture')
          .catch(err => ({ error: String(err), note: 'files too large to transfer; consider chunked upload or staging' }));
      }

      return sendToBackground(t, stagedFiles.slice(), 'manual-capture')
        .then(r => r)
        .catch(e => ({ error: String(e) }));
    };
  }

  async function onChange(source: string) {
    paragraph = findParagraph();
    const txt = readParagraphText(paragraph);
    if (txt === last) return;
    last = txt;
    updateOverlayPrompt(txt);

    // Quick total size check - avoid blasting too-large ArrayBuffers through the message channel
    const totalBytes = stagedFiles.reduce((s, f) => s + (f.size || (f.buffer ? f.buffer.byteLength : 0)), 0);
    if (totalBytes > MAX_TRANSFER_BYTES) {
      d('skip sending capture: staged files too large', totalBytes);
      // still send metadata to background so logs show capture, but don't send buffers
      const metaOnly = stagedFiles.map(f => ({ name: f.name, type: f.type, size: f.size, buffer: null }));
      sendToBackground(txt, metaOnly, source).catch(e => d('bg send err', e));
      return;
    }

    sendToBackground(txt, stagedFiles.slice(), source).catch(e => d('bg send err', e));
  }

  // start watcher
  start();
})();

d('AEGIS content script installed');

export {}; // ensure module scope
