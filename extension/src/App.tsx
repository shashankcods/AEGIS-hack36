import React, { useEffect, useState, useCallback } from "react";

type CapturedFile = {
  name: string;
  // you can add size, type, base64, etc. if you send those
};

type LogEntry = {
  text: string;
  ts?: number | string;
  source?: string;
  files?: CapturedFile[];
};

export default function App(): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<string>("idle");

  // small helper to safely access chrome APIs (avoids TS errors when building outside extension runtime)
  const chromeSafe: any = typeof window !== "undefined" ? (window as any).chrome : undefined;

  useEffect(() => {
    if (!chromeSafe || !chromeSafe.runtime || !chromeSafe.runtime.onMessage) return;

    const onMsg = (msg: any, _sender: any, _sendResponse: any) => {
      if (!msg || !msg.type) return;
      if (msg.type === "NEW_CAPTURE" && msg.entry) {
        setLogs((prev) => [msg.entry as LogEntry, ...prev]);
      }
    };

    chromeSafe.runtime.onMessage.addListener(onMsg);
    return () => {
      try {
        chromeSafe.runtime.onMessage.removeListener(onMsg);
      } catch (e) {
        // ignore remove errors during hot reloads/dev
      }
    };
  }, []); // run once

  const fetchLogs = useCallback(() => {
    if (!chromeSafe || !chromeSafe.runtime || !chromeSafe.runtime.sendMessage) return;
    try {
      chromeSafe.runtime.sendMessage({ type: "GET_LOGS" }, (resp: any) => {
        // check for runtime error
        if (chromeSafe.runtime.lastError) {
          console.warn("chrome.runtime.lastError:", chromeSafe.runtime.lastError);
          return;
        }
        if (resp && resp.ok) setLogs(resp.logs || []);
      });
    } catch (e) {
      console.error(e);
    }
  }, [chromeSafe]);

  const doManualCapture = useCallback(() => {
    if (!chromeSafe || !chromeSafe.tabs || !chromeSafe.tabs.query) {
      setStatus("chrome tabs unavailable");
      return;
    }
    setStatus("manual...");
    try {
      chromeSafe.tabs.query({ active: true, currentWindow: true }, (tabs: any[]) => {
        if (chromeSafe.runtime?.lastError) {
          setStatus("error: " + chromeSafe.runtime.lastError.message);
          return;
        }
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id === "undefined") {
          setStatus("no active tab");
          return;
        }
        chromeSafe.tabs.sendMessage(tab.id, { type: "MANUAL_CAPTURE" }, (resp: any) => {
          if (chromeSafe.runtime?.lastError) {
            setStatus("sendMessage error");
            return;
          }
          setStatus("manual done");
        });
      });
    } catch (e) {
      console.error(e);
      setStatus("error");
    }
  }, [chromeSafe]);

  const renderTime = (ts?: number | string) => {
    const n = ts ? Number(ts) : Date.now();
    if (Number.isNaN(n)) return "invalid time";
    return new Date(n).toLocaleTimeString();
  };

  return (
    <div style={{ padding: 12, fontFamily: "system-ui, Arial", width: 360 }}>
      <h3 style={{ margin: "0 0 8px 0" }}>AEGIS — Prompt logs</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={fetchLogs} disabled={!chromeSafe || !chromeSafe.runtime}>
          Get logs
        </button>

        <button onClick={doManualCapture} disabled={!chromeSafe || !chromeSafe.tabs}>
          Manual capture
        </button>

        <div style={{ marginLeft: "auto", color: "#666", fontSize: 12 }}>{status}</div>
      </div>

      <div style={{ maxHeight: "50vh", overflowY: "auto", border: "1px solid #eee", padding: 8 }}>
        {logs.length === 0 ? (
          <div style={{ color: "#666" }}>No logs yet</div>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              style={{ marginBottom: 10, borderBottom: "1px solid #f1f1f1", paddingBottom: 8 }}
            >
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{l.text}</div>

              <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
                {l.source || "content"} — {renderTime(l.ts)}
              </div>

              {l.files && l.files.length ? (
                <div style={{ fontSize: 11, color: "#444", marginTop: 6 }}>
                  Files: {l.files.map((f) => f.name).join(", ")}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
