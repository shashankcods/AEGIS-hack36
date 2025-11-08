// popup.js — deterministic session-scoped label counts, display "LABEL - 8"
// UI chrome unchanged; replace previous popup.js with this file.

(function () {
  const btnManual = document.getElementById('btnManual');
  const btnGetLogs = document.getElementById('btnGetLogs');
  const toggle = document.getElementById('toggleEnabled');
  const statusEl = document.getElementById('status');
  const logArea = document.getElementById('logArea');
  const empty = document.getElementById('empty');
  const STORAGE_KEY = 'aegis_enabled';

  // state
  let activeTabId = undefined;
  const labelCounts = new Map(); // label -> count
  const labelNodes = new Map();  // label -> DOM node

  function setStatus(s) {
    statusEl.textContent = s || 'idle';
    statusEl.className = 'status';
    if (s && s !== 'idle') setTimeout(() => setStatus('idle'), 1200);
  }

  function extractLabelsFromResult(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result.map(r => (r && (r.label || r.type)) || String(r)).filter(Boolean);
    if (result.entities && Array.isArray(result.entities)) return result.entities.map(e => (e && (e.label || e.type)) || String(e)).filter(Boolean);
    if (result.result && Array.isArray(result.result)) return result.result.map(r => (r && (r.label || r.type)) || String(r)).filter(Boolean);
    return [];
  }

  // Clear UI + in-memory counts
  function clearHistoryUI() {
    Array.from(logArea.querySelectorAll('.log-entry')).forEach(n => n.remove());
    labelCounts.clear();
    labelNodes.clear();
    empty.style.display = '';
    logArea.scrollTop = 0;
  }

  // Render or update a single label node showing "LABEL - N"
  function upsertLabelNode(label, count) {
    let node = labelNodes.get(label);
    const text = `${label} - ${count}`;
    if (node) {
      node.textContent = text;
    } else {
      empty.style.display = 'none';
      node = document.createElement('div');
      node.className = 'log-entry';
      // keep styling consistent with existing CSS; minimal inline adjustments
      node.style.display = 'block';
      node.style.padding = '8px 10px';
      node.style.marginBottom = '6px';
      node.style.borderRadius = '10px';
      node.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0.006))';
      node.style.cursor = 'default';
      node.textContent = text;
      logArea.appendChild(node);
      labelNodes.set(label, node);
    }
    // scroll to bottom to keep UI intuitive
    logArea.scrollTop = logArea.scrollHeight;
  }

  // increment counts for provided labels array (one increment per appearance)
  function addLabels(labels) {
    if (!labels || !labels.length) return;
    for (const lab of labels) {
      if (!lab) continue;
      const prev = labelCounts.get(lab) || 0;
      const next = prev + 1;
      labelCounts.set(lab, next);
      upsertLabelNode(lab, next);
    }
  }

  // Build counts deterministically from background logs:
  // sort logs by ts increasing and increment in that order
  function rebuildFromBackgroundLogs(tabId) {
    chrome.runtime.sendMessage({ type: 'GET_LOGS', tabId }, (resp) => {
      if (!resp || !resp.ok) {
        clearHistoryUI();
        return;
      }
      clearHistoryUI();
      const logs = (resp.logs || []).slice();
      // Ensure we have timestamp numbers; fallback to array-order if missing
      logs.sort((a, b) => {
        const ta = a && a.ts ? Number(a.ts) : 0;
        const tb = b && b.ts ? Number(b.ts) : 0;
        return ta - tb;
      });
      for (const l of logs) {
        const labels = extractLabelsFromResult(l.result || l.result?.result || l);
        addLabels(labels);
      }
      setStatus('loaded history');
    });
  }

  // Initialize toggle state (UI unchanged)
  chrome.storage.local.get([STORAGE_KEY], (items) => {
    const val = items && typeof items[STORAGE_KEY] !== 'undefined' ? Boolean(items[STORAGE_KEY]) : true;
    try { toggle.checked = val; } catch (e) {}
  });
  toggle.addEventListener('change', () => {
    const v = toggle.checked;
    chrome.storage.local.set({ [STORAGE_KEY]: v }, () => setStatus(v ? 'enabled' : 'disabled'));
  });

  // Manual capture unchanged
  btnManual.addEventListener('click', () => {
    setStatus('sending');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return setStatus('idle');
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          try { if (window.AEGIS_manualCapture) return window.AEGIS_manualCapture(); } catch (e) {}
          window.dispatchEvent(new CustomEvent('AEGIS_REQUEST_MANUAL_UPLOAD_FROM_PAGE'));
          return { ok: true, note: 'dispatched' };
        }
      }, () => {});
    });
  });

  // Get logs -> rebuild deterministically
  btnGetLogs.addEventListener('click', () => {
    rebuildFromBackgroundLogs(activeTabId);
  });

  // Only increment labels on UPLOAD_RESULT for active tab
  function onMessage(msg) {
    if (!msg || !msg.type) return;
    // if the message has a tabId and it's not the active tab, ignore
    if (typeof msg.tabId !== 'undefined' && typeof activeTabId !== 'undefined' && msg.tabId !== activeTabId) return;

    if (msg.type === 'UPLOAD_RESULT') {
      // increment labels found in result
      const labels = extractLabelsFromResult(msg.result);
      addLabels(labels);
      setStatus('received');
    } else if (msg.type === 'SESSION_CLEARED') {
      // if cleared for active tab, reset counts immediately and re-query background logs for assurance
      if (typeof msg.tabId === 'undefined' || msg.tabId === activeTabId) {
        clearHistoryUI();
        setStatus('session cleared');
        // authoritative re-check (should be empty)
        rebuildFromBackgroundLogs(activeTabId);
      }
    }
    // ignore NEW_CAPTURE for counting to avoid duplicates
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // Track active tab and reload counts on tab change / navigation
  function loadActiveTabHistory() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const newTabId = tab ? tab.id : undefined;
      if (newTabId !== activeTabId) {
        activeTabId = newTabId;
        rebuildFromBackgroundLogs(activeTabId);
      }
    });
  }
  chrome.tabs.onActivated && chrome.tabs.onActivated.addListener(loadActiveTabHistory);
  chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (typeof activeTabId !== 'undefined' && tabId === activeTabId) {
      if (changeInfo.status === 'loading') {
        // navigation started: clear UI immediately
        clearHistoryUI();
      } else if (changeInfo.status === 'complete') {
        // navigation finished: rebuild from background (background should have cleared)
        rebuildFromBackgroundLogs(activeTabId);
      }
    }
  });

  // on popup open: set active tab and rebuild counts
  (function init() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      activeTabId = tab ? tab.id : undefined;
      rebuildFromBackgroundLogs(activeTabId);
    });
  })();

})();
