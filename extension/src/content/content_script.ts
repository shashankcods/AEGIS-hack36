// src/content/content_script.ts
// -----------------------------------------------------------
// AEGIS — Content Script (Debounced Edition)
// -----------------------------------------------------------
// - Prevents multiple uploads per keystroke
// - Uses 1 s delay after typing stops (max 10 s force flush)
// - Overlay still updates instantly
// -----------------------------------------------------------

import { debounce } from "@/shared/debounce";  // ✅ new import

type StagedFile = {
  name: string;
  type?: string | null;
  size?: number;
  buffer?: ArrayBuffer | null;
  base64?: string | null;
};

declare global {
  interface Window {
    AEGIS_manualCapture?: () => Promise<any>;
  }
}

const DEBUG_TAG = "[Aegis content_script]";
const ROOT_SELECTOR = "#prompt-textarea";
const OVERLAY_ID = "aegis-overlay-logger";
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024; // 8 MB safe limit

function d(...a: unknown[]) { console.log(DEBUG_TAG, ...a); }

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[m]
  );
}

/* ---------- Overlay ---------- */
function createOverlay(): HTMLElement {
  let o = document.getElementById(OVERLAY_ID) as HTMLElement | null;
  if (o) return o;
  o = document.createElement("div");
  o.id = OVERLAY_ID;
  Object.assign(o.style, {
    position: "fixed", right: "12px", bottom: "12px", zIndex: "2147483647",
    width: "360px", maxHeight: "40vh", overflowY: "auto",
    background: "#071028", color: "#e6eef8", padding: "10px",
    borderRadius: "10px", boxShadow: "0 8px 28px rgba(2,8,20,0.7)",
    fontFamily: "system-ui, Arial, sans-serif", fontSize: "12px",
  } as Partial<CSSStyleDeclaration>);

  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.justifyContent = "space-between";
  head.style.marginBottom = "8px";
  head.innerHTML = `<strong style="font-size:13px">AEGIS — live capture</strong>`;
  const btn = document.createElement("button");
  btn.textContent = "Hide";
  Object.assign(btn.style, { fontSize: "12px", padding: "4px 8px", cursor: "pointer" });
  btn.onclick = () => {
    o!.style.display = o!.style.display === "none" ? "" : "none";
    btn.textContent = o!.style.display === "none" ? "Show" : "Hide";
  };
  head.appendChild(btn);
  o.appendChild(head);

  const promptEl = document.createElement("pre");
  promptEl.id = OVERLAY_ID + "-prompt";
  Object.assign(promptEl.style, {
    whiteSpace: "pre-wrap", margin: "0", padding: "6px",
    background: "#0b1730", borderRadius: "6px",
    maxHeight: "6em", overflow: "auto",
  } as Partial<CSSStyleDeclaration>);
  promptEl.textContent = "Waiting for prompt...";
  o.appendChild(promptEl);

  const filesList = document.createElement("div");
  filesList.id = OVERLAY_ID + "-files";
  filesList.style.marginTop = "8px";
  filesList.textContent = "Attachments: None";
  o.appendChild(filesList);

  document.body.appendChild(o);
  return o;
}

/* ---------- Text helpers ---------- */
function findParagraph(): HTMLElement | null {
  const root = document.querySelector(ROOT_SELECTOR);
  if (!root) return null;
  return (root.querySelector("p") as HTMLElement) || (root as HTMLElement);
}
function readParagraphText(p: Element | null): string {
  if (!p) return "";
  return ((p as HTMLElement).innerText ?? (p as HTMLElement).textContent ?? "").replace(/\u00A0/g, "");
}

/* ---------- Staging ---------- */
const stagedFiles: StagedFile[] = [];

async function fileToArrayBuffer(file: File): Promise<ArrayBuffer> { return await file.arrayBuffer(); }

