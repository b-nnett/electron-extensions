import test from 'node:test';
import assert from 'node:assert/strict';
import { runProof } from '../scripts/verify.mjs';

test('external CSS and a JS button survive reload and remove cleanly without changing the signed fixture', { timeout: 90000 }, async () => {
  const report = await runProof();
  assert.equal(report.status, 'passed');
  assert.equal(report.before.sha256, report.after.sha256);
  assert.equal(report.before.cdhash, report.after.cdhash);
  assert.deepEqual(report.consoleEvents.map(record => record.clickCount), [1, 2, 1]);
});
