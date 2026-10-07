export function scorePercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function readableLabel(label: string) {
  const names: Record<string, string> = {
    health_disclosure: 'Personal health disclosure',
    self_harm_disclosure: 'Personal self-harm disclosure',
    detected_disease: 'Personal health disclosure',
    self_harm_risk: 'Personal self-harm disclosure',
    api_key: 'API key', access_token: 'Access token', secret_key: 'Secret key',
    authentication_token: 'Authentication token',
  };
  const normalized = label.toLowerCase().replace(/[ -]+/g, '_');
  return names[normalized] || label.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function processingWarnings(health: {
  redis?: { status: string };
  background_processing_ready?: boolean;
  analytics_ready?: boolean;
} | null) {
  if (health?.redis?.status === 'unavailable') {
    return ['Analytics / background processing unavailable. Text checks can still run.'];
  }
  const warnings: string[] = [];
  if (health?.background_processing_ready === false) {
    warnings.push('Background consumer unavailable. Text checks can still run, but queued results will not be processed.');
  }
  if (health?.analytics_ready === false) {
    warnings.push('Analytics processor unavailable. Displayed statistics may be stale.');
  }
  return warnings;
}
