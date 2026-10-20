# Android emulator proof (unreleased)

This is the first native mobile experiment: a synthetic React Native/Expo approval
app, an actual Android emulator and Appium's UiAutomator2 driver. It runs outside
Playwright and has its own versioned plan and report contracts. The published
`@testlane/cli@0.7.0-beta.2` does not include this work or a native `verify` command.

The example contains prewritten tests. It does not demonstrate an agent independently
designing tests for an unfamiliar mobile app. iOS, physical devices and arbitrary
existing Expo apps still need their own integration and evidence.

## Prerequisites

- A checkout of this revision, Node 22.14 or newer compatible with Expo 58, and npm 10+.
- An ephemeral GitHub-hosted Windows runner with hardware acceleration enabled,
  Android SDK and Java 21. Windows startup requires `GITHUB_ACTIONS=true`,
  `RUNNER_ENVIRONMENT=github-hosted` and an explicit `TESTLANE_ANDROID_PROOF_CI=1`.
  These flags are a conservative policy check, not host attestation. Personal and
  shared Windows hosts are refused before SDK reads or device allocation. The proof
  uses DPAPI in a scratch home. Linux requires an explicitly isolated Secret Service
  session (`TESTLANE_REAL_KEYCHAIN=1`); this is not permission to use a personal keyring.
  macOS is refused by this credential-store proof.
- Android SDK platform 37.0, build tools 37.0.0, NDK 27.1.12297006, CMake 3.22.1, platform-tools,
  emulator, and the API 34 Google APIs **x86_64** system image. Install any requested
  SDK components before building. Provision SDK packages and accept their terms using
  the Android SDK tools; the runner never downloads an SDK image or accepts licenses.
- Enough disk and memory for the native build and a new disposable emulator. Initial
  dependency installation and compilation can take several minutes.

The explicit installer pins Appium 3.8.0 and UiAutomator2 8.7.0 in a new short
directory you choose. It does not register a driver in your default Appium home.
Do not point the proof at an existing phone or AVD: there is no option to do that.

On Windows, ADB cannot read some deeply nested npm APK paths. Use a short tools
directory such as the one below, including when this checkout has a long path.
Appium performs its normal installation, version and instrumentation checks. The
receipt records the three automation APK hashes; no installation checks are disabled.

## Run from the checkout

The draft `Android emulator proof` workflow runs on one ephemeral Ubuntu 24.04
x64 VM with KVM. It installs explicitly pinned emulator, platform-tools and API 34
image archives into a new owned SDK, verifies their published digests, then builds
only the public synthetic app. Version-selected build dependencies, the runner's
SDK installer and JDK remain trusted tools; this is not whole-SDK byte attestation.
Storage and acceleration prerequisites fail rather than prune unrelated tools or
fall back to software emulation. Actual passing evidence is required before this
workflow establishes Linux compatibility.

Its private D-Bus and foreground keyring are separate retained process groups,
with no service-activation search directories or desktop-bus access. A generated
canary must be stored, read and removed before account credentials are used.
Success requires the installed-package business proof, retained group/listener
absence, a bounded owned-output secret scan and removal of the private keyring
runtime directory. Failure or cancellation cannot become passing evidence.
Uncertain native teardown preserves credential state and private recovery files.
Captured streams and owned files are scanned; OS-managed GNOME syslog/journal
state is outside that scan and relies on disposal of the ephemeral runner.

The workflow uploads only nine validated JSON projections, bound to the reviewed
and executed source, actual APK and authored case bytes. It excludes raw logs,
keyrings, package archives, screenshots, account identifiers and recovery folders.
The source-packed candidate is separate from the published web verification beta.

Use new absolute output paths. These Windows commands require the ephemeral
GitHub-hosted runner above; its first two host flags are provided by GitHub Actions.
In PowerShell use `npm.cmd` when its `.ps1` shim is blocked. Replace the SDK and JDK paths:

