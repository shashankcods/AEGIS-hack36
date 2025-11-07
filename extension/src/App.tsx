// App.tsx
import React, { useEffect, useState } from "react";

type Capture = {
  id: string;
  kind?: string;
  source?: string;
  text?: string;
  payload?: any;
  meta?: any;
  arrayBuffer?: ArrayBuffer;
  ts?: number;
  note?: string;
};

const CAPTURE_KEY = "aegis_captures";
const CONSENT_KEY = "aegis_consent";

function sendBg(msg: any): Promise<any> {
  return new Promise((res) => {
    chrome.runtime.sendMessage(msg, (resp) => res(resp));
  });
}

export default function App() {
  const [consent, setConsent] = useState<boolean>(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // load consent from storage
    chrome.storage.local.get(CONSENT_KEY, (data) => {
      setConsent(!!data[CONSENT_KEY]);
    });
    refreshCaptures();
  }, []);

  useEffect(() => {
    // when consent changes, set storage and set window flag in ChatGPT tabs
    chrome.storage.local.set({ [CONSENT_KEY]: consent });
    if (consent) {
      // set window.__AEGIS_CONSENT in chat.openai.com tabs
      chrome.tabs.query({ url: "https://chat.openai.com/*" }, (tabs) => {
        for (const t of tabs || []) {
          try {
            chrome.scripting.executeScript({
              target: { tabId: t.id! },
              func: () => { (window as any).__AEGIS_CONSENT = true; }
            });
          } catch (e) {}
        }
      });
    } else {
      // clear flag in those tabs
      chrome.tabs.query({ url: "https://chat.openai.com/*" }, (tabs) => {
        for (const t of tabs || []) {
          try {
            chrome.scripting.executeScript({
              target: { tabId: t.id! },
              func: () => { try { delete (window as any).__AEGIS_CONSENT; } catch(e){} }
            });
          } catch (e) {}
        }
      });
    }
  }, [consent]);

  async function refreshCaptures() {
    setLoading(true);
    const resp = await sendBg({ cmd: "GET_CAPTURES" });
    setCaptures(resp && resp.captures ? resp.captures : []);
    setLoading(false);
  }

  async function clearCaptures() {
    await sendBg({ cmd: "CLEAR_CAPTURES" });
    refreshCaptures();
  }

  async function uploadCapture(id: string) {
    const c = captures.find((x) => x.id === id);
    if (!c) return alert("Capture not found");
    const confirmed = consent || confirm("Uploads require consent. Enable consent?");
    if (!confirmed) return;
    const resp = await sendBg({ cmd: "UPLOAD_CAPTURE", captureId: id });
    if (!resp) return alert("Upload failed (no response)");
    if (resp.ok) {
      alert("Upload sent — server status: " + resp.status);
    } else {
      alert("Upload error: " + (resp.error || "unknown"));
    }
  }

  return (
    <div style={{ width: 360, padding: 12, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h3 style={{ margin: "0 0 10px 0" }}>Aegis</h3>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span style={{ fontSize: 13 }}>Allow uploads to backend (consent)</span>
      </label>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={refreshCaptures} disabled={loading}>Refresh</button>
        <button onClick={clearCaptures}>Clear</button>
      </div>

      <div style={{ maxHeight: 400, overflow: "auto" }}>
        {loading && <div style={{ color: "#666" }}>Loading…</div>}
        {!loading && captures.length === 0 && <div style={{ color: "#666" }}>No captures yet.</div>}
        {captures.map((cap) => (
          <div key={cap.id} style={{ border: "1px solid #ddd", padding: 8, borderRadius: 6, marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#666" }}>
              {cap.kind || "unknown"} · {cap.source || ""} · {cap.ts ? new Date(cap.ts).toLocaleString() : ""}
            </div>

            {cap.kind === "text" && <textarea readOnly value={cap.text || ""} style={{ width: "100%", height: 80 }} />}

            {cap.kind === "outgoing" && <textarea readOnly value={JSON.stringify(cap.payload || cap, null, 2)} style={{ width: "100%", height: 80 }} />}

            {cap.kind === "file" && (
              <div>
                <div style={{ marginTop: 8 }}>{(cap.meta && cap.meta.name) || "file"} — {(cap.meta && (cap.meta.size || ""))}</div>
                {cap.note && <div style={{ color: "#999" }}>Note: {cap.note}</div>}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => uploadCapture(cap.id)}>Upload</button>
              <button onClick={async () => {
                // remove locally
                const arr = captures.filter(x => x.id !== cap.id);
                await chrome.storage.local.set({ [CAPTURE_KEY]: arr });
                setCaptures(arr);
              }}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        Files larger than 5MB are stored as metadata only. Change MAX_FILE_SIZE_BYTES in content_script.js to modify.
      </div>
    </div>
  );
}
