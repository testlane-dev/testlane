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
- Xcode 26.6 at the workflow's fixed developer directory, its iOS Simulator SDK
  and completed license/first-launch setup.
  The tools do not download Xcode or runtimes, accept licenses, or select a different
  developer directory.
- The installed, available `com.apple.CoreSimulator.SimRuntime.iOS-26-4` runtime and
  `com.apple.CoreSimulator.SimDeviceType.iPhone-17` device type. No available-device
  fallback is used.
- An existing CocoaPods executable and enough disk/memory for a Release native
  build, WebDriverAgent compilation and a new Simulator.
- A Node distribution that includes matching local C/C++ headers, its bundled
  npm/node-gyp, and the operating system's Python 3, Clang and Make. The installer
  refuses missing or mismatched local inputs; it does not download Node headers
  or substitute a builder from an arbitrary search path.

The optional tooling installer pins Appium 3.8.0, XCUITest 12.19.1 and WebDriverAgent
16.16.3 through its lockfile. It uses `npm ci --ignore-scripts` in a new explicit
output directory and leaves the default Appium installation alone. It then invokes
the already validated npm-bundled `node-gyp` directly with `rebuild` in the canonical
bundled `@appium/coresim@1.13.1` directory. No npm package selector or lifecycle
hook runs; lifecycle scripts remain disabled during dependency installation.
This forces a source build on both supported Mac architectures, including Intel: the locked archive
contains an ARM prebuild but no Intel binary. The exact reviewed addon, loader and
Node-addon API source trees are checked before and after the rebuild. The resulting
architecture-specific binary must load and return a numeric CoreSimulator
framework version before app building or Simulator allocation begins. This probe
does not create a device or establish native test acceptance.

The new marked tools directory holds installer configuration, npm/build caches and
temporary files. Install/rebuild use its private HOME; the read-only Xcode and
framework probes use the same canonical native account HOME as device startup,
with fixed Xcode/Node paths and private Appium/cache/temporary directories. No
ambient environment is forwarded. This does not redirect OS service state away
from the native account. Setup records private source, binary, runtime and toolchain hashes;
device startup rechecks them before allocation. These are observations that bind
this run, not independent provenance attestation or a reproducibility claim. A
failed or cancelled rebuild/probe retains incomplete setup and recovery metadata.
There is no automatic rebuild retry or lifecycle-script fallback. Device startup
does not install dependencies. No physical device, Apple developer account, signing
certificate, provisioning profile, Expo account or human test account is needed.

## Run the hosted proof

Use the repository's [iOS Simulator workflow](../../.github/workflows/ios-simulator-proof.yml).
It inspects prerequisites, runs the policy tests and builds the Simulator app without
Apple signing credentials. The installed-package proof then creates one owned
Simulator, prebuilds the pinned WebDriverAgent runner for that exact destination,
and installs and launches the unauthenticated app. Before generating credentials,
it uses the installed native driver to open one WebDriverAgent session, verify
`NATIVE_APP` and delete that session. It rechecks the prepared artifacts, then uses
the same owned Simulator for the authenticated cases. Final teardown removes the
Simulator. Ordinary
`npm run test:mobile` executes unit/control tests without starting a device.

Cold boot is a prerequisite observation, separate from test execution. One
absolute monotonic window of at most 600 seconds covers the owned boot command,
`simctl bootstatus -b` and the first fresh owned/foreign inventory and path
confirmation. The boot command keeps its 30-second cap; the first ownership
confirmation keeps a 90-second cap. Each receives only the time remaining in the
shared window. No step retries or renews the window. A printed completion message
is not success: `bootstatus` must exit zero and the complete fresh ownership
checks must succeed before WebDriverAgent or credentials are prepared.

This bounded cold-start policy is an experiment, not a validated cure for a live
`bootstatus` client or slow CoreSimulator services. Deadline and cancellation
checks are cooperative around filesystem work; a pending operation must settle
before failure returns. Retained command stop/close and independent cleanup may
take additional time, and uncertainty still preserves recovery rather than
passing. Failure at this bound blocks acceptance; it does not automatically
increase the window. Ordinary driver requests, visibility waits and the declared
90-second body, 15-second cleanup, 5-second settlement and 600-second worker
budgets are unchanged.

