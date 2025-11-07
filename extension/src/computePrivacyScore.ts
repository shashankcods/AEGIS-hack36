// src/computePrivacyScore.ts
// simple mapping: more leaks -> lower score
export function computePrivacyScore(leakCount: number) {
  const n = Math.max(0, Math.floor(leakCount));
  let score = 100;
  let label = "Excellent";

  if (n === 0) { score = 100; label = "Excellent"; }
  else if (n >= 1 && n <= 4) { score = Math.round(90 - n * 7); label = "Good"; }
  else if (n >= 5 && n <= 10) { score = Math.round(60 - (n - 5) * 5); label = "At Risk"; }
  else if (n >= 11 && n <= 50) { score = Math.round(30 - Math.min(20, (n - 11) * 0.5)); label = "Unsafe"; }
  else { score = 5; label = "Critical"; }

  score = Math.max(0, Math.min(100, score));
  return { score, label };
}
