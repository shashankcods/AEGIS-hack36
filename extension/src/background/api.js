const API_BASE = 'http://127.0.0.1:8000';
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

export async function requestBackend(path, options = {}, settings = {}) {
  const {
    timeoutMs = 120000, maxAttempts = 2, fetchImpl = fetch,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = settings;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The local backend timed out. Please try again.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let retry = false;
    try {
      const response = await fetchImpl(API_BASE + path, {
        ...options, signal: controller.signal, credentials: 'omit',
      });
      if (!response.ok) {
        retry = TRANSIENT_STATUSES.has(response.status);
        const error = new Error(response.status === 413
          ? 'The attachment is too large for the local backend.'
          : response.status === 401 || response.status === 403
            ? 'The local backend rejected authentication. Check its API token settings.'
            : `The local backend returned HTTP ${response.status}.`);
        error.httpStatus = response.status;
        throw error;
      }
      try { return await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error('The local backend returned an invalid JSON response.');
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The local backend timed out. Please try again.');
      retry ||= error instanceof TypeError;
      if (!retry || attempt + 1 >= maxAttempts) {
        if (error instanceof TypeError) throw new Error('Cannot connect to the local backend at 127.0.0.1:8000. Start Django and try again.');
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await wait(Math.min(500 * (attempt + 1), Math.max(0, deadline - Date.now())));
  }
  throw new Error('The local backend request failed.');
}

export function buildFormFromPayload(payload) {
  const form = new FormData();
  if (payload.text?.trim()) form.append('text', payload.text);
  let totalBytes = 0;
  for (const file of payload.files || []) {
    let bytes;
    if (file.base64) {
      let binary;
      try { binary = atob(file.base64); }
      catch { throw new Error('An attachment could not be read. Remove it and attach it again.'); }
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } else if (Array.isArray(file.buffer)) {
      bytes = new Uint8Array(file.buffer);
    } else {
      throw new Error('An attachment was not transferred. Remove it and attach it again.');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TRANSFER_BYTES) throw new Error('Attachments exceed the 8 MB transfer limit. Use smaller files.');
    form.append('image', new Blob([bytes], { type: file.type || 'application/octet-stream' }), file.name || 'attachment');
  }
  return form;
}

export function safeResultSummary(result) {
  return {
    status: result.status,
    detections: (result.detections || []).map(item => ({
      label: item.label, confidence: item.confidence, sensitivity_score: item.sensitivity_score,
    })),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    pathway_pushed: Boolean(result.pathway_pushed),
  };
}
