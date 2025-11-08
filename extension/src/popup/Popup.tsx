// src/popup/Popup.tsx
import React, { useEffect, useMemo, useState } from 'react';
import './popup.css';

type LogItem = {
  id: string;
  type: string;
  count: number;
  examples?: string[];
  ts: number;
  source?: string;
};

const STORAGE_KEY = 'aegis_privacy_logs_v1';

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function formatDate(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString();
}

/* ---------- Simple PII detectors (same heuristics as earlier) ---------- */
function detectPII(text: string) {
  const results: { type: string; count: number; examples?: string[] }[] = [];
  if (!text || !text.trim()) return results;

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phonesRegex = /(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)|\d{2,4})[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g;
  const ccRegex = /(?:\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b)/g;
  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;
  const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

  const push = (type: string, regex: RegExp) => {
    const m = text.match(regex);
    if (m && m.length) results.push({ type, count: m.length, examples: Array.from(new Set(m)).slice(0, 4) });
  };

  push('Email', emailRegex);
  push('Phone', phonesRegex);
  push('Credit Card', ccRegex);
  push('SSN', ssnRegex);
  push('IP Address', ipRegex);

  const lowWeight = ['passport', "driver's license", 'bank account', 'account number', 'mother\'s maiden'];
  const found = lowWeight.filter(w => text.toLowerCase().includes(w));
  if (found.length) results.push({ type: 'Keywords', count: found.length, examples: found.slice(0, 4) });

  return results;
}

/* ---------- Simple privacy score calculator ---------- */
function computePrivacyScore(logs: LogItem[]) {
  const weights: Record<string, number> = {
    Email: 8,
    Phone: 10,
    'Credit Card': 30,
    SSN: 40,
    'IP Address': 6,
    Keywords: 4,
  };
  let raw = 0;
  logs.forEach(l => {
    const w = weights[l.type] ?? 5;
    raw += l.count * w;
  });
  // soft scaling and clamp
  const score = Math.min(100, Math.round((1 - Math.exp(-raw / 18)) * 100));
  return score;
}

/* ---------- Gauge component ---------- */
function Gauge({ score }: { score: number }) {
  const radius = 46;
  const stroke = 10;
  const c = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, score)) / 100) * c;

  const colorFor = (s: number) => {
    if (s < 40) return '#34D399';
    if (s < 70) return '#F59E0B';
    return '#EF4444';
  };

  const color = colorFor(score);

  return (
    <div className="gauge">
      <svg width={120} height={120} viewBox="0 0 120 120">
        <defs>
          <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7C3AED" />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        <g transform="translate(60,60)">
          <circle r={radius} stroke="#0b1220" strokeWidth={stroke} fill="transparent" />
          <circle
            r={radius}
            stroke="url(#g1)"
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="transparent"
            strokeDasharray={`${dash} ${c - dash}`}
            transform="rotate(-90)"
          />
          <text x="0" y="6" textAnchor="middle" fontSize="18" fill="#E6EEF8" fontWeight={700}>
            {Math.round(score)}
          </text>
          <text x="0" y="26" textAnchor="middle" fontSize="10" fill="#9CA3AF">
            Privacy Score
          </text>
        </g>
      </svg>
    </div>
  );
}

/* ---------- Persistence helper ---------- */
function loadLogs(): LogItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    // ignore
  }
  return [];
}
function saveLogs(logs: LogItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
  } catch (e) {}
}

