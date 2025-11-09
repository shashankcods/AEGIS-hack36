// sidepanel/App.tsx
import { useEffect, useState } from 'react'
import './App.css'

export default function App() {
  const [logs, setLogs] = useState<{ text: string; time: string }[]>([])

  useEffect(() => {
    // Listen for messages from background/content scripts
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'AEGIS_LOG') {
        setLogs((prev) => [
          { text: msg.payload, time: new Date().toLocaleTimeString() },
          ...prev,
        ])
      }
    })
  }, [])

  return (
    <div className="app-container">
      <h2>AEGIS Log Viewer</h2>
      <div className="log-list">
        {logs.length === 0 && <p>No logs yet.</p>}
        {logs.map((log, i) => (
          <div key={i} className="log-item">
            <span className="log-time">{log.time}</span>
            <pre className="log-text">{log.text}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
