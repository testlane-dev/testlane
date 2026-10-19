#!/usr/bin/env node
import { runVerification } from './runtime.mjs';
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('message', value => { if (value === 'testlane:verification:cancel:v1') cancel(); });
process.on('disconnect', cancel);
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
if (process.connected) process.send('testlane:verification:ready:v1');
try {
  const args = process.argv.slice(2);
  let planFile, outputDir, json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') json = true;
    else if (args[index] === '--plan' && args[index + 1] && !planFile) planFile = args[++index];
    else if (args[index] === '--output-dir' && args[index + 1] && !outputDir) outputDir = args[++index];
    else throw new Error('ARGUMENTS_INVALID');
  }
  if (!planFile) throw new Error('ARGUMENTS_INVALID');
  const { report } = await runVerification({ planFile, outputDir, signal: controller.signal });
  process.stdout.write(JSON.stringify(report, null, json ? 2 : 0) + '\n');
  process.exitCode = report.verdict === 'passed' ? 0 : report.verdict === 'cancelled' ? 130 : report.verdict === 'failed' ? 1 : 2;
} catch {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, verdict: 'blocked', reasonCodes: ['RUNNER_ARGUMENTS_OR_OUTPUT_INVALID'] }) + '\n');
  process.exitCode = 2;
} finally {
  if (process.connected) process.disconnect();
  process.channel?.unref();
}
