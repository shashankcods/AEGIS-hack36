import { useCallback, useEffect, useRef, useState } from 'react';
import { processingWarnings, readableLabel, scorePercent } from '@/shared/presentation';
import './popup.css';

type Stats = {
  current_average: number; highest_score: number; lowest_score: number;
  total_scores: number; unique_label_count: number; percent_high_score: number;
  distribution: { low: number; medium: number; high: number };
  stats_by_label: Record<string, { avg_score?: number; average_score?: number; count?: number; total_scores?: number }>;
};
type Health = {
  status: string; text_analysis_ready?: boolean; redis?: { status: string };
  background_processing_ready?: boolean; analytics_ready?: boolean;
};
type StatsReply = { ok: boolean; data?: Stats; error?: string; health?: Health; healthError?: string };

export default function Popup() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [healthError, setHealthError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState('');
  const mounted = useRef(false);
  const requestNumber = useRef(0);

  const refresh = useCallback(() => {
    const request = ++requestNumber.current;
    setLoading(true);
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response: StatsReply | undefined) => {
        if (!mounted.current || request !== requestNumber.current) return;
        setLoading(false);
        if (chrome.runtime.lastError || !response) {
          setStats(null);
          setHealth(null);
          setError('Extension connection unavailable. Reload the extension and try again.');
          return;
        }
        setHealth(response.health || null);
        setHealthError(response.healthError || '');
        if (response.ok && response.data) {
          setStats(response.data);
          setError('');
          setUpdatedAt(new Date().toLocaleTimeString());
        } else {
          setStats(null);
          setError(response.error || 'Analytics are unavailable. Start Django, Redis, and the analytics processor.');
        }
      });
    } catch {
      setLoading(false);
      setStats(null);
      setError('Extension connection unavailable. Reload the extension and try again.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const poll = setInterval(refresh, 20000);
    const onResult = (message: { type?: string }) => {
      if (message?.type === 'UPLOAD_RESULT') refresh();
    };
    chrome.runtime.onMessage.addListener(onResult);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      chrome.runtime.onMessage.removeListener(onResult);
    };
  }, [refresh]);

  const percentage = (value: number) => `${scorePercent(value) ?? '—'}%`;
  const healthMessage = health?.status === 'ready'
    ? 'Text models ready'
    : health?.status === 'not_loaded'
      ? 'Text models load on the first privacy check'
      : health?.status === 'unavailable'
        ? 'Model check unavailable'
        : healthError ? 'Cannot check model readiness' : 'Checking model readiness…';
  const workerWarnings = processingWarnings(health);
  const degraded = Boolean(error || healthError || health?.status === 'unavailable' || workerWarnings.length);

  return (
    <main className="popup-root">
      <header className="popup-header">
        <div><h1>AEGIS</h1><p>Local privacy checks for AI prompts</p></div>
        <button className="primary" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </header>
      <div className={`service-status ${degraded ? 'degraded' : ''}`} role="status">
        <p>{healthMessage}</p>
        {workerWarnings.map(warning => <p key={warning}>{warning}</p>)}
        {healthError && <p>{healthError}</p>}
      </div>
      {error && <div className="error-box" role="alert"><strong>Statistics unavailable</strong><p>{error}</p></div>}
      {stats && <>
        <div className="card-grid">
          <Metric label="Average sensitivity" value={percentage(stats.current_average)} />
          <Metric label="Highest sensitivity" value={percentage(stats.highest_score)} />
          <Metric label="Lowest sensitivity" value={percentage(stats.lowest_score)} />
          <Metric label="Flagged category events" value={stats.total_scores} />
          <Metric label="Unique categories" value={stats.unique_label_count} />
          <Metric label="High sensitivity events" value={`${Math.round(stats.percent_high_score)}%`} />
        </div>
        <p className="metric-note">Events count detected categories, not individual prompts. Sensitivity describes the category; it is not model confidence.</p>
        <h2>Detection distribution</h2>
        <div className="distribution">
          {(['low', 'medium', 'high'] as const).map(level => <div key={level} className={level}>
            <span>{level}</span><strong>{stats.distribution?.[level] ?? 0}</strong>
          </div>)}
        </div>
        <h2>Sensitivity by category</h2>
        <div className="label-list">
          {Object.entries(stats.stats_by_label || {}).map(([label, row]) => {
            const percent = scorePercent(row.avg_score ?? row.average_score);
            return <div className="label-card" key={label}>
              <div><span>{readableLabel(label)}</span><strong>{percent === null ? '—' : `${percent}%`}</strong></div>
              <div className="bar-track"><div style={{ width: `${percent ?? 0}%` }} /></div>
            </div>;
          })}
          {stats.total_scores === 0 && <p className="empty">No recorded detections yet. Analytics update after the background processor consumes a check.</p>}
        </div>
        <p className="updated">{health?.analytics_ready === false ? 'Snapshot fetched' : 'Updated'} {updatedAt}</p>
      </>}
      {!stats && !error && <p className="empty">Loading local statistics…</p>}
      <footer>Checks cover supported text, images and PDFs on ChatGPT and Gemini. Review flagged information before sharing.</footer>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}
