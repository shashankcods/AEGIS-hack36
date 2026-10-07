import { readableLabel, scorePercent } from '@/shared/presentation';

type Detection = { label: string; confidence?: number; sensitivity_score?: number };
type AnalysisResult = { status?: string; detections: Detection[]; warnings?: string[]; analysis_complete?: boolean };
type Snapshot = { revision: number; text: string; files: File[]; requestId: string };
type UploadReply = { ok?: boolean; superseded?: boolean; result?: AnalysisResult; error?: string };

declare global {
  interface Window {
    AEGIS_manualCapture?: () => Promise<UploadReply>;
    AEGIS_getLastResult?: () => AnalysisResult | null;
  }
}

const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const sessionId = crypto.randomUUID();
const files: File[] = [];
const inputFiles = new WeakMap<HTMLInputElement, File[]>();
const hookedInputs = new WeakSet<HTMLInputElement>();
let composer: HTMLElement | null = null;
let composerObserver: MutationObserver | null = null;
let revision = 0;
let lastText = '';
let lastFiles = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending: Snapshot | null = null;
let currentRequestId = '';
let lastAppliedRequestId = '';
let lastAnalyzeResult: AnalysisResult | null = null;
let lastPath = location.pathname;
let fileWarning = '';
let pendingSubmission = false;

const panel = document.createElement('section');
panel.id = 'aegis-privacy-status';
panel.setAttribute('aria-label', 'AEGIS privacy check');
Object.assign(panel.style, {
  position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
  width: '300px', maxHeight: '45vh', overflowY: 'auto', background: '#0f172a',
  color: '#e2e8f0', border: '1px solid #475569', borderRadius: '12px', padding: '14px',
  boxShadow: '0 8px 24px #0005', font: '13px/1.5 system-ui, sans-serif',
});
const heading = document.createElement('strong');
heading.textContent = 'AEGIS privacy check';
panel.appendChild(heading);
const status = document.createElement('div');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
status.style.margin = '8px 0';
panel.appendChild(status);
const fileList = document.createElement('div');
panel.appendChild(fileList);
const controls = document.createElement('div');
controls.style.cssText = 'display:flex;gap:8px;margin-top:8px';
const checkButton = document.createElement('button');
checkButton.textContent = 'Check now';
const hideButton = document.createElement('button');
hideButton.textContent = 'Hide';
for (const button of [checkButton, hideButton]) {
  button.style.cssText = 'border:1px solid #64748b;border-radius:6px;padding:4px 9px;background:#1e293b;color:#e2e8f0;cursor:pointer';
  controls.appendChild(button);
}
hideButton.onclick = () => { panel.hidden = true; };
panel.appendChild(controls);
document.body.appendChild(panel);

function setStatus(message: string, tone: 'normal' | 'warning' | 'error' = 'normal') {
  status.textContent = message;
  status.style.whiteSpace = 'pre-line';
  status.style.color = tone === 'error' ? '#fca5a5' : tone === 'warning' ? '#fde68a' : '#cbd5e1';
  if (tone !== 'normal') panel.hidden = false;
}

function readText() {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value;
  return (composer?.innerText ?? composer?.textContent ?? '').replace(/\u00a0/g, ' ');
}

function findComposer() {
  const selectors = location.hostname === 'gemini.google.com'
    ? 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea'
    : '#prompt-textarea, textarea[data-id="root"], textarea[placeholder*="Message"], [contenteditable="true"][role="textbox"]';
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors));
  return candidates.find(element => element.getClientRects().length > 0) || candidates[0] || null;
}

function fileKey(file: File) { return `${file.name}:${file.size}:${file.lastModified}:${file.type}`; }

function renderFiles() {
  fileList.replaceChildren();
  files.forEach(file => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:5px';
    const name = document.createElement('span');
    name.textContent = file.name;
    name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const remove = document.createElement('button');
    remove.textContent = 'Clear from AEGIS';
    remove.setAttribute('aria-label', `Stop checking ${file.name}`);
    remove.onclick = () => {
      files.splice(files.indexOf(file), 1);
      renderFiles();
      onChange(true);
    };
    row.append(name, remove);
    fileList.appendChild(row);
  });
}

