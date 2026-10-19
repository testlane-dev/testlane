/** Never print browser errors, console output, response bodies, test titles or attachments. */
import fs from 'node:fs';
import path from 'node:path';

function same(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
export default class VerificationReporter {
  constructor({ controlFile, journalFile }) {
    this.control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    this.file = journalFile;
    this.errors = [];
    this.tests = new Map();
    this.results = [];
    this.assertions = new WeakMap();
  }
  printsToStdio() { return true; }
  onStdOut() {}
  onStdErr() {}
  onError() { this.errors.push('GLOBAL_TEST_ERROR'); }
  onStepEnd(test, result, step) {
    if (step.category === 'expect') this.assertions.set(result, (this.assertions.get(result) ?? 0) + 1);
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
      const screenshots = values('testlane-screenshot');
      this.results.push({
        id: mapping?.id ?? null, mapped: mapping?.valid === true,
        // An outer test catch must not erase a failure recorded by runCase.
        status: result.status === 'passed' && bodyValid && bodies[0] === 'failed' ? 'failed' :
          ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'].includes(result.status) ? result.status : 'unknown',
        expectedPassed: test.expectedStatus === 'passed',
        retry: Number.isInteger(result.retry) ? result.retry : -1,
        assertionsObserved: this.assertions.get(result) ?? 0,
        helper: bodyValid && helpers.length === 1 && helpers[0] === this.control.helperVersion + ':' + this.control.helperHash,
        started: starts.length === 1 && starts[0] === mapping?.id,
        cleanup: clean.length === 1 && ['completed', 'failed', 'not-required'].includes(clean[0]) ? clean[0] : 'unknown',
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