/* ---------- Popup component ---------- */
export default function Popup() {
  const [logs, setLogs] = useState<LogItem[]>(() => loadLogs());
  const [input, setInput] = useState('');
  const [lastScan, setLastScan] = useState<number | null>(null);

  useEffect(() => {
    saveLogs(logs);
  }, [logs]);

  const totalLeaks = useMemo(() => logs.reduce((s, it) => s + it.count, 0), [logs]);
  const score = useMemo(() => computePrivacyScore(logs), [logs]);

  function addDetected(entries: { type: string; count: number; examples?: string[] }[], source = 'manual') {
    if (!entries || entries.length === 0) return;
    const newItems = entries.map(e => ({
      id: uid(),
      type: e.type,
      count: e.count,
      examples: e.examples,
      ts: Date.now(),
      source,
    }));
    setLogs(prev => [...prev, ...newItems]);
    setLastScan(Date.now());
  }

  async function handleScanPage() {
    // Best-effort: ask content script for the page text
    if ((window as any).chrome?.tabs) {
      try {
        // query active tab
        const tabsQry: any = await new Promise(resolve =>
          (window as any).chrome.tabs.query({ active: true, currentWindow: true }, (r: any) => resolve(r))
        );
        const tab = tabsQry && tabsQry[0];
        if (!tab) {
          alert('No active tab found');
          return;
        }
        (window as any).chrome.tabs.sendMessage(
          tab.id,
          { type: 'AEGIS_REQUEST_CAPTURE' },
          (resp: any) => {
            if ((window as any).chrome.runtime.lastError) {
              alert('AEGIS: Could not reach page. Reload page or ensure page script is present.');
              return;
            }
            if (resp?.text) {
              const det = detectPII(resp.text);
              addDetected(det, 'page');
            } else {
              alert('No text found on page.');
            }
          }
        );
      } catch (e) {
        alert('AEGIS: tab messaging not available in this environment.');
      }
    } else {
      alert('chrome.* APIs not available. Use paste/Analyze for demo.');
    }
  }

  function handleAnalyze() {
    const det = detectPII(input);
    addDetected(det, 'popup');
    setInput('');
  }

  function handlePasteClipboard() {
    navigator.clipboard?.readText().then(t => {
      setInput(t || '');
    }).catch(() => {
      alert('Clipboard access denied.');
    });
  }

  function handleExport() {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aegis-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleClear() {
    if (!confirm('Clear all captured PII logs?')) return;
    setLogs([]);
  }

  function removeItem(id: string) {
    setLogs(prev => prev.filter(p => p.id !== id));
  }

  return (
    <div className="popup-root">
      <div className="popup-header">
        <div>
          <h1 className="title">AEGIS Privacy Monitor</h1>
          <div className="subtitle">Detect PII in your ChatGPT prompts</div>
        </div>
        <div className="header-actions">
          <button className="btn ghost" onClick={handleExport}>Export</button>
          <button className="btn danger" onClick={handleClear}>Clear</button>
        </div>
      </div>

      <div className="main-row">
        <div className="gauge-col">
          <Gauge score={score} />
          <div className="leak-count">Leaks: <span className="leak-num">{totalLeaks}</span></div>
        </div>

        <div className="controls-col">
          <div className="controls">
            <button className="btn primary" onClick={handleScanPage}>Scan page</button>
            <button className="btn" onClick={handlePasteClipboard}>Paste</button>
            <div className="last-scan">Last scan: {lastScan ? formatDate(lastScan) : 'never'}</div>
          </div>

          <textarea
            className="input-area"
            placeholder="Paste or type text to analyze (use Scan page for page capture)"
            rows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />

          <div className="analyze-row">
            <button className="btn success" onClick={handleAnalyze}>Analyze</button>
            <div className="advice">
              {score < 40 && 'Low risk — continue careful prompts.'}
              {score >= 40 && score < 70 && 'Medium risk — remove personal IDs.'}
              {score >= 70 && 'High risk — remove sensitive items now.'}
            </div>
          </div>
        </div>
      </div>

      <div className="log-section">
        <div className="log-header">
          <div>Detected PII ({logs.length} entries)</div>
        </div>
        <div className="log-list">
          {logs.length === 0 && <div className="log-empty">No PII detected yet.</div>}
          {logs.slice().reverse().map(item => (
            <div key={item.id} className="log-row">
              <div className="log-left">
                <div className="log-type">{item.type} <span className="log-count">×{item.count}</span></div>
                <div className="log-ts">{formatDate(item.ts)} • {item.source}</div>
                {item.examples && item.examples.length > 0 && (
                  <div className="log-ex">Examples: {item.examples.join(', ')}</div>
                )}
              </div>
              <div className="log-right">
                <button className="btn tiny" onClick={() => removeItem(item.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="footer-note">Tip: Remove account numbers, passwords, and IDs before sending prompts.</div>
    </div>
  );
}