```powershell
New-Item -ItemType Directory -Force C:/temp | Out-Null
npm.cmd ci
npm.cmd run build
npm.cmd --prefix examples/android-verification/tools run setup -- --output-dir C:/temp/testlane-android-tools-1
npm.cmd run build:android-proof -- --output-dir C:/temp/testlane-apk-1 --sdk-root C:/Users/you/AppData/Local/Android/Sdk --java-home "C:/Program Files/Android/Android Studio/jbr"
$env:TESTLANE_ANDROID_PROOF_CI = "1"
npm.cmd run proof:android -- --apk C:/temp/testlane-apk-1/testlane-android-proof.apk --tools-root C:/temp/testlane-android-tools-1 --output-dir C:/temp/testlane-proof-1 --sdk-root C:/Users/you/AppData/Local/Android/Sdk --java-home "C:/Program Files/Android/Android Studio/jbr"
```

The build copies an explicit list of public files to a short owned temporary
directory. It pins the Expo template and npm lockfile, generates Android sources,
builds an x86_64 APK with an embedded JavaScript bundle, and records source/APK hashes.
It does not start Metro, install on a device or use an Expo account. See the
[app source and build recipe](../mobile-approval-app/README.md).

The proof installs a fresh packed Testlane consumer. To test an exact candidate,
set `TESTLANE_PACKAGE_TARBALL` to its absolute tarball path first. No npm publication
is performed. This currently reuses the browser consumer installation helper;
Playwright dependencies are installed, but native actions use only UiAutomator2.

The proof then:

1. Starts a new owned emulator, private ADB server and Appium home, and installs the
   proof APK before generating passwords or starting the backend and broker.
2. Uses the installed Android driver with the same frozen options as the workers to
   create one setup session, verify `NATIVE_APP`, run its existing
   `waitFor('session-status')` check, and acknowledge deletion of that exact session.
   Failure or cancellation blocks all credential creation and defers unknown native
   outcomes to the owned-device teardown; session close is never retried.
3. Generates separate Editor and Reviewer credentials, starts the public synthetic
   backend and seeds only unique scratch profiles through stdin.
4. Uses the real broker to obtain live sessions, deletes its temporary session files,
   and scopes a reverse loopback connection to the same owned device.
5. Runs all five cases with native controls and independent backend observations.
6. Enables a one-cent total defect in the backend, reruns the unchanged cases, removes
   the defect, and reruns again. The APK, plan, case source and installed package must
   retain their hashes throughout.
7. Confirms record absence independently, removes native-store entries and verifies
   their absence, stops owned processes, and scans retained output for credentials.

## Cases and evidence

| Case | Required observation |
| --- | --- |
| `editor-native-total` | Create three items at 1,400 cents through native controls; native and persisted total must be 4,200 cents |
| `editor-cannot-approve` | Native attempt receives 403; all nine saved fields remain unchanged |
| `reviewer-native-approval` | A distinct authenticated Reviewer approves through native controls; exact record has version 2 and the correct approver |
| `duplicate-approval-unchanged` | Repeated native approval receives 409; every saved field remains unchanged |
| `anonymous-denied` | Native and separate anonymous API requests receive 401 |

Every mutating case writes an ownership intent before creating state, resolves its
unique marker independently, deletes only that record and asserts its absence.
Failed business assertions still run bounded cleanup. Missing checks, missing cases,
skips, retries and unsettled callbacks cannot count as passing acceptance.

The private output directory contains a reviewed native plan, three fixed-shape JSON
reports and a receipt with APK, plan, source and installed-package hashes. Reports
retain case IDs, counts, fixed diagnostics and cleanup status. They omit actual and
expected values, exception text, UI hierarchies, screenshots, video and logcat.
Hashes bind inputs; they do not authenticate arbitrary reports or assess test quality.

A fixed `readiness.json` is written only after the credential-free setup session
observes the app-owned readiness element and its DELETE request succeeds. It records
setup/readiness timings and acknowledged session deletion, not final device teardown
or a business-test pass. This is a staging and privacy gate, not a proven fix for
intermittent Appium startup failures or evidence of cold-start performance. Each
worker must still establish its own session and satisfy all existing case assertions.

Only a setup failure before any password, backend or broker exists may retain the
factory's existing bounded error-level output as ignored `preauth-device.log`.
The fixed `readiness-failure.json` contains only an allowlisted diagnosis. No raw
native failure log is retained after credential creation, and Appium verbosity,
logcat capture, retries and request/case budgets are unchanged.

