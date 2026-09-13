// Serial supervised catalog trials. Every app has its own exclusive evidence directory.
import path from 'node:path';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runNativeE2E } from './catalog-native-e2e.mjs';
import { runNativeBackground } from './catalog-native-background.mjs';
import { requireUnlockedDesktop } from './lib/catalog-e2e.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode, ...slugs] = process.argv.slice(2);
if (!['full', 'background'].includes(mode) || !slugs.length || new Set(slugs).size !== slugs.length) {
  throw new Error('Usage: catalog-e2e-batch.mjs full|background <fixed slug> [fixed slug …]');
}
const profiles = JSON.parse(await readFile(path.join(root, 'compatibility/runtime-profiles.json'), 'utf8'));
if (slugs.some(slug => !profiles.some(profile => profile.slug === slug))) throw new Error('Every app must have a fixed ordinary runtime profile.');
const base = path.join(root, 'output/e2e-50/2026-09-08');
const stamp = new Date().toISOString().replaceAll(':', '-');
const file = path.join(base, `batch-${mode}-${stamp}.json`);
const batch = { mode, startedAt: new Date().toISOString(), requested: slugs, completed: [], pending: [...slugs] };
const save = () => writeFile(file, JSON.stringify(batch, null, 2) + '\n', { mode: 0o600 });
let stopRequested;
// Stop only between apps, allowing the running trial to complete its owned cleanup.
process.on('SIGINT', () => { stopRequested = 'SIGINT'; });
process.on('SIGTERM', () => { stopRequested = 'SIGTERM'; });
await save();
for (const slug of slugs) {
  if (stopRequested) { batch.stoppedBecause = stopRequested; break; }
  if (mode === 'full') {
    try { await requireUnlockedDesktop(); }
    catch (error) { batch.stoppedBecause = error.message; break; }
  }
  const directory = path.join(base, 'live', slug);
  await mkdir(directory, { recursive: true });
  const prefix = mode === 'full' ? 'trial-' : 'background-trial-';
  const numbers = (await readdir(directory)).filter(name => name.startsWith(prefix))
    .map(name => Number(name.slice(prefix.length))).filter(Number.isInteger);
  const output = path.join(directory, `${prefix}${Math.max(0, ...numbers) + 1}`);
  const result = await (mode === 'full' ? runNativeE2E : runNativeBackground)(slug, output);
  batch.completed.push({ slug, output, status: result.status, automatedFlowPassed: result.automatedFlowPassed,
    backgroundCSSPassed: result.backgroundCSSPassed, errors: result.errors, cleanup: result.cleanup });
  batch.pending.shift();
  await save();
  if (result.cleanup.appLeftRunning || result.cleanup.quitError || result.cleanup.recordRemoved === false ||
      (result.recordID && result.cleanup.recordRemoved !== true)) {
    batch.stoppedBecause = `${slug} needs supervised cleanup before another trial.`;
    break;
  }
}
batch.finishedAt = new Date().toISOString();
await save();
console.log(JSON.stringify({ file, completed: batch.completed.length, pending: batch.pending, stoppedBecause: batch.stoppedBecause }));
