/** Fixed hints for the credential-free public APK build. Never copy log data. */
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const STAGES = ['preparation', 'npm-ci', 'expo-prebuild', 'gradle-release', 'apk-badging'];
const CODES = ['ANDROID_SDK_PREREQUISITE_MISSING', 'ANDROID_JAVA_PREREQUISITE_MISSING',
  'ANDROID_BUILD_PLATFORM_UNSUPPORTED', 'ANDROID_NPM_CLI_UNAVAILABLE', 'ANDROID_BUILD_LOG_FAILED',
  'ANDROID_BUILD_CANCELLED', 'ANDROID_BUILD_CHILD_STOPPED', 'ANDROID_BUILD_STOP_UNCONFIRMED',
  'ANDROID_BUILD_OUTPUT_LIMIT', 'ANDROID_BUILD_CHILD_START_FAILED', 'ANDROID_BUILD_INPUT_INVALID',
  'ANDROID_PUBLIC_SOURCE_INVALID', 'ANDROID_BUILD_STAGE_FAILED', 'ANDROID_EMBEDDED_BUNDLE_MISSING',
  'ANDROID_PROOF_MANIFEST_INVALID', 'ANDROID_BUILD_OWNERSHIP_INVALID', 'ANDROID_BUILD_FAILED'];
const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS',
  'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGTERM', 'SIGXCPU', 'SIGXFSZ', 'SIGSYS', 'SIGBREAK'];
const RULES = [
  ['BUILD_DISK_CAPACITY', /No space left on device|ENOSPC|not enough (?:space|disk space)|insufficient disk space/i],
  ['BUILD_MEMORY_EXHAUSTED', /OutOfMemoryError|Java heap space|GC overhead limit exceeded|Cannot allocate memory|unable to create native thread|out of memory/i],
  ['BUILD_PROCESS_KILLED', /(?:exit (?:value|code)|status)\s*[:=]?\s*137\b|\bSIGKILL\b|^\s*Killed\s*$/im],
  ['BUILD_DAEMON_DISAPPEARED', /Gradle build daemon disappeared unexpectedly|daemon has disappeared/i],
  ['BUILD_NATIVE_TOOLCHAIN', /CMake Error|ninja: (?:error|build stopped)|NDK (?:not configured|is missing)|No version of NDK matched|NDK at .{0,500}did not have a source\.properties|CXX[0-9]{4}/i],
  ['BUILD_COMPILATION', /Compilation error|Compilation failed|compile.{0,120}(?:Kotlin|JavaWithJavac).{0,120}failed|(?:^|\n)\s*e: |(?:fatal )?error: (?:cannot find symbol|package .{0,200} does not exist|undeclared identifier|no member named)/i],
  ['BUILD_DEPENDENCY_RESOLUTION', /Could not resolve (?:all|[A-Za-z0-9@])|Could not find [A-Za-z0-9@].{0,300}[:/]|Failed to resolve (?:all|[A-Za-z0-9@])/i],
  ['BUILD_DOWNLOAD', /Could not (?:GET|HEAD)|Could not download|Could not install Gradle distribution|Failed to download|ETIMEDOUT|ECONNRESET|UnknownHostException|ConnectException/i],
  ['BUILD_TLS', /SSLHandshakeException|PKIX path building failed|unable to find valid certification path|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate|certificate verify failed/i],
  ['BUILD_SDK_PACKAGE_MISSING', /SDK location not found|Failed to find (?:Platform SDK|target with hash)|platforms;android-.{0,100}(?:not installed|missing)|Android SDK.{0,100}(?:missing|not found)|SDK package.{0,100}(?:missing|not found|not installed)/i],
  ['BUILD_TOOLS_MISSING', /Failed to find Build Tools revision|Build Tools revision .{0,100}(?:not found|is corrupted)|Installed Build Tools revision .{0,100}is corrupted|build-tools;.{0,100}(?:not installed|missing)/i],
  ['BUILD_LICENSE', /License for package .{0,500}not accepted|licenses? (?:have|has) not been accepted|license agreements?.{0,100}(?:not accepted|not been accepted)|not accepted the license/i],
  ['BUILD_JAVA', /Unsupported class file major version|requires Java [0-9]+|requires JVM runtime version|JAVA_HOME is set to an invalid directory|No matching (?:Java installation|toolchains)|invalid source release|invalid target release|UnsupportedClassVersionError/i],
  ['BUILD_JS_BUNDLE', /Unable to resolve module|Metro has encountered an error|(?:Android )?Bundling failed|SyntaxError: .{0,200}(?:Unexpected token|Unexpected identifier)|createBundle.{0,100}JsAndAssets.{0,100}failed/i],
  ['BUILD_ANDROID_RESOURCES', /Android resource linking failed|AAPT2?.{0,100}(?:error|failed)|Manifest merger failed|uses-sdk:minSdkVersion.{0,100}cannot be smaller/i],
  ['BUILD_PERMISSION', /Permission denied|EACCES|Operation not permitted/i],
];
const CATEGORIES = [...RULES.map(([code]) => code), 'BUILD_UNCLASSIFIED'];
const KEYS = ['schemaVersion', 'status', 'stage', 'code', 'categories', 'exitCode', 'signal'];
const validExit = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
const invalid = () => new Error('ANDROID_BUILD_DIAGNOSTIC_INVALID');

