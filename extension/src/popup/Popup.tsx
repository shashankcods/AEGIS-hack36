// extension/src/popup/Popup.tsx
import { useEffect, useState } from 'react';

type LogEntry = {
  ts: number;
  type: string;
  ok?: boolean;
  result?: any;
  error?: string;
  text?: string;
  filename?: string | null;
};

function formatTs(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function Popup() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastMsg, setLastMsg] = useState<string>('');

  useEffect(() => {
    fetchLogs();
    const listener = (msg: any) => {
      if (msg && msg.type === 'UPLOAD_RESULT') {
        setLogs(prev => [{ ts: Date.now(), type: 'UPLOAD_RESULT', ok: !!msg.result, result: msg.result, error: msg.error }, ...prev].slice(0, 50));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchLogs() {
    setLoading(true);
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const tabId = tab?.id ?? 'global';
        chrome.runtime.sendMessage({ type: 'GET_LOGS', tabId }, (resp) => {
          if (chrome.runtime.lastError) {
            setLastMsg(String(chrome.runtime.lastError.message));
            setLoading(false);
            return;
          }
          if (resp?.ok) {
            // Show newest first
            setLogs((resp.logs || []).slice().reverse());
          } else {
            setLastMsg('no logs');
          }
          setLoading(false);
        });
      });
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  }

  function manualCapture() {
    setLastMsg('');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        setLastMsg('no active tab');
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // @ts-ignore
          if ((window as any).AEGIS_manualCapture) {
            // @ts-ignore
            return (window as any).AEGIS_manualCapture();
          } else {
            return { ok: false, error: 'no-capture-fn' };
          }
        }
      }, () => {
        if (chrome.runtime.lastError) {
          setLastMsg('capture failed: ' + chrome.runtime.lastError.message);
        } else {
          setLastMsg('capture requested');
          fetchLogs();
        }
      });
    });
  }

  return (
    <div className="popup-root">
      <header className="popup-header">
        <h3>AEGIS</h3>
        <button onClick={manualCapture} className="primary">Capture</button>
      </header>

      <section className="popup-body">
        <div className="controls">
          <button onClick={fetchLogs}>Refresh</button>
          <span className="status">{loading ? 'loading...' : lastMsg}</span>
        </div>

        <ul className="log-list">
          {logs.length === 0 && <li className="empty">No logs yet</li>}
          {logs.map((l, idx) => (
            <li key={idx} className="log-entry">
              <div className="log-meta">
                <strong>{l.type}</strong> <span className="ts">{formatTs(l.ts)}</span>
              </div>
              {l.text && <div className="log-text">{l.text}</div>}
              {l.result && <pre className="log-result">{JSON.stringify(l.result, null, 2)}</pre>}
              {l.error && <div className="log-error">{l.error}</div>}
            </li>
          ))}
        </ul>
      </section>

      <footer className="popup-footer">
        <small>AEGIS • local dev</small>
      </footer>
    </div>
  );
}