function updateOverlayPrompt(text: string) {
  const pre = document.getElementById(OVERLAY_ID + "-prompt");
  if (pre) pre.textContent = text || "";
}
function updateOverlayFiles() {
  const el = document.getElementById(OVERLAY_ID + "-files");
  if (!el) return;
  if (!stagedFiles.length) { el.textContent = "Attachments: None"; return; }
  el.innerHTML = "";
  stagedFiles.forEach((f, i) => {
    const row = document.createElement("div");
    row.style.marginBottom = "6px";
    row.innerHTML = `<div style="font-weight:700">${i + 1}. ${escapeHtml(f.name)}</div>
      <div style="font-size:11px;color:#9fb0d6">${f.type || "unknown"} — ${Math.round((f.size || 0) / 1024)} KB</div>`;
    el.appendChild(row);
  });
}

function consoleProof(source: string, text: string | undefined, files?: StagedFile[]) {
  const excerpt = (text || "").slice(0, 300);
  console.groupCollapsed("%cAEGIS capture — " + source, "background:#071028;color:#cfe8ff;padding:4px;border-radius:4px");
  console.log("excerpt:", excerpt);
  if (files && files.length) console.log("files:", files.map(f => ({ name: f.name, size: f.size, type: f.type })));
  console.groupEnd();
}

/* ---------- ArrayBuffer -> base64 ---------- */
function arrayBufferToBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

/* ---------- Send to background ---------- */
function sendToBackground(text: string, files?: StagedFile[], source?: string): Promise<any> {
  consoleProof(source || "unknown", text, files);

  return new Promise((resolve, reject) => {
    try {
      const payload = {
        text: text || "",
        files: (files || []).map(f => {
          if (f.buffer instanceof ArrayBuffer) {
            let base64 = null;
            try { base64 = arrayBufferToBase64(f.buffer); } catch (e) { d("base64 conversion failed", e); }
            return { name: f.name, type: f.type, size: f.size, base64 };
          }
          return { name: f.name, type: f.type, size: f.size };
        }),
      };

      chrome.runtime.sendMessage({ type: "UPLOAD_CANDIDATE", payload, source }, (resp) => {
        const last = chrome.runtime.lastError;
        if (last) return reject(new Error("runtime.sendMessage: " + last.message));
        if (!resp) return reject(new Error("no response from background"));
        if (resp.ok) return resolve(resp);
        reject(new Error(resp.error || "upload failed"));
      });
    } catch (e) {
      d("sendToBackground exception", e);
      reject(e);
    }
  });
}

/* ---------- Debounced wrapper ---------- */
const debouncedSend = debounce(
  (txt: string, src: string) => {
    console.log("%c[AEGIS debounce] flush → backend", "color:#8ef");
    sendToBackground(txt, stagedFiles.slice(), src).catch(e => d("bg send err", e));
  },
  1000,             // 1 s delay
  { maxWait: 10000 } // 10 s forced send
);

/* ---------- Watcher ---------- */
let last = "";

