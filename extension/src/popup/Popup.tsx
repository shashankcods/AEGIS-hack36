import React, { useEffect, useState } from "react";
import "./popup.css";

type LogEntry = {
  ts: string;
  event: string;
  result?: any;
  meta?: any;
};

const STORAGE_ENABLED_KEY = "aegis_enabled";

export default function Popup() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [status, setStatus] = useState<string>("idle");

  // load enabled flag from storage
  useEffect(() => {
    chrome.storage.local.get([STORAGE_ENABLED_KEY], (items) => {
      if (items && typeof items[STORAGE_ENABLED_KEY] !== "undefined") {
        setEnabled(Boolean(items[STORAGE_ENABLED_KEY]));
      }
    });
  }, []);

  // subscribe to background messages
  useEffect(() => {
    function onMsg(msg: any) {
      if (!msg) return;
      if (msg.type === "UPLOAD_RESULT") {
        const e: LogEntry = { ts: new Date().toLocaleTimeString(), event: "upload_result", result: msg.result };
        setLogs((p) => [e, ...p].slice(0, 100));
        setStatus("received");
        setTimeout(() => setStatus("idle"), 1200);
      }
      if (msg.type === "NEW_CAPTURE") {
        const e: LogEntry = { ts: new Date().toLocaleTimeString(), event: "capture", meta: msg.entry };
        setLogs((p) => [e, ...p].slice(0, 100));
      }
    }
    chrome.runtime.onMessage.addListener(onMsg);
    // request recent logs immediately
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (resp) => {
      try {
        if (resp && resp.ok && Array.isArray(resp.logs)) {
          const fromServer = resp.logs.map((l: any) => ({ ts: new Date(l.ts).toLocaleTimeString(), event: "history", meta: l }));
          setLogs((p) => [...fromServer.reverse(), ...p].slice(0, 100));
        }
      } catch (e) {}
    });
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  // toggle extension enabled flag
  function toggleEnabled() {
    const next = !enabled;
    chrome.storage.local.set({ [STORAGE_ENABLED_KEY]: next }, () => {
      setEnabled(next);
    });
  }

  // manual capture: execute a small script in the active tab to call window.AEGIS_manualCapture() or dispatch an event
  async function manualCapture() {
    setStatus("sending");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab?.id) return setStatus("idle");
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: () => {
            // prefer direct function if present
            try {
              // @ts-ignore
              if (window.AEGIS_manualCapture) return window.AEGIS_manualCapture();
            } catch (_){}
            // fallback: dispatch a page event your content_script can listen to
            window.dispatchEvent(new CustomEvent("AEGIS_REQUEST_MANUAL_UPLOAD_FROM_PAGE"));
            return { ok: true, note: "dispatched" };
          },
        },
        () => {
          setStatus("sent");
          setTimeout(() => setStatus("idle"), 800);
        }
      );
    });
  }

  // clear logs
  function clearLogs() {
    setLogs([]);
  }

  return (
    <div className="aegis-popup-root">
      <div className="aegis-header">
        <div className="aegis-title">AEGIS</div>
        <div className="aegis-controls">
          <label className="toggle">
            <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
            <span className="slider" />
            <span className="label">{enabled ? "On" : "Off"}</span>
          </label>
        </div>
      </div>

      <div className="aegis-sub">
        <button className="btn primary" onClick={manualCapture}>Manual capture</button>
        <button className="btn" onClick={() => chrome.runtime.sendMessage({ type: "GET_LOGS" }, (r)=>{})}>Get logs</button>
        <button className="btn ghost" onClick={clearLogs}>Clear</button>
        <div className={`status-badge ${status}`}>{status === "idle" ? "idle" : status}</div>
      </div>

      <div className="aegis-log">
        {logs.length === 0 && <div className="aegis-empty">No logs yet — trigger a capture</div>}
        {logs.map((l, i) => (
          <div className="aegis-log-entry" key={i}>
            <div className="meta">
              <span className="evt">{l.event}</span>
              <span className="ts">{l.ts}</span>
            </div>
            <pre className="json">{JSON.stringify(l.result ?? l.meta ?? {}, null, 2)}</pre>
          </div>
        ))}
      </div>

      <footer className="aegis-footer">
        <small>AEGIS — live prompt logger</small>
      </footer>
    </div>
  );
}
