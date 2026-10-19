// Select macOS by behavior, keeping Windows DPAPI and Linux Secret Service on
// every PR and main push. Changed paths are evaluated against both ends of a
// rename because git diff is invoked with --no-renames below.
// Unknown events and unavailable diffs use the full matrix (fail open).
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultOS = ['windows-latest', 'ubuntu-latest'];

export function macOSCoverage(path) {
  const file = path.replaceAll('\\', '/');
  if (file === '.github/workflows/ci.yml' || /^scripts\/ci-matrix\./.test(file)) {
    return ['check', 'workflow', 'cleanRoom', 'keychain'];
  }
  if (file.endsWith('.md')) return [];
  if (/^src\/store\/(?:keychain-macos|select|index|encrypted-file|input)\.ts$/.test(file) ||
      /^tests\/store-(?:keychain-macos|real-keychain|select|encrypted-file|input)\.test\.ts$/.test(file) ||
      /^src\/(?:vault|paths|lock)\.ts$/.test(file) || file === 'tests/vault.test.ts') {
    return ['check', 'cleanRoom', 'keychain'];
  }
  if (/^examples\/(?:workflows|existing-app|playwright)\//.test(file) || /^src\/workflows\//.test(file) ||
      /^schema\/(?:workflow|feature-workflow)/.test(file) || /^tests\/workflow-/.test(file)) {
    return ['workflow', 'cleanRoom'];
  }
  if (/^examples\/workflows\/.*\/package(?:-lock)?\.json$/.test(file)) {
    return ['workflow', 'cleanRoom'];
  }
  if (/^(?:package(?:-lock)?\.json|\.publicignore)$/.test(file) ||
      /^scripts\/(?:clean-room|export-public)\./.test(file) ||
      /^src\/(?:cli|version)\.ts$/.test(file) ||
      /^tests\/(?:public-hygiene|compat-rename)\.test\.ts$/.test(file) ||
      file === '.github/workflows/publish.yml') {
    return ['check', 'cleanRoom'];
  }
  return [];
}

export function selectRunners(event, paths) {
  const full = event === 'schedule' || event === 'workflow_dispatch' ||
    event === 'diff-unavailable';
  const coverage = new Set(paths.flatMap(macOSCoverage));
  const runners = (category) => full || coverage.has(category)
    ? [...defaultOS, 'macos-latest'] : defaultOS;
  return {
    checkOS: runners('check'),
    workflowOS: runners('workflow'),
    cleanRoomOS: runners('cleanRoom'),
    keychainOS: full || coverage.has('keychain')
      ? ['ubuntu-latest', 'macos-latest'] : ['ubuntu-latest'],
  };
}

function changedPaths(base, head) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '') ||
      /^0+$/.test(base)) {
    throw new Error('Missing usable CI_BASE or CI_HEAD');
  }
  return execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, head, '--'],
    { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function main() {
  const event = process.env.CI_EVENT;
  let paths = [];
  let selectionEvent = event;
  if (event === 'push' || event === 'pull_request') {
    try {
      paths = changedPaths(process.env.CI_BASE, process.env.CI_HEAD);
    } catch (error) {
      console.warn(`Cannot inspect changed paths; using full matrix: ${error.message}`);
      selectionEvent = 'diff-unavailable';
    }
  } else if (event !== 'schedule' && event !== 'workflow_dispatch') {
    selectionEvent = 'diff-unavailable';
  }

  const { checkOS, workflowOS, cleanRoomOS, keychainOS } = selectRunners(selectionEvent, paths);
  const output = `check_os=${JSON.stringify(checkOS)}\n` +
    `workflow_os=${JSON.stringify(workflowOS)}\n` +
    `clean_room_os=${JSON.stringify(cleanRoomOS)}\n` +
    `keychain_os=${JSON.stringify(keychainOS)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
  console.log(`Changed paths: ${paths.length}; macOS jobs: ${[
    ['check', checkOS], ['workflow', workflowOS],
    ['clean-room', cleanRoomOS], ['keychain', keychainOS],
  ].filter(([, os]) => os.includes('macos-latest')).map(([name]) => name).join(', ') || 'none'}`);
}

// Compares realpaths (not path.resolve()) on both sides, mirroring src/cli.ts
// isMainModule(): on macOS the OS tmpdir is itself a symlink (/var ->
// /private/var), so a script invoked as `node /var/.../ci-matrix.mjs` gets
// process.argv[1] === '/var/.../ci-matrix.mjs' while import.meta.url resolves
// to the realpath '/private/var/.../ci-matrix.mjs' -- a plain path.resolve()
// compare never matches, main() silently never runs, and the process exits 0
// with no output.
function isEntryPoint(metaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const a = realpathSync(entry);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url)) main();