The hosted workflow also enables `--preauth-controls` in that same readiness
session. This optional diagnostic scrolls to eight fixed synthetic controls,
focuses the quantity input without typing, checks keyboard dismissal and restores
the session-status control. Failure blocks account and broker setup. Its
`preauth-controls.json` contains only fixed control IDs, step categories, completion
booleans and allowlisted error codes. Session-deletion acknowledgement does not
establish final device cleanup or replace the required business-case outcomes.

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
TESTLANE_IOS_PROOF_CI=1 npm run proof:ios -- --app "$proof_root/build/TestlaneIOSProof.app" --tools-root "$proof_root/tools" --output-dir "$GITHUB_WORKSPACE/output/ios-proof" --preauth-controls
```

For a separate credential-free diagnostic, run the command below instead of the
full proof. It creates and removes its own Simulator; it is not an additional
required device setup before the installed-package run:

```sh
TESTLANE_IOS_PROOF_CI=1 node scripts/ios-wda-preflight.mjs --app "$proof_root/build/TestlaneIOSProof.app" --tools-root "$proof_root/tools" --output-dir "$GITHUB_WORKSPACE/output/ios-wda-preflight"
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
control. When the keyboard is shown, the driver activates that configured control
once and observes that the keyboard disappears; it does not assume an iPhone number pad has a system Done key
or ignore a failed dismissal. This is part of the synthetic app's UI contract.

Setup compiles only the pinned WebDriverAgent project into the run's private
DerivedData, for the exact owned Simulator UUID. Compilation has a separate
600-second monotonic bound and requires actual process close with exit zero.
This is one bounded cold-compile experiment, not a validated performance fix;
failure blocks setup without retries or automatic budget increases. Retained
command stop, pending diagnostics and independent cleanup must settle before
failure returns and may add time; uncertainty retains recovery state. The
controller verifies and hashes the generated Simulator runner, test bundle and
`.xctestrun` file, along with the measured project/package inputs. It checks those
bindings again before session creation and between proof phases. WDA session
creation uses `usePrebuiltWDA: true`; there is no external WDA endpoint or fallback
build, device or SDK selection. Successful compiler completion does not establish
that every Xcode background service exited. Interrupted or uncertain compilation
blocks authentication and retains recovery state when owned process settlement
cannot be confirmed.

The explicit tools installer applies one byte-bound compatibility change to
XCUITest 12.19.1's compiled WDA session-start path. It admits exactly one loopback
`POST /session` request with a 30-second transport limit, while the shared proxy,
ordinary commands and direct native routes retain five seconds. Concurrent or
additional requests are refused during that startup request. The original method
is restored before successful startup or a settled rejection returns; no public
timeout capability, retries, UI-idle change or business-budget change is added.
The installer refuses source drift or reapplication. Device setup and the prepared
artifact checks verify the patched bytes and the pinned proxy implementations;
the receipt records the original and patched SHA256 values. Existing unpatched
tools directories must be replaced through a fresh explicit installation.

