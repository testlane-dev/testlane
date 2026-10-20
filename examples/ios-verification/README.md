# iOS Simulator proof (unreleased)

This source-checkout experiment runs the public synthetic React Native/Expo approval
app in a newly created iOS Simulator through Appium/XCUITest. It uses the shared
native cases and a separate native plan/report contract, outside Playwright.
`@testlane/cli@0.7.0-beta.2` does not include this work or a native `verify` command.

The implementation and local policy tests do not establish iOS acceptance. The
actual macOS build, installed-package positive/fault/corrected run and complete
cleanup must pass before this experiment can be described as verified. General iOS
support remains planned. The cases are prewritten; this is not evidence of an agent
independently designing tests for an unfamiliar app.

## Required environment

The complete credential-backed proof runs only on an **ephemeral GitHub-hosted
macOS runner** with `TESTLANE_IOS_PROOF_CI=1`. It also requires GitHub's
`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted` indicators. Do not
spoof these variables to run it on a personal Mac or a self-hosted runner. They
guard the intended environment; they do not sandbox code running as the same user.
The driver requests headless startup so Appium preserves the owned boot instead of
restarting it to open a GUI. Appium's headless mode can terminate Simulator UI
clients; this is another reason the experiment is confined to an ephemeral host.

The runner needs:

- A checkout of this revision, Node 22.14+ compatible with Expo 58, and npm 10+.
- Xcode 26.4+, its iOS Simulator SDK and completed license/first-launch setup.
  The tools do not download Xcode or runtimes, accept licenses, or select a different
  developer directory.
- The installed, available `com.apple.CoreSimulator.SimRuntime.iOS-26-4` runtime and
  `com.apple.CoreSimulator.SimDeviceType.iPhone-17` device type. No available-device
  fallback is used.
- An existing CocoaPods executable and enough disk/memory for a Release native
  build, WebDriverAgent compilation and a new Simulator.

The optional tooling installer pins Appium 3.8.0, XCUITest 12.19.1 and WebDriverAgent
16.16.3 through its lockfile. It uses `npm ci --ignore-scripts` in a new explicit
output directory and leaves the default Appium installation alone. Device startup
does not install dependencies. No physical device, Apple developer account, signing
certificate, provisioning profile, Expo account or human test account is needed.

## Run the hosted proof

Use the repository's [iOS Simulator workflow](../../.github/workflows/ios-simulator-proof.yml).
It inspects prerequisites, runs the policy tests and builds the Simulator app without
Apple signing credentials. A credential-free diagnostic then creates a new owned
Simulator, installs and launches the unauthenticated app, opens one WebDriverAgent session, verifies `NATIVE_APP`
and removes that session and Simulator. Only after that passes does the
installed-package proof create credentials and use another new Simulator. Ordinary
`npm run test:mobile` executes unit/control tests without starting a device.

The equivalent commands below belong in that opted-in ephemeral hosted job, from
the repository root. Every final output directory must be new; its parent must
exist at a canonical path:

```sh
npm ci
npm run build
npm run test:mobile
node scripts/ios-preflight.mjs output/ios-preflight.json

proof_root="$(cd "$RUNNER_TEMP" && pwd -P)/testlane-ios-$$"
mkdir "$proof_root"
npm --prefix examples/ios-verification/tools run setup -- --output-dir "$proof_root/tools"
npm run build:ios-proof -- --output-dir "$proof_root/build"
TESTLANE_IOS_PROOF_CI=1 node scripts/ios-wda-preflight.mjs --app "$proof_root/build/TestlaneIOSProof.app" --tools-root "$proof_root/tools" --output-dir "$GITHUB_WORKSPACE/output/ios-wda-preflight"
TESTLANE_IOS_PROOF_CI=1 npm run proof:ios -- --app "$proof_root/build/TestlaneIOSProof.app" --tools-root "$proof_root/tools" --output-dir "$GITHUB_WORKSPACE/output/ios-proof"
```

