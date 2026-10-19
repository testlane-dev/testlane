/** Never print browser errors, console output, response bodies, test titles or attachments. */
import fs from 'node:fs';
import path from 'node:path';

function same(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function coordinate(value) { return Number.isSafeInteger(value) && value >= 1 && value <= 1000000; }
export default class VerificationReporter {
  constructor({ controlFile, journalFile }) {
    this.control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    this.file = journalFile;
    this.errors = [];
    this.tests = new Map();
    this.results = [];
    this.assertions = new WeakMap();
    this.assertionFailures = new WeakSet();
    this.failureLocations = new WeakMap();
  }
  printsToStdio() { return true; }
  onStdOut() {}
  onStdErr() {}
  onError() { this.errors.push('GLOBAL_TEST_ERROR'); }
  onStepEnd(test, result, step) {
    if (step.category !== 'expect') return;
    this.assertions.set(result, (this.assertions.get(result) ?? 0) + 1);
    if (!step.error) return;
    this.assertionFailures.add(result);
    const mapping = this.tests.get(test.id);
    const item = this.control.cases.find(value => value.id === mapping?.id);
    const location = step.location;
    if (!this.failureLocations.has(result) && mapping?.valid && typeof location?.file === 'string' &&
      path.isAbsolute(location.file) && same(path.resolve(location.file), item.spec) &&
      coordinate(location.line) && coordinate(location.column)) {
      this.failureLocations.set(result, { line: location.line, column: location.column });
    }
  }
  onBegin(config, suite) {
    try {
      for (const test of suite.allTests()) {
        const values = test.annotations.filter(a => a.type === 'testlane-case');
        const id = values.length === 1 ? values[0].description : null;
        const item = this.control.cases.find(c => c.id === id);
        if (!item || !same(path.resolve(test.location.file), item.spec)) this.errors.push('CASE_MAPPING_INVALID');
        this.tests.set(test.id, { id: item?.id ?? null, valid: Boolean(item && values.length === 1 && same(path.resolve(test.location.file), item.spec)) });
      }
      this.discovered = this.tests.size;
      if (config.workers !== 1 || config.projects.some(p => p.retries !== 0)) this.errors.push('RUN_CONFIGURATION_INVALID');
    } catch { this.errors.push('REPORTER_INVALID'); }
  }
  onTestEnd(test, result) {
    try {
      const mapping = this.tests.get(test.id);
      const annotations = result.annotations ?? test.annotations;
      const values = type => annotations.filter(a => a.type === type).map(a => a.description);
      const clean = values('testlane-cleanup');
      const helpers = values('testlane-helper');
      const starts = values('testlane-started');
      const bodies = values('testlane-body');
      const bodyValid = bodies.length === 1 && ['completed', 'failed'].includes(bodies[0]);
      const helperValid = bodyValid && helpers.length === 1 && helpers[0] === this.control.helperVersion + ':' + this.control.helperHash;
      const started = starts.length === 1 && starts[0] === mapping?.id;
      const cleanup = clean.length === 1 && ['completed', 'failed', 'not-required'].includes(clean[0]) ? clean[0] : 'unknown';
      const screenshots = values('testlane-screenshot');
      // Neither an inner assertion catch nor an outer helper catch erases failure.
      const status = result.status === 'passed' && ((bodyValid && bodies[0] === 'failed') || this.assertionFailures.has(result)) ? 'failed' :
        ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status) ? result.status : 'unknown';
      // Classify lifecycle evidence only. Exception names/messages, stacks, browser
      // output and network values never enter the journal, even as diagnostics.
      let diagnosticCode = null;
      if (cleanup === 'failed') diagnosticCode = 'CLEANUP_FAILED';
      else if (status === 'timedOut') diagnosticCode = 'CASE_TIMED_OUT';
      else if (status === 'failed') {
        if (!helperValid || !started) diagnosticCode = 'CASE_SETUP_OR_CONTRACT_FAILED';
        else if (this.assertionFailures.has(result)) diagnosticCode = 'ASSERTION_FAILED';
        else if (bodies[0] === 'failed') diagnosticCode = 'CASE_BODY_FAILED';
        else if (bodies[0] === 'completed' && ['completed', 'not-required'].includes(cleanup)) diagnosticCode = 'CASE_AFTER_BODY_FAILED';
        else diagnosticCode = 'CASE_SETUP_OR_CONTRACT_FAILED';
      }
      this.results.push({
        id: mapping?.id ?? null, mapped: mapping?.valid === true,
        status,
        expectedPassed: test.expectedStatus === 'passed',
        retry: Number.isInteger(result.retry) ? result.retry : -1,
        assertionsObserved: this.assertions.get(result) ?? 0,
        failureLocation: ['failed', 'timedOut'].includes(status) ? this.failureLocations.get(result) ?? null : null,
        helper: helperValid, started, cleanup, diagnosticCode,
        screenshots: screenshots.filter(x => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,63}:screenshot-[a-f0-9-]{36}\.png$/.test(x)),
        unexpectedAttachments: result.attachments.length > 0,
      });
    } catch { this.errors.push('REPORTER_INVALID'); }
  }
  onEnd(result) {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ schemaVersion: 1, discovered: this.discovered ?? 0,
        outcome: ['passed', 'failed', 'timedout', 'interrupted'].includes(result.status) ? result.status : 'unknown',
        errors: [...new Set(this.errors)], results: this.results }), { flag: 'wx', mode: 0o600 });
    } catch { /* The parent treats a missing or incomplete journal as blocked. */ }
  }
}