function stageFiles(incoming: File[]) {
  fileWarning = '';
  for (const file of incoming) {
    if (files.some(existing => fileKey(existing) === fileKey(file))) continue;
    if (files.reduce((total, item) => total + item.size, 0) + file.size > MAX_TRANSFER_BYTES) {
      fileWarning = 'Some attachments exceed the 8 MB transfer limit and have not been checked. Use smaller files.';
      continue;
    }
    files.push(file);
  }
  renderFiles();
  onChange(true);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function sendSnapshot(snapshot: Snapshot): Promise<UploadReply> {
  const encodedFiles = await Promise.all(snapshot.files.map(async file => ({
    name: file.name, type: file.type, size: file.size,
    base64: arrayBufferToBase64(await file.arrayBuffer()),
  })));
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({
        type: 'UPLOAD_CANDIDATE', requestId: snapshot.requestId,
        payload: { text: snapshot.text, files: encodedFiles },
      }, (response: UploadReply | undefined) => {
        if (chrome.runtime.lastError) return reject(new Error('The extension connection was interrupted. Reload this page and try again.'));
        if (!response) return reject(new Error('The extension did not receive a backend response.'));
        resolve(response);
      });
    } catch { reject(new Error('The extension was reloaded. Reload this page to reconnect AEGIS.')); }
  });
}

function applyReply(reply: UploadReply, requestId: string) {
  if (reply.superseded || requestId !== currentRequestId || requestId === lastAppliedRequestId) return;
  lastAppliedRequestId = requestId;
  if (reply.error || !reply.result) {
    lastAnalyzeResult = null;
    setStatus(`${reply.error || 'The privacy check failed.'}\nThis content has not been fully checked.`, 'error');
    return;
  }
  lastAnalyzeResult = reply.result;
  const detections = reply.result.detections || [];
  const warnings = [...(reply.result.warnings || []), ...(fileWarning ? [fileWarning] : [])];
  if (reply.result.analysis_complete === false && !warnings.length) {
    warnings.push('Some models or attachments could not be checked.');
  }
  const categories = [...new Map(detections.map(item => [item.label, item])).values()];
  const lines = categories.map(item => {
    const sensitivity = scorePercent(item.sensitivity_score);
    return `• ${readableLabel(item.label)}${sensitivity === null ? '' : ` — sensitivity ${sensitivity}%`}`;
  });
  const message = detections.length
    ? `Review before sharing:\n${lines.join('\n')}`
    : 'No sensitive categories detected in this check.';
  setStatus(`${message}${warnings.length ? `\n\nPartial check / service warning:\n${warnings.join('\n')}` : ''}`,
    warnings.length || detections.length ? 'warning' : 'normal');
}

async function analyze(snapshot: Snapshot): Promise<UploadReply> {
  if (running) { pending = snapshot; return { ok: true }; }
  running = true;
  currentRequestId = snapshot.requestId;
  setStatus(fileWarning ? `Checking…\n${fileWarning}` : 'Checking with the local models…', fileWarning ? 'warning' : 'normal');
  try {
    const reply = await sendSnapshot(snapshot);
    if (snapshot.revision === revision) applyReply(reply, snapshot.requestId);
    return reply;
  } catch (error) {
    const reply = { ok: false, error: error instanceof Error ? error.message : 'The privacy check failed.' };
    if (snapshot.revision === revision) applyReply(reply, snapshot.requestId);
    return reply;
  } finally {
    running = false;
    if (pending) {
      const next = pending;
      pending = null;
      if (next.revision === revision) void analyze(next);
    }
  }
}

function snapshot(): Snapshot {
  return { revision, text: readText(), files: files.slice(), requestId: `${sessionId}:${revision}` };
}