This is a maintained local compatibility patch, not an upstream capability or
successful iOS acceptance. Its source is the
[published 12.19.1 archive](https://registry.npmjs.org/appium-xcuitest-driver/-/appium-xcuitest-driver-12.19.1.tgz)
and the immutable upstream
[WDA session-start implementation](https://github.com/appium/appium-xcuitest-driver/blob/71ab559399ef0a88a337cfe781af9e1a8ba4205b/lib/commands/wda/startup.ts#L415-L423).
An aborted HTTP request does not prove that XCTest stopped. Pinned Appium
cancellation can leave its proxy promise unresolved; the startup lease then stays
fenced and the proof requires independent owned-server and Simulator teardown.
If their stop cannot be confirmed, later phases and native credential deletion,
keychain disposal and consumer removal remain blocked, with recovery state retained.

Setup launches only the fixed proof bundle on the owned Simulator before the
application backend, broker or bootstrap credentials exist. WDA attaches to that
running app with forced relaunch disabled and one startup attempt. This separates
cold app startup from the five-second ordinary request budget; it does not test
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

Native device tools and Appium use the canonical OS-account home that owns the
standard CoreSimulator set, with no `CFFIXED_USER_HOME` override. Appium's home,
DerivedData, temporary directory and configured `XDG_CACHE_HOME` stay private to
the run. Only selected toolchain/environment settings are inherited; unrelated
credentials and Node injection settings are not forwarded. The parent controller
and broker environment and explicit credential-store selection are unchanged.

Apple frameworks may use OS-managed Library caches, preferences and service logs
outside the private root. `XDG_CACHE_HOME` does not redirect every Apple cache.
Cleanup verifies the owned Simulator, retained processes, listeners and private
resources; it does not delete or certify all OS-managed home or service state.
This boundary requires the ephemeral hosted runner above and does not isolate
trusted tools from the same OS user.

## Evidence and current limits

Each compound role-loading and native UI case has a 90-second body budget,
15 seconds for cleanup and up to 5 seconds to settle after abort. The installed
shared `budgets.mjs` declares these bounds and the 600-second outer worker ceiling;
cases run once without retries. Appium/WebDriverAgent session creation has
its own 240-second ceiling within that outer limit. After receiving a valid session
ID, setup performs one live ownership check within the remaining startup budget,
capped at 20 seconds. Each ordinary driver request shares one five-second ceiling
between its live ownership check and HTTP operation. An unconfirmed setup check prevents subsequent native actions;
session deletion is reported unknown if the prior operation cannot be confirmed
settled, and the controller fences it through owned-device teardown.
The separate 600-second WDA
compile happens during device setup, before the worker and credentials exist;
it does not extend session or business-case deadlines. Fixed numeric `timings.json`
metrics retain per-phase elapsed time and ownership-check RPC counts/time even on
phase failure, without identifiers, view text, raw errors or driver payloads.
Cold boot uses the shared 600-second window described above, including the
30-second boot-command cap and first fresh ownership confirmation capped at
90 seconds; subsequent inventory queries retain their ordinary 30-second bound.

Successful output contains the reviewed plan, three fixed-shape JSON reports and a
receipt with source, app-tree, build-manifest, plan, case and installed-package
hashes, resolved tool versions, declared bounds, timings and cleanup/leak-scan
outcomes. Its WDA preparation record contains the fixed build budget, compile
elapsed time, pinned WDA version and project/package/runner/`.xctestrun` hashes;
it omits local paths and device identifiers. `readiness.json` records only successful
session creation, native context and exact-session deletion through the installed
driver, plus setup time and fixed scope. It does not claim device teardown while
the Simulator is still in use. The final receipt establishes the separate cleanup
gates. The receipt, readiness record and standalone WDA status identify the fixed
`ephemeral-hosted-standard-device-set` scope; none includes the foreign-device
baseline or owned device identifiers. Reports omit raw exceptions, response bodies, UI hierarchies, screenshots, recordings and device
logs. Temporary driver text stays bounded in memory and is checked for generated
credential variants. Uncertain teardown fails the proof and retains private recovery
metadata; failure output must be reviewed before sharing.

Case failures keep their lifecycle diagnosis, such as `NATIVE_BODY_FAILED`, first.
They can add a fixed cause for the selected platform's own driver error class or
the shared UI-settlement error. Unknown thrown values, wrong-platform classes,
getters and proxies contribute no cause. The report never copies an exception's
message, stack or payload. UI polling propagates driver failures; a value that
does not settle has a separate fixed diagnosis, without replaying actions. The
eight- and ten-second polling windows remain subject to the surrounding driver
and case budgets; a single text read can involve several driver requests.

Repeated device inventory, listener and process-query responses remain bounded
transient inputs to the live validators. The cumulative diagnostic log omits their
raw payloads and records fixed command kinds, status and timing instead. This keeps
repeated ownership checks from filling the unchanged eight-MiB log cap; it does not
cache ownership decisions or omit response validation.

The workflow uploads selected sanitized evidence after success. Proof failures
retain fixed stages/error codes, any successful readiness record and native reports
that pass schema validation again. Bounded `preauth-device.log` is retained only
when setup fails before an application backend, broker, credential or application
session exists. The installed readiness session uses the same strict logging and
privacy capabilities as the workers.

The optional standalone WDA diagnostic checks the compiled app against its manifest
and seven public source inputs. It opens a native automation session without
signing in or exercising the business workflow. On failure, its bounded
`preauth-wda.log` can include Appium and Xcode startup details; review it before
sharing. Its private recovery paths are excluded from the fixed status. Neither
readiness check establishes that authenticated cases pass. The workflow does not upload
post-authentication driver logs, keychain homes or recovery directories. Hashes bind reviewed inputs;
they do not authenticate arbitrary reports or establish assertion quality.

The first prewarm invocation can sample its exact retained inventory-query or
fixed app-launch process if it remains pending after 15 seconds. Both commands share
one sample claim; an attempted sample cannot be repeated. Ordinary ownership checks,
worker RPCs and cleanup queries receive no sampling permission. Sampling lasts one
second, with a five-second helper bound, identity rechecks and a bounded pre-auth
capture. The helper must join before its command or cleanup completes. Permission
is revoked when the first prewarm settles, including ownership failure or
cancellation; later calls cannot sample. Inventory and launch retain their
30-second limits. The installed proof enables this setup-only sampler before
generating credentials while Appium logging stays at error level.
The optional standalone diagnostic separately enables verbose startup logging; it
never generates application credentials.

This experiment covers one synthetic app, installed runtime and Simulator type.
It does not establish physical-device or existing-app support, App Store builds,
push notifications, biometrics, camera permissions, offline synchronization,
purchases, WebViews, device fleets or independent agent-authoring reliability.
It adds no native MCP tool, dashboard or hosted Testlane service. Cancellation,
setup/teardown failures and other native frameworks need their own actual trials
before wider support claims. See the [mobile release criteria](../../docs/mobile-testing.md#release-gate).
