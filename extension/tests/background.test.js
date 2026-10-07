import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
const removedKeys = [];
const sentToTabs = [];
globalThis.chrome = {
  storage: { local: {
    get: (_keys, callback) => callback({ aegis_logs_tab_1: [{ textPreview: 'old private input' }], unrelated: true }),
    remove: keys => removedKeys.push(...keys),
  } },
  runtime: {
    onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage: (_message, callback) => callback(),
  },
  tabs: {
    sendMessage: (tabId, message, callback) => { sentToTabs.push({ tabId, ...message }); callback(); },
    onRemoved: { addListener: () => {} },
  },
};
await import('../src/background/index.js');
const handle = listeners[0];
const sender = { tab: { id: 1, url: 'https://chatgpt.com/' } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('legacy raw-prompt caches are removed but unrelated keys are preserved', () => {
  assert.deepEqual(removedKeys, ['aegis_logs_tab_1']);
});

test('analyses serialize per tab, replace pending work, and never publish obsolete results', async () => {
  const requests = [];
  globalThis.fetch = async () => new Promise(resolve => requests.push(resolve));
  const replies = [];
  for (const requestId of ['first', 'replaced', 'latest']) {
    assert.equal(handle({
      type: 'UPLOAD_CANDIDATE', requestId,
      payload: { text: `private prompt ${requestId}` },
    }, sender, response => replies.push({ requestId, ...response })), true);
  }
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(replies.find(reply => reply.requestId === 'replaced').superseded, true);
  requests[0](Response.json({ status: 'completed', detections: [{ label: 'old_label', sensitivity_score: .5 }], warnings: [] }));
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(replies.find(reply => reply.requestId === 'first').superseded, true);
  assert.equal(sentToTabs.length, 0);
  requests[1](Response.json({
    status: 'completed', detections: [{ label: 'health_disclosure', confidence: .9, sensitivity_score: .85, text: 'private prompt latest' }], warnings: [],
  }));
  await tick();
  assert.equal(sentToTabs.length, 1);
  assert.equal(sentToTabs[0].requestId, 'latest');
  let logs;
  handle({ type: 'GET_LOGS', tabId: 1 }, sender, response => { logs = response.logs; });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].textLen, 'private prompt latest'.length);
  assert.equal(JSON.stringify(logs).includes('private prompt'), false);
});

test('unsupported sites and empty inputs are rejected locally', () => {
  let reply;
  handle({ type: 'UPLOAD_CANDIDATE', payload: { text: 'hello' } }, { tab: { id: 2, url: 'https://example.com/' } }, response => { reply = response; });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /ChatGPT and Gemini/);
  handle({ type: 'UPLOAD_CANDIDATE', payload: { text: ' \n ' } }, sender, response => { reply = response; });
  assert.match(reply.error, /Enter text/);
});

test('analysis errors reach the originating tab and are not empty success results', async () => {
  globalThis.fetch = async () => new Response('', { status: 422 });
  let reply;
  handle({ type: 'UPLOAD_CANDIDATE', requestId: 'failed', payload: { text: 'sensitive input' } }, sender, response => { reply = response; });
  await tick();
  assert.equal(reply.ok, false);
  assert.match(reply.error, /HTTP 422/);
  assert.equal(sentToTabs.at(-1).requestId, 'failed');
  assert.match(sentToTabs.at(-1).error, /HTTP 422/);
});

test('popup receives real analytics and model readiness as separate services', async () => {
  globalThis.fetch = async url => Response.json(url.endsWith('/stats/')
    ? { current_average: .6, total_scores: 3 }
    : { status: 'not_loaded', redis: { status: 'ready' }, background_processing_ready: false, analytics_ready: false });
  const response = await new Promise(resolve => handle({ type: 'GET_STATS' }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.data.current_average, .6);
  assert.equal(response.data.total_scores, 3);
  assert.equal(response.health.status, 'not_loaded');
  assert.equal(response.health.background_processing_ready, false);
  assert.equal(response.health.analytics_ready, false);
});