export function classifyAndroidBuildOutput(output, { exitCode = null, signal = null } = {}) {
  // Build output is already bounded to eight MiB; this helper also refuses larger
  // caller input rather than scanning an unbounded string. Matches are hints,
  // not proof of the cause and never authorize another build or native action.
  const text = typeof output === 'string' && Buffer.byteLength(output) <= 8 * 1024 * 1024 ? output : '';
  const matched = RULES.filter(([code, expression]) => expression.test(text) ||
    code === 'BUILD_PROCESS_KILLED' && (exitCode === 137 || signal === 'SIGKILL')).map(([code]) => code);
  return matched.length ? matched : ['BUILD_UNCLASSIFIED'];
}

export function createAndroidBuildFailure({ stage, code, output = '', exitCode = null, signal = null } = {}) {
  const processExit = validExit(exitCode) ? exitCode : null, processSignal = SIGNALS.includes(signal) ? signal : null;
  return { schemaVersion: 1, status: 'failed', stage: STAGES.includes(stage) ? stage : 'preparation',
    code: CODES.includes(code) ? code : 'ANDROID_BUILD_FAILED',
    categories: classifyAndroidBuildOutput(output, { exitCode: processExit, signal: processSignal }),
    exitCode: processExit, signal: processSignal };
}

export function validateAndroidBuildFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== KEYS.length ||
    Object.keys(value).some(key => !KEYS.includes(key)) || value.schemaVersion !== 1 || value.status !== 'failed' ||
    !STAGES.includes(value.stage) || !CODES.includes(value.code) || !validExit(value.exitCode) ||
    !(value.signal === null || SIGNALS.includes(value.signal)) || !Array.isArray(value.categories) ||
    value.categories.length < 1 || value.categories.length > CATEGORIES.length ||
    value.categories.some(code => !CATEGORIES.includes(code)) || new Set(value.categories).size !== value.categories.length ||
    value.categories.some((code, index) => index > 0 && CATEGORIES.indexOf(code) <= CATEGORIES.indexOf(value.categories[index - 1])) ||
    value.categories.includes('BUILD_UNCLASSIFIED') && value.categories.length !== 1) throw invalid();
  return { schemaVersion: 1, status: 'failed', stage: value.stage, code: value.code,
    categories: [...value.categories], exitCode: value.exitCode, signal: value.signal };
}

export async function readAndroidBuildFailure(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768 || await realpath(file) !== path.resolve(file)) throw invalid();
    const bytes = await readFile(file);
    if (bytes.length > 32768) throw invalid();
    return validateAndroidBuildFailure(JSON.parse(bytes.toString('utf8')));
  } catch { throw invalid(); }
}
