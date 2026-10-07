import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormFromPayload, MAX_TRANSFER_BYTES, requestBackend, safeResultSummary } from '../src/background/api.js';

test('multipart upload retains multiline text and every attachment', async () => {
  const form = buildFormFromPayload({
    text: 'First paragraph\nSecond paragraph',
    files: [
      { name: 'one.png', type: 'image/png', base64: btoa('PNG') },
      { name: 'two.pdf', type: 'application/pdf', buffer: [37, 80, 68, 70] },
    ],
  });
  assert.equal(form.get('text'), 'First paragraph\nSecond paragraph');
  const files = form.getAll('image');
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'one.png');
  assert.equal(await files[1].text(), '%PDF');
});

test('metadata-only or malformed attachments fail instead of claiming they were checked', () => {
  assert.throws(() => buildFormFromPayload({ files: [{ name: 'secret.pdf', size: 500 }] }), /not transferred/);
  assert.throws(() => buildFormFromPayload({ files: [{ base64: '%invalid%' }] }), /could not be read/);
});

test('attachment size is checked against actual bytes', () => {
  assert.throws(() => buildFormFromPayload({ files: [{ buffer: new Array(MAX_TRANSFER_BYTES + 1).fill(0), size: 1 }] }), /8 MB/);
});

test('client validation errors are not retried or echoed with submitted text', async () => {
  let attempts = 0;
  await assert.rejects(requestBackend('/api/analyze/', {}, {
    fetchImpl: async () => { attempts++; return new Response('private input echoed by server', { status: 422 }); },
    wait: async () => {},
  }), /HTTP 422/);
  assert.equal(attempts, 1);
});

test('transient failures retry and recover within the attempt limit', async () => {
  let attempts = 0;
  const result = await requestBackend('/api/analyze/', {}, {
    fetchImpl: async () => ++attempts === 1
      ? new Response('', { status: 503 })
      : Response.json({ detections: [] }),
    wait: async () => {},
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result, { detections: [] });
});

test('network failures are bounded and give an actionable local-backend error', async () => {
  let attempts = 0;
  await assert.rejects(requestBackend('/api/analyze/', {}, {
    fetchImpl: async () => { attempts++; throw new TypeError('Failed to fetch'); },
    wait: async () => {},
  }), /Start Django/);
  assert.equal(attempts, 2);
});

test('a hanging backend is aborted at the overall deadline', async () => {
  let attempts = 0;
  await assert.rejects(requestBackend('/api/analyze/', {}, {
    timeoutMs: 15,
    fetchImpl: async (_url, options) => {
      attempts++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    },
  }), /timed out/);
  assert.equal(attempts, 1);
});

test('metadata summaries strip raw text from backend detections and top-level fields', () => {
  const result = safeResultSummary({
    status: 'completed', text: 'private prompt', input: 'private prompt',
    detections: [{ label: 'health_disclosure', confidence: .9, sensitivity_score: .8, text: 'private prompt' }],
    warnings: [], pathway_pushed: 1,
  });
  assert.equal(JSON.stringify(result).includes('private prompt'), false);
  assert.deepEqual(result.detections, [{ label: 'health_disclosure', confidence: .9, sensitivity_score: .8 }]);
});
