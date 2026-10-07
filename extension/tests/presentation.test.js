import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/shared/presentation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { processingWarnings, readableLabel, scorePercent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('0..1 sensitivity scores display as percentages and missing scores stay missing', () => {
  assert.equal(scorePercent(.85), 85);
  assert.equal(scorePercent(0), 0);
  assert.equal(scorePercent(1), 100);
  assert.equal(scorePercent(undefined), null);
  assert.equal(scorePercent(NaN), null);
  assert.equal(scorePercent(Infinity), null);
  assert.equal(scorePercent(5), 100);
});

test('new disclosure labels are understandable and do not imply a diagnosis', () => {
  assert.equal(readableLabel('health_disclosure'), 'Personal health disclosure');
  assert.equal(readableLabel('SELF_HARM_DISCLOSURE'), 'Personal self-harm disclosure');
  assert.equal(readableLabel('api_key'), 'API key');
  assert.equal(readableLabel('email_address'), 'Email Address');
});

test('live Redis cannot mask a stopped consumer or stale analytics processor', () => {
  const warnings = processingWarnings({
    redis: { status: 'ready' }, background_processing_ready: false, analytics_ready: false,
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /queued results will not be processed/);
  assert.match(warnings[1], /statistics may be stale/);
  assert.deepEqual(processingWarnings({
    redis: { status: 'ready' }, background_processing_ready: true, analytics_ready: true,
  }), []);
});

test('Redis outage gives a single service warning rather than duplicate worker errors', () => {
  const warnings = processingWarnings({
    redis: { status: 'unavailable' }, background_processing_ready: false, analytics_ready: false,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /background processing unavailable/);
});
