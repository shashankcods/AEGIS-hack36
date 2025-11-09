import { useState, useEffect } from "react";
import "./popup.css";

export default function Popup() {
  const [data] = useState({
    averageSensitivity: 68,
    highestSensitivity: 92,
    lowestSensitivity: 40,
    totalFlagged: 27,
    uniqueLabels: 12,
    highSensitivityPct: 32,
    lowCount: 10,
    mediumCount: 12,
    highCount: 5,
  });

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="popup-shell">
      <div className="popup-root">
        <header className="popup-header centered">
          <h3>AEGIS</h3>
        </header>

        <div className="card-grid">
          <div className="metric-card large">
            <h4>Average Sensitivity</h4>
            <div className="bar-container">
              <div
                className="bar-fill"
                style={{ width: loaded ? `${data.averageSensitivity}%` : 0 }}
              ></div>
            </div>
            <span className="metric-value">{data.averageSensitivity}%</span>
          </div>

          <div className="metric-card">
            <h4>Highest Sensitivity</h4>
            <div className="bar-container small">
              <div
                className="bar-fill high"
                style={{ width: loaded ? `${data.highestSensitivity}%` : 0 }}
              ></div>
            </div>
            <span className="metric-value">{data.highestSensitivity}%</span>
          </div>

          <div className="metric-card">
            <h4>Lowest Sensitivity</h4>
            <div className="bar-container small">
              <div
                className="bar-fill low"
                style={{ width: loaded ? `${data.lowestSensitivity}%` : 0 }}
              ></div>
            </div>
            <span className="metric-value">{data.lowestSensitivity}%</span>
          </div>

          <div className="metric-card">
            <h4>Total Flagged Inputs</h4>
            <div className="circle-wrapper">
              <div className="circle-indicator">
                <span>{data.totalFlagged}</span>
              </div>
            </div>
          </div>

          <div className="metric-card">
            <h4>Unique Labels</h4>
            <div className="circle-wrapper">
              <div className="circle-indicator alt">
                <span>{data.uniqueLabels}</span>
              </div>
            </div>
          </div>

          <div className="metric-card large emphasis">
            <h4>High Sensitivity %</h4>
            <div className="bar-container large">
              <div
                className="bar-fill medium"
                style={{ width: loaded ? `${data.highSensitivityPct}%` : 0 }}
              ></div>
            </div>
            <span className="metric-value">{data.highSensitivityPct}%</span>
          </div>

          <div className="three-card-row">
            <div className="score-box low">
              <h5>Low</h5>
              <div className="score-visual">
                <div
                  className="bar-vertical low"
                  style={{
                    height: loaded ? `${data.lowCount * 3}px` : 0,
                  }}
                ></div>
              </div>
              <span>{data.lowCount}</span>
            </div>

            <div className="score-box medium">
              <h5>Medium</h5>
              <div className="score-visual">
                <div
                  className="bar-vertical medium"
                  style={{
                    height: loaded ? `${data.mediumCount * 3}px` : 0,
                  }}
                ></div>
              </div>
              <span>{data.mediumCount}</span>
            </div>

            <div className="score-box high">
              <h5>High</h5>
              <div className="score-visual">
                <div
                  className="bar-vertical high"
                  style={{
                    height: loaded ? `${data.highCount * 3}px` : 0,
                  }}
                ></div>
              </div>
              <span>{data.highCount}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