The [initial Android evidence](../../docs/mobile-evidence/android-emulator-2026-10-19.public.json)
and the [shared iOS-change regression](../../docs/verification/native-2026-10-19/android-ios-regression.public.json)
record separate source revisions and installed package trees. The latter rebuilt the
APK after the iOS accessibility change and exercised the shared phase cancellation,
90-second case budgets and controller. It observed five passes, exactly two expected
fault failures, then five corrected passes, with cleanup and credential scans passing.
Neither record establishes iOS acceptance or tests the published npm archive.
The subsequent [keyboard regression](../../docs/verification/native-2026-10-19/android-keyboard-regression.public.json)
repeated the same required outcomes and cleanup checks after adding the iOS-only
Done accessory to the shared app source.

## Session and process limits

This **debuggable proof-only APK** consumes a private file under its own Android app
data directory, then immediately deletes that file. The host sends a short-lived
session over stdin to `adb run-as`; the app holds it in memory. Passwords are never
typed into the native UI, put in launch arguments, or sent through the driver. The
test-only build disables developer support and uses its embedded bundle.

This is an app-specific bootstrap contract, not a way to sign into production apps
or a general guarantee for Expo. Trusted app code, test callbacks and the same OS user
can access live session material. Real applications need a reviewed test-build
contract, dedicated accounts and target policy before reuse.

The fixed Windows tree-kill child and the owned device processes receive explicit
environments. Device tools get canonical SDK/Java paths, owned Android/AVD/ADB-key,
Appium, home, temporary and cache locations, and selected validated OS/executable
configuration. The tree-kill child gets only fixed Windows OS configuration.
Unrelated credentials, proxy settings and runtime-injection variables are not
forwarded. PATH and the configured tool directories remain trusted executable
configuration; this does not establish executable provenance.

Home/profile overrides do not change the OS user, establish a Windows ACL, prevent
trusted tools reading same-user files, guarantee the JVM's user.home setting, or
redirect every OS/service cache. In particular, the emulator can resolve its
console-authentication token through the Windows OS profile independently of these
environment paths; no owned-token-file guarantee or token-path override is claimed.
Appium receives only the owned HOME/USERPROFILE values. The installed SDK has not
been bound to an exact emulator source commit, so the Windows restriction is
conservative. OS-managed profile and service state lie outside private-root cleanup
and rely on disposal of the ephemeral host. Compatibility still requires actual
native setup evidence. Owned-resource checks and independent teardown
remain required, and retained preauth tool logs need review before sharing. The
controller, broker, isolated Linux Secret Service transport, dependency installer
and app build keep their separate environment handling. This is a device-child
boundary, not a repository-wide environment sandbox. Darwin uses the same POSIX
environment rules at configuration level; this does not establish a macOS Android
proof or alter the credential-store proof's Windows/isolated-Linux requirements.

Each native case has a 90-second body budget for its compound role-loading and
native UI flow, a 15-second cleanup budget and up to 5 seconds to settle after an
abort. These bounds are declared in the installed proof's `budgets.mjs`; cases run
once without retries. Initial Appium session creation has a separate
120-second ceiling for cold driver installation and app launch. The 600-second outer
worker process budget covers setup and code that ignores abort signals or blocks
its event loop. Unsettled work
stops subsequent cases and reports unknown cleanup. Device operations verify the
owned emulator; the runner does not kill a global ADB server or reset an existing AVD.
Setup or teardown uncertainty is a failure and preserves recovery metadata. Inspect
private recovery files before retrying; do not replace scoped backend cleanup with a
device wipe. The synthetic backend is in-memory and ends with the proof process.

The ignored output's `timings.json` records elapsed milliseconds per fixed proof
phase and aggregate ownership-check RPC counts/time, including on phase failure.
It contains no native view text, identifiers, payloads or raw errors. Successful
receipts include these metrics and the declared bounds; timing does not replace
the feature assertions or cleanup checks.

This proof does not cover iOS, physical devices, WebViews, push notifications,
biometrics, camera permissions, offline sync, purchases, deep links or device fleets.
It adds no dashboard, hosted service or native MCP tools.