function onChange(force = false) {
  const text = readText();
  if (pendingSubmission && !text.trim()) {
    pendingSubmission = false;
    files.length = 0;
    fileWarning = '';
    renderFiles();
  }
  const signature = files.map(fileKey).join('|');
  if (!force && text === lastText && signature === lastFiles) return;
  lastText = text;
  lastFiles = signature;
  revision += 1;
  currentRequestId = `${sessionId}:${revision}`;
  lastAnalyzeResult = null;
  if (timer) clearTimeout(timer);
  pending = null;
  if (!text.trim() && !files.length) {
    setStatus(fileWarning || 'Enter a prompt or attach an image or PDF to check.', fileWarning ? 'warning' : 'normal');
    return;
  }
  setStatus(fileWarning || 'Waiting for typing to pause…', fileWarning ? 'warning' : 'normal');
  timer = setTimeout(() => { timer = null; void analyze(snapshot()); }, 1800);
}

function attachComposer() {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    files.length = 0;
    fileWarning = '';
    renderFiles();
    onChange(true);
  }
  const found = findComposer();
  if (found !== composer) {
    composerObserver?.disconnect();
    composer?.removeEventListener('input', handleInput);
    composer = found;
    if (composer) {
      composer.addEventListener('input', handleInput);
      composerObserver = new MutationObserver(() => onChange());
      composerObserver.observe(composer, { characterData: true, childList: true, subtree: true });
      onChange(true);
    } else {
      onChange(true);
      setStatus('Waiting for the ChatGPT or Gemini prompt box.');
    }
  }
  document.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach(input => {
    if (hookedInputs.has(input)) return;
    hookedInputs.add(input);
    input.addEventListener('change', () => {
      for (const previous of inputFiles.get(input) || []) {
        const index = files.indexOf(previous);
        if (index !== -1) files.splice(index, 1);
      }
      const incoming = Array.from(input.files || []);
      inputFiles.set(input, incoming);
      stageFiles(incoming);
    });
  });
}

function handleInput() { onChange(); }

window.AEGIS_manualCapture = async () => {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!readText().trim() && !files.length) {
    onChange(true);
    return { ok: false, error: 'Enter text or attach a supported image or PDF first.' };
  }
  revision += 1;
  currentRequestId = `${sessionId}:${revision}`;
  return analyze(snapshot());
};
window.AEGIS_getLastResult = () => lastAnalyzeResult;
checkButton.onclick = () => { void window.AEGIS_manualCapture?.(); };

document.addEventListener('paste', event => {
  if (!composer?.contains(event.target as Node)) return;
  const incoming = Array.from(event.clipboardData?.files || []);
  if (incoming.length) stageFiles(incoming);
}, { passive: true });
document.addEventListener('drop', event => {
  if (panel.contains(event.target as Node)) return;
  const incoming = Array.from(event.dataTransfer?.files || []);
  if (incoming.length) stageFiles(incoming);
}, { passive: true });

// Submitted attachments must not leak into the next prompt's analysis.
function clearAfterSend() {
  pendingSubmission = true;
  setTimeout(() => {
    if (readText().trim()) return;
    files.length = 0;
    fileWarning = '';
    renderFiles();
    onChange(true);
  }, 200);
  setTimeout(() => { pendingSubmission = false; }, 2000);
}
document.addEventListener('click', event => {
  const target = event.target as Element;
  if (target.closest?.('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], .send-button')) clearAfterSend();
}, { passive: true });
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && composer?.contains(event.target as Node)) clearAfterSend();
}, { passive: true });

let attachScheduled = false;
const pageObserver = new MutationObserver(() => {
  if (attachScheduled) return;
  attachScheduled = true;
  requestAnimationFrame(() => { attachScheduled = false; attachComposer(); });
});
pageObserver.observe(document.body, { childList: true, subtree: true });
setStatus('Waiting for the ChatGPT or Gemini prompt box.');
attachComposer();

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'UPLOAD_RESULT' && message.requestId) {
    applyReply({ result: message.result, error: message.error }, message.requestId);
  }
});