(function attachWatcher() {
  createOverlay();
  let paragraph = findParagraph();
  let paragraphObserver: MutationObserver | null = null;
  let rootObserver: MutationObserver | null = null;
  let attempts = 0;

  function start() {
    const root = document.querySelector(ROOT_SELECTOR);
    if (!root && attempts < 40) { attempts++; setTimeout(start, 200); return; }
    if (!root) { d("prompt root not found:", ROOT_SELECTOR); updateOverlayPrompt("Prompt root not found"); return; }

    // keystroke events
    root.addEventListener("input", () => { paragraph = findParagraph(); onChange("root-input"); }, { passive: true });
    root.addEventListener("keyup", () => { paragraph = findParagraph(); onChange("root-keyup"); }, { passive: true });

    // observe DOM
    rootObserver = new MutationObserver(() => {
      const newP = findParagraph();
      if (newP !== paragraph) {
        paragraph = newP;
        onChange("root-mutation");
        if (paragraphObserver) { try { paragraphObserver.disconnect(); } catch {} paragraphObserver = null; }
        if (paragraph) {
          paragraphObserver = new MutationObserver(() => onChange("paragraph-mutation"));
          paragraphObserver.observe(paragraph, { characterData: true, childList: true, subtree: true });
        }
      }
    });
    rootObserver.observe(root, { childList: true, subtree: false });

    paragraph = findParagraph();
    if (paragraph) {
      onChange("initial-read");
      paragraphObserver = new MutationObserver(() => onChange("paragraph-mutation"));
      paragraphObserver.observe(paragraph, { characterData: true, childList: true, subtree: true });
    }

    /* ---------- File hooks (unchanged) ---------- */
    function hookFileInputs() {
      document.querySelectorAll<HTMLInputElement>("input[type='file']").forEach(input => {
        const anyInput = input as any;
        if (anyInput.__aegis_hooked) return;
        anyInput.__aegis_hooked = true;
        input.addEventListener("change", async () => {
          try {
            for (const f of Array.from(input.files || [])) {
              const buffer = await fileToArrayBuffer(f);
              stagedFiles.push({ name: f.name, type: f.type, size: f.size, buffer });
            }
            updateOverlayFiles();
            onChange("file-input-change"); // file change sends immediately
          } catch (e) { d("file change err", e); }
        });
      });
    }
    hookFileInputs();
    setTimeout(hookFileInputs, 700);
    setTimeout(hookFileInputs, 2500);
    setInterval(hookFileInputs, 3500);

    document.addEventListener("paste", async (ev: ClipboardEvent) => {
      try {
        const items = ev.clipboardData && ev.clipboardData.items;
        if (!items) return;
        for (const it of Array.from(items)) {
          if ((it as DataTransferItem).kind === "file") {
            const f = (it as DataTransferItem).getAsFile();
            if (f) {
              const buffer = await fileToArrayBuffer(f);
              stagedFiles.push({ name: f.name || "clipboard", type: f.type, size: f.size, buffer });
            }
          }
        }
        updateOverlayFiles();
        onChange("paste"); // paste triggers onChange normally
      } catch (e) { d("paste err", e); }
    }, { passive: true });

    document.addEventListener("drop", async (ev: DragEvent) => {
      try {
        const files = (ev.dataTransfer && Array.from(ev.dataTransfer.files)) || [];
        for (const f of files) {
          const buffer = await fileToArrayBuffer(f);
          stagedFiles.push({ name: f.name, type: f.type, size: f.size, buffer });
        }
        updateOverlayFiles();
        onChange("drop");
      } catch (e) { d("drop err", e); }
    }, { passive: true });

    window.AEGIS_manualCapture = function () {
      const p = findParagraph();
      const t = readParagraphText(p);
      updateOverlayPrompt(t || "(empty)");

      const totalBytes = stagedFiles.reduce((s, f) => s + (f.size || (f.buffer ? f.buffer.byteLength : 0)), 0);
      if (totalBytes > MAX_TRANSFER_BYTES) {
        d("Total staged files exceed transfer limit", totalBytes);
        return sendToBackground(
          t,
          stagedFiles.map(f => ({ name: f.name, type: f.type, size: f.size, buffer: null })),
          "manual-capture"
        ).catch(err => ({ error: String(err), note: "files too large to transfer" }));
      }

      return sendToBackground(t, stagedFiles.slice(), "manual-capture")
        .then(r => r)
        .catch(e => ({ error: String(e) }));
    };
  }

  async function onChange(source: string) {
    const paragraph = findParagraph();
    const txt = readParagraphText(paragraph);
    if (txt === last) return;
    last = txt;

    updateOverlayPrompt(txt); // overlay updates instantly

    const totalBytes = stagedFiles.reduce((s, f) => s + (f.size || (f.buffer ? f.buffer.byteLength : 0)), 0);
    if (totalBytes > MAX_TRANSFER_BYTES) {
      d("skip sending capture: staged files too large", totalBytes);
      const metaOnly = stagedFiles.map(f => ({ name: f.name, type: f.type, size: f.size, buffer: null }));
      sendToBackground(txt, metaOnly, source).catch(e => d("bg send err", e));
      return;
    }

    // ✅ Debounced send
    debouncedSend(txt, source);
  }

  start();
})();

d("AEGIS content script installed (debounced)");

export {};