Set `TESTLANE_PACKAGE_TARBALL` to the absolute reviewed candidate tarball to verify
those exact installed bytes. Without it, the consumer helper packs the current
checkout. Neither operation publishes to npm. The helper installs browser consumer
dependencies too; native interactions use XCUITest, not a browser.

The [app build recipe](../mobile-approval-app/README.md#ios-simulator-release-build-without-apple-signing-credentials)
copies seven explicit public inputs into an owned temporary build root. It uses
the pinned Expo template, npm lockfile and CocoaPods, then builds an
`iphonesimulator` Release app with embedded JavaScript and no Apple signing
credentials. The ARM64 linker may still add a linker ad-hoc signature; it carries
no Apple Developer certificate identity or team. This is not an App Store or
physical-device build. No Metro server is needed at runtime. The build manifest
records the observed signature state and binds source, configuration, dependency
and app-tree hashes. Build-only commands do not launch or install on a Simulator.

## Required case outcomes

| Case | Required observation |
| --- | --- |
| `editor-native-total` | Create three items at 1,400 cents through native controls; native and persisted totals equal 4,200 cents |
| `editor-cannot-approve` | Editor's native approval attempt returns 403; all nine stable saved fields remain unchanged |
| `reviewer-native-approval` | A distinct Reviewer approves through native controls; saved version and approver are correct |
| `duplicate-approval-unchanged` | Repeated native approval returns 409; every stable saved field remains unchanged |
| `anonymous-denied` | Native and separate anonymous API checks return 401 |

The unchanged suite must pass all five cases, detect an injected 4,199-cent total
with exactly two assertion failures and three passes, then pass all five after
correction. The expected fault failures are `editor-native-total` and
`reviewer-native-approval`. Each phase must independently leave zero owned backend
records. The app bundle, build manifest, plan, case source and installed package
must keep the same hashes throughout.

Every mutating case journals its unique ownership marker before creation, resolves
its record independently, deletes only that record and verifies absence. Missing
cases, skipped assertions, retries and unsettled callbacks cannot pass acceptance.
An app reinstall or Simulator deletion does not replace backend cleanup.

## Credentials and device ownership

The controller generates separate disposable Editor and Reviewer passwords, seeds
them through the real installed CLI over stdin, and obtains real backend sessions.
A small CLI wrapper selects a new, explicit temporary `KeychainMacosStore`; it does
not redirect the ordinary CLI's default credential store. The proof checks the
original default keychain and restores/verifies the original search list after
temporary keychain operations. It deletes only its unique entries and temporary
keychain, then confirms absence. It never requests a user's Apple credentials.

Session delivery is specific to this synthetic test build. The host creates only
`Documents/testlane-bootstrap.json`, mode 0600, inside the canonical app data
container returned for the owned Simulator and `dev.testlane.iosproof`. Existing
files, symlinks and paths outside that container are refused. The app deletes the
file before parsing or accepting its contents and keeps the cookie in memory.
After identity is ready, the controller independently checks file absence.

The test app provides an iOS input accessory with an explicit keyboard dismissal
control. The driver activates that configured control once and observes that the
keyboard disappears; it does not assume an iPhone number pad has a system Done key
or ignore a failed dismissal. This is part of the synthetic app's UI contract.

Setup launches only the fixed proof bundle on the owned Simulator before the
application backend, broker or bootstrap credentials exist. WDA attaches to that
running app with forced relaunch disabled and one startup attempt. This separates
cold app startup from the five-second ordinary command transport; it does not test
cold-start performance or prove the app is ready merely because launch was
acknowledged. Role loading, identity checks and all business assertions still run
through the native controls.

Passwords and cookies are not typed into native controls, placed in launch arguments
or environment variables, or sent to WebDriverAgent. Live sessions remain available
to trusted app/test code and the same OS user; this is not a credential sandbox.
The proof-only network policy permits the exact loopback backend, rather than a
production sign-in bypass or a general session mechanism for other apps.

The device controller creates one nonce-named Simulator in the hosted runner's
existing standard CoreSimulator device set, which makes it visible to Xcode's
WebDriverAgent build. It derives that set from the OS account's home directory,
checks its canonical path, and binds the new UUID and nonce to the run's private
marker. Every device operation names that set and exact UUID. It never selects an
existing or booted device, resets the set, or creates, repairs or removes the set
directory. This arrangement is restricted to the ephemeral hosted runner above.

Before creation, the controller snapshots the other devices' stable identity,
configuration, availability and state. Ownership checks and teardown require that
inventory to remain unchanged; a mismatch fails the proof and retains recovery
metadata. Cleanup deletes only the proven owned UUID and verifies its absence. It
does not repair or delete another device. This inventory check does not establish
that Simulator UI clients were untouched; Appium's headless behavior is described
above.

Appium, WebDriverAgent and MJPEG use owned ports bound to loopback. Appium's home,
temporary files and derived data remain private to the run. Teardown stops only
retained owned process identities, then checks device/listener absence before
removing its private temporary directories. A shared device-set path grants no
process-killing authority.

Native device tools receive only selected toolchain/environment settings and the
run's private home, temporary and Appium directories. Unrelated inherited
credentials and Node injection settings are not forwarded. This limits accidental
diagnostic exposure; it does not isolate trusted tools from the same OS user.

## Evidence and current limits

Each compound role-loading and native UI case has a 90-second body budget,
15 seconds for cleanup and up to 5 seconds to settle after abort. The installed
shared `budgets.mjs` declares these bounds and the 600-second outer worker ceiling;
cases run once without retries. Cold Appium/WebDriverAgent session creation has
its own 240-second ceiling within that outer limit. Fixed numeric `timings.json`
metrics retain per-phase elapsed time and ownership-check RPC counts/time even on
phase failure, without identifiers, view text, raw errors or driver payloads.
Simulator boot has a 180-second bound. Its first read-only ownership inventory query
has a separate 90-second allowance for cold CoreSimulator startup; subsequent
inventory queries retain their ordinary 30-second bound.

Successful output contains the reviewed plan, three fixed-shape JSON reports and a
receipt with source, app-tree, build-manifest, plan, case and installed-package
hashes, resolved tool versions, declared bounds, timings and cleanup/leak-scan
outcomes. The receipt and WDA status identify the fixed
`ephemeral-hosted-standard-device-set` scope; neither includes the foreign-device
baseline or owned device identifiers. Reports omit raw exceptions, response bodies, UI hierarchies, screenshots, recordings and device
logs. Temporary driver text stays bounded in memory and is checked for generated
credential variants. Uncertain teardown fails the proof and retains private recovery
metadata; failure output must be reviewed before sharing.

The workflow uploads selected sanitized evidence after success. Credential-backed
proof failures retain only
fixed stages/error codes and native reports that pass schema validation again.
Compilation and credential-free WDA diagnostics may be retained only before an
application backend, broker, credential or application session exists. The WDA
diagnostic checks the compiled app against its manifest and seven public source
inputs; it opens a native automation session without signing in or exercising the
business workflow. On failure, its bounded `preauth-wda.log` can include Appium and
Xcode startup details. Only `status.json` and that log are uploaded; uncertain
cleanup recovery paths stay private. This readiness check does not establish that
the authenticated cases pass. The workflow does not upload
post-authentication driver logs, keychain homes or failure directories. Hashes bind reviewed inputs;
they do not authenticate arbitrary reports or establish assertion quality.

This experiment covers one synthetic app, installed runtime and Simulator type.
It does not establish physical-device or existing-app support, App Store builds,
push notifications, biometrics, camera permissions, offline synchronization,
purchases, WebViews, device fleets or independent agent-authoring reliability.
It adds no native MCP tool, dashboard or hosted Testlane service. Cancellation,
setup/teardown failures and other native frameworks need their own actual trials
before wider support claims. See the [mobile release criteria](../../docs/mobile-testing.md#release-gate).
